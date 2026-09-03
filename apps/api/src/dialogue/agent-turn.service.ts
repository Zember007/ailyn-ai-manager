import { Injectable, Logger } from "@nestjs/common";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig } from "@ailyn/config";
import type { ApplicationFacts } from "@ailyn/business-rules";
import { RouterAiClient } from "../ai/router-ai/router-ai.client.js";
import type { InboundAttachment } from "../channels/channel.interface.js";
import { BackendLogsService } from "../logs/backend-logs.service.js";
import { resolveMoneyFacts } from "./money-normalization.js";
import { attachmentFactsFromResult, buildRuntimeGuardContext, contextualGuardFacts, effectiveFactsForTurn, reconcileAgentTurn } from "./agent-turn-reconciliation.js";
import { generatedDocumentationChunks } from "./documentation-chunks.generated.js";
import { agentTurnResultSchema, type AgentTurnResult } from "./agent-turn.contracts.js";
import type { Stage1Message } from "./stage1-store.service.js";

const PROMPT_VERSION = "single-agent-v4-program-assessment";
const NEUTRAL_REPLY = "Извините, сейчас не удалось обработать сообщение. Пожалуйста, напишите ещё раз или обратитесь к сотрудникам компании.";
const MAX_MODEL_ATTEMPTS = 3;
const MAX_LOG_VALUE_LENGTH = 4000;
const RUNTIME_GUARD_PROMPT = `ДЕТЕРМИНИРОВАННЫЙ КОНТЕКСТ И ПОРЯДОК ПРОВЕРОК
Поле runtimeGuardContext во входном контексте рассчитано TypeScript-кодом и имеет приоритет для вычисляемых лимитов, совместимости программы и обязательных незавершённых фактов. Не пересчитывайте personalLimit самостоятельно и не заменяйте его genericCap.
- genericCap — общий верхний предел продукта. Это НЕ ответ на вопрос «сколько дадут мне».
- personalLimit — предварительный персональный максимум по известным данным. Если он не null, именно его используйте в preliminaryLimit и в персональном ответе клиенту.
- requestFits показывает, помещается ли requestedAmount в программу.
- Если программа уже выбрана, но runtimeGuardContext.programAssessment.selected.status=does_not_fit, не продолжайте ветку поручителя/документов как будто программа подходит. Сначала объясните несовместимость и предложите допустимый вариант.
- До нейтрального предложения программ сверяйте requestedAmount с maximumPossibleLimit. Если сумма уже гарантированно не помещается в программу даже при неизвестной прописке, не представляйте эту программу как равноправно подходящую без предупреждения.
- missingRequirement — ближайший обязательный незавершённый факт для самостоятельного следующего шага агента. Не перескакивайте через него. При этом любые факты или документы, которые клиент сам прислал раньше очереди, всегда обработайте и сохраните.
- Перед самостоятельным запросом документов обязательно должны быть известны программа и прописка, а выбранная программа не должна иметь status=does_not_fit.
- Перед согласованием визита семейное положение и зависимые обязательные вопросы должны быть разрешены.
- Если клиент коротко отвечает «нет» после предложения прислать необязательные фото автомобиля, это отказ от этих фото: сохраните declinedCarPhoto=true, не просите их снова и переходите к следующему обязательному незавершённому факту.
Эти правила уточняют и при конфликте заменяют более раннюю формулировку о механическом выборе программы до проверки суммы.`;
const NORMALIZER_PROMPT = `Вы — технический JSON-нормализатор ответа менеджера.
Верните только один валидный JSON строго по переданной схеме AgentTurnResult.
Исправляйте только формат, типы, допустимые имена полей и лишние поля; не меняйте смысл reply и не придумывайте факты.
Не помещайте preliminaryLimit в leadCardPatch. targetEvent означает только уже достигнутое событие: documents только после получения всех четырёх сторон ID и СТС, visit только после даты и времени; при обычном запросе документов используйте null.
Не запрашивайте уже полученные документы. Если исходный ответ нельзя безопасно восстановить, верните наиболее консервативный валидный результат без выдуманных фактов.`;

type AgentTurnInput = { messages: Stage1Message[]; facts: ApplicationFacts; settings: object; text?: string; attachments: InboundAttachment[]; currencyConversions?: unknown[]; conversationId?: string };

@Injectable()
export class AgentTurnService {
  private readonly config = loadAppConfig();
  private readonly logger = new Logger(AgentTurnService.name);

  constructor(private readonly client: RouterAiClient, private readonly logs?: BackendLogsService) {}

  async run(input: AgentTurnInput): Promise<{ result?: AgentTurnResult; reply: string; model: string; promptVersion: string; error?: string }> {
    if (!this.client.isConfigured()) {
      await this.logFallback(input, "routerai_not_configured", []);
      return { reply: NEUTRAL_REPLY, model: "unconfigured", promptVersion: PROMPT_VERSION, error: "routerai_not_configured" };
    }
    const systemPrompt = `${loadPrompt("agent.system.md")}\n\n${RUNTIME_GUARD_PROMPT}`;
    const request = {
      model: this.config.routerAiTextModel ?? "routerai-text-model-not-configured", temperature: 0.2, max_tokens: 1600, reasoning: { enabled: false }, response_format: { type: "json_object" as const },
      messages: [{ role: "system" as const, content: systemPrompt }, { role: "user" as const, content: buildMessage(input) }]
    };
    let lastError = "unknown_model_error";
    let lastRawAgentResponse: string | undefined;
    const attempts: Array<{ attempt: number; error: string; agentResponse?: string }> = [];
    for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt += 1) {
      let agentResponse: string | undefined;
      try {
        const retryInstruction = attempt > 1
          ? `\n\nПОВТОРНАЯ ПОПЫТКА: предыдущий ответ не прошёл проверку. Причина: ${truncateLogValue(lastError)}. Верните новый полный AgentTurnResult. Для preliminary_limit_conflict используйте expected из причины и personalLimit из runtimeGuardContext, а не genericCap. Для stage_missing_required_fact спросите указанный missing fact вместо перехода дальше. Не повторяйте техническое извинение.`
          : "";
        const attemptRequest = retryInstruction
          ? { ...request, messages: [{ role: "system" as const, content: `${systemPrompt}${retryInstruction}` }, request.messages[1]] }
          : request;
        const response = await this.client.createChatCompletion(attemptRequest, { timeoutMs: this.config.routerAiTimeoutMs });
        const rawAgentResponse = response.choices?.[0]?.message?.content;
        lastRawAgentResponse = typeof rawAgentResponse === "string" ? rawAgentResponse : undefined;
        agentResponse = truncateLogValue(rawAgentResponse);
        const payload = normalizeAgentPayload(parseAgentJson(typeof rawAgentResponse === "string" ? rawAgentResponse : undefined), input.text, input.facts, input.messages);
        const parsed = agentTurnResultSchema.safeParse(payload);
        if (!parsed.success) {
          const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
          const state = payload.dialogueState && typeof payload.dialogueState === "object"
            ? (payload.dialogueState as Record<string, unknown>).stage
            : undefined;
          throw new Error(`Agent response does not match AgentTurnResult (${issues}; stage=${JSON.stringify(state)}; targetEvent=${JSON.stringify(payload.targetEvent)})`);
        }
        const result = finalizeAgentPayload(parsed.data, input);
        return { result, reply: result.reply, model: response.model ?? this.config.routerAiTextModel ?? "routerai", promptVersion: PROMPT_VERSION };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        attempts.push({ attempt, error: truncateLogValue(lastError), ...(agentResponse ? { agentResponse } : {}) });
        if (attempt < MAX_MODEL_ATTEMPTS) this.logger.warn(`Single-agent attempt ${attempt}/${MAX_MODEL_ATTEMPTS} failed; retrying: ${lastError}`);
      }
    }
    if (lastRawAgentResponse) {
      const repaired = await this.normalizeFailedResponse(input, lastRawAgentResponse, lastError);
      if (repaired) {
        this.logger.warn(`Cheap JSON normalizer repaired the agent response after ${MAX_MODEL_ATTEMPTS} attempts (model=${repaired.model})`);
        return { result: repaired.result, reply: repaired.result.reply, model: repaired.model, promptVersion: `${PROMPT_VERSION}-normalizer` };
      }
    }
    this.logger.warn(`Single-agent fallback activated after ${MAX_MODEL_ATTEMPTS} attempts: ${lastError}`);
    await this.logFallback(input, lastError, attempts);
    return { reply: NEUTRAL_REPLY, model: this.config.routerAiTextModel ?? "routerai", promptVersion: PROMPT_VERSION, error: lastError };
  }

  private async normalizeFailedResponse(input: AgentTurnInput, rawResponse: string, reason: string): Promise<{ result: AgentTurnResult; model: string } | undefined> {
    const model = this.config.routerAiNormalizerModel ?? this.config.routerAiEvalModel ?? "openai/gpt-4o-mini";
    try {
      const interpreted = interpretCurrentTurn({ text: input.text, facts: input.facts, messages: input.messages });
      const preModelFacts = { ...input.facts, ...interpreted.facts, ...contextualGuardFacts({ text: input.text, messages: input.messages }) };
      const response = await this.client.createChatCompletion({
        model,
        temperature: 0,
        max_tokens: 2200,
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${NORMALIZER_PROMPT}\n${RUNTIME_GUARD_PROMPT}` },
          { role: "user", content: JSON.stringify({
            schema: "AgentTurnResult from the main agent prompt",
            error: truncateLogValue(reason),
            runtimeGuardContext: buildRuntimeGuardContext(preModelFacts, input.settings),
            rawAgentResponse: rawResponse.slice(0, 16000),
            currentMessage: input.text ?? "",
            currentFacts: input.facts,
            history: input.messages.slice(-8).map(({ author, body, createdAt }) => ({ author, text: body, createdAt })),
            attachments: input.attachments.map(({ id, fileName, mimeType, textContent, metadata }) => ({ id, fileName, mimeType, textContent, metadata }))
          }) }
        ]
      }, { timeoutMs: this.config.routerAiTimeoutMs });
      const content = response.choices?.[0]?.message?.content;
      const payload = normalizeAgentPayload(parseAgentJson(typeof content === "string" ? content : undefined), input.text, input.facts, input.messages);
      const parsed = agentTurnResultSchema.safeParse(payload);
      if (!parsed.success) return undefined;
      return { result: finalizeAgentPayload(parsed.data, input), model: response.model ?? model };
    } catch (error) {
      this.logger.warn(`Cheap JSON normalizer failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private async logFallback(input: { text?: string; attachments: InboundAttachment[]; conversationId?: string }, error: string, attempts: Array<{ attempt: number; error: string; agentResponse?: string }>): Promise<void> {
    await this.logs?.warn("dialogue.single-agent.fallback", "Agent fallback reply sent", {
      conversationId: input.conversationId,
      metadata: {
        fallbackReply: NEUTRAL_REPLY,
        error: truncateLogValue(error),
        attempts,
        inputText: truncateLogValue(input.text ?? ""),
        attachmentCount: input.attachments.length
      }
    });
  }
}

function finalizeAgentPayload(parsed: AgentTurnResult, input: AgentTurnInput): AgentTurnResult & { reply: string } {
  const { preliminaryLimit: _proposedPreliminaryLimit, ...payloadWithoutProposedLimit } = parsed;
  const interpreted = interpretCurrentTurn({ text: input.text, facts: input.facts, messages: input.messages });
  const explicitFacts = { ...interpreted.facts, ...contextualGuardFacts({ text: input.text, messages: input.messages }) };
  const effectiveFacts = effectiveFactsForTurn({
    previous: input.facts,
    modelPatch: parsed.leadCardPatch,
    explicitFacts,
    currencyFacts: {},
    attachmentFacts: attachmentFactsFromResult(input.facts, parsed.attachments)
  });
  const reconciliation = reconcileAgentTurn({
    effectiveFacts,
    proposedState: parsed.dialogueState,
    proposedTargetEvent: parsed.targetEvent,
    proposedPreliminaryLimit: parsed.preliminaryLimit,
    settings: input.settings
  });
  const semanticErrors = validateAgentTurnSemantics({ result: parsed, effectiveFacts, explicitFacts, inputAttachments: input.attachments, errors: reconciliation.semanticErrors });
  if (semanticErrors.length > 0) throw new Error(`Agent response semantic validation failed (${semanticErrors.join("; ")})`);
  return {
    ...payloadWithoutProposedLimit,
    leadCardPatch: { ...parsed.leadCardPatch, ...explicitFacts },
    dialogueState: reconciliation.state,
    targetEvent: reconciliation.targetEvent,
    ...(reconciliation.preliminaryLimit === null ? {} : { preliminaryLimit: reconciliation.preliminaryLimit }),
    reply: separateQuestions(removeRepeatedGreeting(parsed.reply, input.messages))
  };
}

function truncateLogValue(value: unknown): string {
  if (typeof value === "string") return value.length > MAX_LOG_VALUE_LENGTH ? `${value.slice(0, MAX_LOG_VALUE_LENGTH)}…` : value;
  if (value === undefined || value === null) return "";
  try {
    return truncateLogValue(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function parseAgentJson(value: string | undefined): Record<string, unknown> {
  const text = (value ?? "{}").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (error) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed: unknown = JSON.parse(text.slice(start, end + 1));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {}
    }
    throw error;
  }
}

function removeRepeatedGreeting(reply: string, messages: Stage1Message[]): string {
  if (!messages.some((message) => message.author === "ai")) return reply;
  const withoutGreeting = reply
    .replace(/^\s*(?:здравствуйте|добрый\s+(?:день|вечер)|салам(?:атсызбы)?)[!,.]?\s*/iu, "")
    .replace(/^\s*(?:(?:меня\s+зовут|я)\s+айлин)[^.!?\n]*[.!?]?\s*/iu, "")
    .trim();
  return withoutGreeting || reply;
}

function separateQuestions(reply: string): string {
  return reply.replace(/([.!?])\s+(?=[А-ЯЁA-Z][^.!?\n]{0,160}\?)/gu, "$1\n\n").trim();
}

function buildMessage(input: { messages: Stage1Message[]; facts: ApplicationFacts; settings: object; text?: string; attachments: InboundAttachment[]; currencyConversions?: unknown[] }) {
  const settings = input.settings as Record<string, unknown>;
  const timezone = typeof settings.timezone === "string" ? settings.timezone : "Asia/Bishkek";
  const interpretedCurrentMessage = interpretCurrentTurn({ text: input.text, facts: input.facts, messages: input.messages });
  const explicitGuardFacts = contextualGuardFacts({ text: input.text, messages: input.messages });
  const preModelFacts = { ...input.facts, ...interpretedCurrentMessage.facts, ...explicitGuardFacts };
  const runtimeGuardContext = buildRuntimeGuardContext(preModelFacts, input.settings);
  const context = {
    now: currentDateTime(timezone),
    timezone,
    history: input.messages.map(({ author, body, createdAt }) => ({ author, text: body, createdAt })),
    leadCard: input.facts,
    settings: input.settings,
    currentMessage: input.text ?? "",
    interpretedCurrentMessage: { ...interpretedCurrentMessage, facts: { ...interpretedCurrentMessage.facts, ...explicitGuardFacts } },
    runtimeGuardContext,
    currencyConversions: input.currencyConversions ?? [],
    knowledge: selectKnowledge([input.text ?? "", JSON.stringify(preModelFacts), ...input.messages.slice(-8).map((message) => message.body)].join(" "))
  };
  const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "high" } }> = [{ type: "text", text: JSON.stringify(context) }];
  for (const attachment of input.attachments) {
    parts.push({ type: "text", text: JSON.stringify({ attachment: { id: attachment.id, fileName: attachment.fileName, mimeType: attachment.mimeType, textContent: attachment.textContent, metadata: attachment.metadata } }) });
    if (attachment.contentBase64 && /^image\/(jpeg|png|webp|gif)$/i.test(attachment.mimeType ?? "")) parts.push({ type: "image_url", image_url: { url: `data:${attachment.mimeType};base64,${attachment.contentBase64}`, detail: "high" } });
  }
  return parts;
}

function currentDateTime(timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:00`;
}

function selectKnowledge(query: string) {
  const terms = expandKnowledgeTerms(query);
  const scored = generatedDocumentationChunks.map((chunk, index) => {
    const keywordText = chunk.keywords.map(normalizeKnowledgeToken);
    const bodyText = normalizeKnowledgeToken(chunk.text);
    let score = 0;
    for (const term of terms) {
      if (keywordText.includes(term)) score += 8;
      else if (keywordText.some((keyword) => keyword.startsWith(term) || term.startsWith(keyword))) score += 4;
      else if (bodyText.includes(term)) score += 1;
    }
    if (/адрес|офис|2гис|google|телефон|whatsapp|молодой гвардии/.test(bodyText)) score += 100;
    return { chunk, index, score };
  });
  const selected = new Map<string, { key: string; text: string }>();
  const stage = inferKnowledgeStage(query);
  if (stage) {
    for (const item of scored.filter((candidate) => (candidate.chunk.stages as readonly string[]).includes(stage)).slice(0, 16)) selected.set(item.chunk.key, item.chunk);
  }
  for (const item of scored.slice(0, 8)) selected.set(item.chunk.key, item.chunk);
  for (const item of scored.filter((candidate) => candidate.score >= 100)) selected.set(item.chunk.key, item.chunk);
  const ranked = scored.filter((item) => item.score > 0).sort((left, right) => right.score - left.score || left.index - right.index).slice(0, 24);
  for (const item of ranked) {
    selected.set(item.chunk.key, item.chunk);
    for (const neighbor of [scored[item.index - 1], scored[item.index + 1]]) if (neighbor) selected.set(neighbor.chunk.key, neighbor.chunk);
  }
  return [...selected.values()].slice(0, 56);
}

function inferKnowledgeStage(query: string): "family_status" | "guarantor" | "residence" | "documents" | "vehicle_photos" | "visit" | undefined {
  const value = query.toLocaleLowerCase("ru-RU");
  if (/супруг|браке|развод|нотариальн|согласие/u.test(value)) return "family_status";
  if (/поручител/u.test(value)) return "guarantor";
  if (/пропис|регион|такмок|бишкек|чуй/u.test(value)) return "residence";
  if (/паспорт|id\b|стс|документ|свидетельств/u.test(value)) return "documents";
  if (/фото.*автомоб|фотограф.*автомоб/u.test(value)) return "vehicle_photos";
  if (/визит|офис|приех|дата|врем/u.test(value)) return "visit";
  return undefined;
}

function normalizeKnowledgeToken(value: string): string {
  return value.toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function expandKnowledgeTerms(query: string): Set<string> {
  const normalized = normalizeKnowledgeToken(query);
  const terms = new Set(normalized.split(/\s+/u).filter((term) => term.length >= 3));
  const aliases: Record<string, string[]> = {
    прописк: ["регион", "место", "прожив"], регион: ["пропис"], документ: ["паспорт", "ид", "стс", "техпаспорт"], паспорт: ["ид", "документ"],
    визит: ["дата", "время", "офис", "приех"], фото: ["фотограф", "изображен"], семейн: ["брака", "супруг", "нотариал"], сумма: ["займ", "лимит", "стоимость"], стоимость: ["цена", "оценка", "автомобил"]
  };
  for (const term of [...terms]) for (const alias of Object.entries(aliases).find(([key]) => term.startsWith(key))?.[1] ?? []) terms.add(alias);
  return terms;
}

function loadPrompt(name: string) {
  const directory = dirname(fileURLToPath(import.meta.url));
  const promptDirectories = [resolve(directory, "../ai/prompts"), resolve(process.cwd(), "src/ai/prompts"), resolve(process.cwd(), "dist/apps/api/src/ai/prompts"), resolve(process.cwd(), "apps/api/src/ai/prompts"), resolve(process.cwd(), "apps/api/dist/apps/api/src/ai/prompts")];
  const candidates = promptDirectories.map((promptDirectory) => resolve(promptDirectory, name));
  const path = candidates.find(existsSync);
  if (!path) throw new Error(`Prompt file not found: ${name}. Checked: ${promptDirectories.join(", ")}`);
  return readFileSync(path, "utf8");
}

const permittedLeadCardKeys = new Set(Object.keys(agentTurnResultSchema.shape.leadCardPatch.shape));

function normalizeAgentPayload(payload: Record<string, unknown>, inputText?: string, currentFacts: ApplicationFacts = {}, messages: Stage1Message[] = []): Record<string, unknown> {
  const leadCardPatch = payload.leadCardPatch;
  if (leadCardPatch && typeof leadCardPatch === "object" && !Array.isArray(leadCardPatch)) {
    const carriedFacts = Object.fromEntries(Object.entries(currentFacts).filter(([key, value]) => permittedLeadCardKeys.has(key) && value !== undefined));
    const rawPatch = leadCardPatch as Record<string, unknown>;
    const patch = { ...carriedFacts, ...Object.fromEntries(Object.entries(rawPatch).filter(([key]) => permittedLeadCardKeys.has(key) || key in leadCardAliases)) };
    for (const [alias, key] of Object.entries(leadCardAliases)) {
      if (patch[key] === undefined && patch[alias] !== undefined) patch[key] = patch[alias];
      delete patch[alias];
    }
    for (const key of numericLeadCardKeys) {
      if (typeof patch[key] === "string") {
        const value = Number(patch[key].replace(/[\s_]/g, "").replace(",", "."));
        if (Number.isFinite(value)) patch[key] = value;
      }
    }
    for (const key of booleanLeadCardKeys) {
      if (typeof patch[key] === "string" && ["true", "false"].includes(patch[key].trim().toLowerCase())) patch[key] = patch[key].trim().toLowerCase() === "true";
    }
    if (typeof patch.familyStatus === "string") {
      const normalizedStatus = familyStatusAliases[patch.familyStatus.trim().toLocaleLowerCase("ru-RU")];
      if (normalizedStatus) patch.familyStatus = normalizedStatus;
    }
    if (typeof patch.residenceRegion === "string") {
      const normalizedRegion = residenceRegionAliases[patch.residenceRegion.trim().toUpperCase()];
      if (normalizedRegion) patch.residenceRegion = normalizedRegion;
    }
    if (typeof patch.residenceCategory === "string" && ["UNKNOWN", "NONE", "NULL", ""].includes(patch.residenceCategory.trim().toUpperCase())) delete patch.residenceCategory;
    else if (typeof patch.residenceCategory === "string") {
      const normalizedCategory = residenceCategoryAliases[patch.residenceCategory.trim().toLocaleUpperCase("ru-RU")];
      if (normalizedCategory) patch.residenceCategory = normalizedCategory;
    }
    Object.assign(patch, interpretCurrentTurn({ text: inputText, facts: currentFacts, messages }).facts, contextualGuardFacts({ text: inputText, messages }));
    payload.leadCardPatch = patch;
  }
  const state = payload.dialogueState;
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const stage = (state as Record<string, unknown>).stage;
    if (typeof stage === "string") {
      const normalized = stageAliases[stage.trim().toLowerCase()];
      if (normalized) payload.dialogueState = { ...(state as Record<string, unknown>), stage: normalized };
    }
  }
  if (typeof payload.targetEvent === "string" && ["", "none", "null", "no"].includes(payload.targetEvent.trim().toLowerCase())) payload.targetEvent = null;
  return payload;
}

const stageAliases: Record<string, string> = {
  new: "NEW", initial: "NEW", collecting_vehicle: "COLLECTING_VEHICLE", collect_vehicle: "COLLECTING_VEHICLE", collecting_value: "COLLECTING_VALUE", collect_value: "COLLECTING_VALUE", collecting_amount: "COLLECTING_AMOUNT", collect_amount: "COLLECTING_AMOUNT", collecting_residence: "COLLECTING_RESIDENCE", collect_residence: "COLLECTING_RESIDENCE", eligibility_check: "ELIGIBILITY_CHECK", collecting_documents: "COLLECTING_DOCUMENTS", collect_documents: "COLLECTING_DOCUMENTS", collecting_family_status: "COLLECTING_FAMILY_STATUS", checking_guarantor: "CHECKING_GUARANTOR", check_guarantor: "CHECKING_GUARANTOR", scheduling_visit: "SCHEDULING_VISIT", target_reached_documents: "TARGET_REACHED_DOCUMENTS", target_reached_visit: "TARGET_REACHED_VISIT", refused: "REFUSED", paused: "PAUSED", existing_contract_redirect: "EXISTING_CONTRACT_REDIRECT"
};

const leadCardAliases: Record<string, string> = {
  carBrand: "vehicleMake", carMake: "vehicleMake", carModel: "vehicleModel", carYear: "vehicleYear", carValue: "vehicleValue", loanAmount: "requestedAmount", neededAmount: "requestedAmount", requestedLoanAmount: "requestedAmount", clientName: "fullName", customerName: "fullName", clientPhone: "phone", customerPhone: "phone", residence: "residenceRegion", program: "requestedProgram", visitDatetime: "visitDate", maritalStatus: "familyStatus", marriageStatus: "familyStatus", family_status: "familyStatus", appointmentDate: "visitDate", appointmentTime: "visitTime", scheduledDate: "visitDate", scheduledTime: "visitTime", visit_date: "visitDate", visit_time: "visitTime"
};

const residenceRegionAliases: Record<string, string> = { BISHKEK: "Бишкек", CHUY: "Чуйская область", OTHER_KG: "Другой регион Кыргызстана", FOREIGN: "Другая страна" };
const residenceCategoryAliases: Record<string, string> = { BISHKEK: "BISHKEK", "БИШКЕК": "BISHKEK", CHUY: "CHUY", CHUI: "CHUY", "ЧУЙ": "CHUY", "ЧУЙСКАЯ ОБЛАСТЬ": "CHUY", OTHER_KG: "OTHER_KG", "ДРУГОЙ РЕГИОН КЫРГЫЗСТАНА": "OTHER_KG", FOREIGN: "FOREIGN", "ДРУГАЯ СТРАНА": "FOREIGN" };
const familyStatusAliases: Record<string, string> = { married: "married", "в браке": "married", женат: "married", замужем: "married", single: "single", "не женат": "single", "не замужем": "single", "не в браке": "single", divorced: "divorced", divorce: "divorced", "в разводе": "divorced", разведен: "divorced", разведён: "divorced", разведена: "divorced" };
const numericLeadCardKeys = new Set(["vehicleYear", "reportedInvalidVehicleYear", "vehicleValue", "requestedAmount"]);
const booleanLeadCardKeys = new Set(["residenceNeedsClarification", "ownerChanged", "plateChanged", "ownerIsLegalEntity", "borrowerIsLegalEntity", "vehicleInCredit", "vehiclePledged", "vehicleArrested", "registrationRestricted", "refinancingRequested", "buyoutRequested", "accidentNotDrivable", "foreignTravelQuestion", "existingContractQuestion", "existingContractPaymentMessage", "borrowerIsOwner", "ownerCanVisit", "vehicleBoughtDuringMarriage", "spouseConsentReady", "spouseAway", "guarantorAvailable", "visitRequested", "clientPaused", "clientClosed", "declinedDocuments", "declinedCarPhoto", "vehiclePurchasedDuringMarriage", "divorceCertificateReady", "visitConfirmationPending", "handedToManager", "onTheWay", "arrivedAtOffice"]);

export function interpretCurrentTurn(input: { text?: string; facts: ApplicationFacts; messages: Stage1Message[] }): { facts: Partial<ApplicationFacts>; money: ReturnType<typeof resolveMoneyFacts> } {
  const text = input.text;
  if (!text) return { facts: {}, money: resolveMoneyFacts({ text: "", currentFacts: input.facts }) };
  const normalized = text.toLocaleLowerCase("ru-RU");
  const facts: Partial<ApplicationFacts> = { ...contextualGuardFacts({ text, messages: input.messages }) };
  if (/(?:в\s+разводе|развед[её]н(?:а)?|разв[её]дена)/u.test(normalized)) facts.familyStatus = "divorced";
  else if (/(?:не\s+женат|не\s+замужем|не\s+состою\s+в\s+браке)/u.test(normalized)) facts.familyStatus = "single";
  else if (/(?:в\s+браке|женат|замужем)/u.test(normalized)) facts.familyStatus = "married";
  if (/(?:авто(?:мобиль)?|машин).{0,30}(?:куплен|приобретен|приобретён).{0,30}в\s+браке|купил.{0,20}в\s+браке/u.test(normalized)) facts.vehicleBoughtDuringMarriage = true;
  if (/(?:купил|куплен|приобретен|приобретён).{0,30}после\s+развод|после\s+развод.{0,30}(?:купил|приобр)/u.test(normalized)) facts.vehicleBoughtDuringMarriage = false;
  if (/(?:не\s+буду|не\s+хочу|не\s+могу|отказываюсь)[^.!?]{0,50}(?:в\s+чат|чат(?:е|ик)|отправ|фото|документ)/u.test(normalized) && !facts.declinedCarPhoto) facts.declinedDocuments = true;
  const hypotheticalProgram = /(?:а\s+если|сколько|какой\s+процент|какая\s+ставка)/u.test(normalized);
  if (!hypotheticalProgram && /(?:давайте|буду|хочу|нужно|тогда)[^.!?]{0,30}(?:на\s+)?(?:стоянк|парковк)/u.test(normalized)) facts.requestedProgram = "parking";
  else if (!hypotheticalProgram && /(?:без\s+изъяти|оставить\s+(?:авто|машин))/u.test(normalized)) facts.requestedProgram = "without_storage";

  const unresolvedQuestion = lastUnresolvedQuestion(input.messages);
  if (unresolvedQuestion === "guarantor" && /^(?:да|ну\s+да|есть|имеется)$/u.test(normalized.trim())) facts.guarantorAvailable = true;
  if (unresolvedQuestion === "guarantor" && /^(?:нет|нету|не\s*т|не\s+имеется)$/u.test(normalized.trim())) facts.guarantorAvailable = false;
  if (unresolvedQuestion === "spouseConsent" && /^(?:да|есть|оформлено|готов(?:а)?|смогу)$/u.test(normalized.trim())) facts.spouseConsentReady = true;
  if (unresolvedQuestion === "spouseConsent" && /^(?:нет|нету|не\s*т|не\s+могу|пока\s+нет)$/u.test(normalized.trim())) facts.spouseConsentReady = false;
  if (/(?:поручител[ья]\s+(?:есть|имеется)|есть\s+поручител[ья])/u.test(normalized)) facts.guarantorAvailable = true;
  if (/(?:поручител[ья]\s+нет|нет\s+поручител[ья]|без\s+поручител[ья])/u.test(normalized)) facts.guarantorAvailable = false;

  const money = resolveMoneyFacts({ text, currentFacts: input.facts, pendingFacts: unresolvedQuestion === "requestedAmount" ? ["requestedAmount"] : unresolvedQuestion === "vehicleValue" ? ["vehicleValue"] : [] });
  if (money.requestedAmount !== undefined && (!money.requestedAmountCurrency || money.requestedAmountCurrency === "KGS")) facts.requestedAmount = money.requestedAmount;
  if (money.vehicleValue !== undefined && (!money.vehicleValueCurrency || money.vehicleValueCurrency === "KGS")) facts.vehicleValue = money.vehicleValue;

  const visit = parseVisit(normalized);
  if (visit) {
    facts.visitRequested = true;
    facts.visitDate = visit.date;
    if (visit.time) facts.visitTime = visit.time;
  }
  return { facts, money };
}

function lastUnresolvedQuestion(messages: Stage1Message[]): "guarantor" | "spouseConsent" | "requestedAmount" | "vehicleValue" | undefined {
  const prior = messages.filter((message) => message.author !== "client" || message.body.trim() === "");
  const lastAi = [...prior].reverse().find((message) => message.author === "ai")?.body.toLocaleLowerCase("ru-RU");
  if (!lastAi) return undefined;
  if (/(?:нотариальн|согласие).{0,80}(?:сможете|готов|предостав)|(?:сможете|готов[аы]?|предостав).{0,80}(?:нотариальн|согласие)/.test(lastAi)) return "spouseConsent";
  if (/поручител/.test(lastAi) && /(?:есть|имеется|сможет)/.test(lastAi)) return "guarantor";
  if (/(?:какая|какую|нужн).{0,50}(?:сумм|займ)/.test(lastAi)) return "requestedAmount";
  if (/(?:какая|ориентировочн).{0,50}(?:стоимост|цен)/.test(lastAi)) return "vehicleValue";
  return undefined;
}

function validateAgentTurnSemantics(input: { result: AgentTurnResult; effectiveFacts: ApplicationFacts; explicitFacts: Partial<ApplicationFacts>; inputAttachments: InboundAttachment[]; errors: string[] }): string[] {
  const errors = [...input.errors];
  for (const attachment of input.result.attachments) if (!input.inputAttachments.some((item) => item.id === attachment.attachmentId)) errors.push(`attachment_state_conflict:${attachment.attachmentId}`);
  for (const [key, value] of Object.entries(input.explicitFacts)) {
    if (value !== undefined && JSON.stringify(input.result.leadCardPatch[key as keyof ApplicationFacts]) !== JSON.stringify(value)) errors.push(`explicit_fact_lost:${key}`);
  }
  if (input.explicitFacts.requestedProgram === "parking" && /без\s+изъяти/u.test(input.result.reply.toLocaleLowerCase("ru-RU"))) errors.push("program_conflict");
  if (input.explicitFacts.requestedProgram === "without_storage" && /(?:на\s+)?стоянк|парковк/u.test(input.result.reply.toLocaleLowerCase("ru-RU"))) errors.push("program_conflict");
  const requested = documentRequestPatterns(input.result.reply);
  for (const document of requested) if (input.effectiveFacts.documents?.[document] === "received") errors.push(`reply_reasks_received_document:${document}`);
  return [...new Set(errors)];
}

function documentRequestPatterns(reply: string): Array<"id_front" | "id_back" | "vehicle_registration_front" | "vehicle_registration_back"> {
  const normalized = reply.toLocaleLowerCase("ru-RU");
  const requested: Array<"id_front" | "id_back" | "vehicle_registration_front" | "vehicle_registration_back"> = [];
  if (/(?:лицев[а-я]*\s+сторон[а-я]*\s+(?:id|паспорт)|(?:id|паспорт).{0,30}лицев)/u.test(normalized)) requested.push("id_front");
  if (/(?:обратн[а-я]*\s+сторон[а-я]*\s+(?:id|паспорт)|(?:id|паспорт).{0,30}обратн)/u.test(normalized)) requested.push("id_back");
  if (/(?:лицев[а-я]*\s+сторон[а-я]*\s+(?:стс|свидетельств)|(?:стс|свидетельств).{0,30}лицев)/u.test(normalized)) requested.push("vehicle_registration_front");
  if (/(?:обратн[а-я]*\s+сторон[а-я]*\s+(?:стс|свидетельств)|(?:стс|свидетельств).{0,30}обратн)/u.test(normalized)) requested.push("vehicle_registration_back");
  return requested;
}

function parseVisit(text: string): { date: string; time?: string } | undefined {
  const now = bishkekNow();
  const weekdays: Record<string, number> = { понедельник: 1, вторник: 2, среду: 3, среда: 3, четверг: 4, пятницу: 5, пятница: 5, субботу: 6, суббота: 6, воскресенье: 0 };
  const weekday = Object.entries(weekdays).find(([word]) => text.includes(word))?.[1];
  const time = text.match(/(?:в\s+)(\d{1,2})(?::(\d{2}))?/u);
  const parsedTime = parseVisitTime(time);
  let date: string | undefined;
  const explicitDate = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/u) ?? text.match(/(?:^|\s)(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?:$|\s|,)/u);
  if (explicitDate) {
    const year = explicitDate[3] ? Number(explicitDate[1].length === 4 ? explicitDate[1] : explicitDate[3].length === 2 ? `20${explicitDate[3]}` : explicitDate[3]) : now.year;
    const month = Number(explicitDate[2]);
    const day = Number(explicitDate[1].length === 4 ? explicitDate[3] : explicitDate[1]);
    date = validIsoDate(year, month, day);
  } else if (text.includes("завтра")) date = addDays(now, 1);
  else if (text.includes("сегодня")) date = isoDate(now.year, now.month, now.day);
  else if (weekday !== undefined) {
    let delta = (Number(weekday) - new Date(Date.UTC(now.year, now.month - 1, now.day)).getUTCDay() + 7) % 7;
    if (delta === 0 && parsedTime && (parsedTime.hour < now.hour || (parsedTime.hour === now.hour && parsedTime.minute <= now.minute))) delta = 7;
    date = addDays(now, delta);
  }
  return date ? { date, time: parsedTime?.value } : undefined;
}

function parseVisitTime(match: RegExpMatchArray | null): { hour: number; minute: number; value: string } | undefined {
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) return undefined;
  if (hour >= 1 && hour <= 8) hour += 12;
  if (hour > 23) return undefined;
  return { hour, minute, value: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

function bishkekNow() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bishkek", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value ?? "0");
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute") };
}

function addDays(date: { year: number; month: number; day: number }, amount: number): string {
  return new Date(Date.UTC(date.year, date.month - 1, date.day + amount)).toISOString().slice(0, 10);
}

function validIsoDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? isoDate(year, month, day) : undefined;
}

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
