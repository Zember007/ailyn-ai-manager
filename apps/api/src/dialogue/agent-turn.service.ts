import { Injectable, Logger } from "@nestjs/common";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig } from "@ailyn/config";
import type { ApplicationFacts } from "@ailyn/business-rules";
import type { NormalizedMoneyValue } from "../ai/ai-provider.interface.js";
import { RouterAiClient } from "../ai/router-ai/router-ai.client.js";
import type { InboundAttachment } from "../channels/channel.interface.js";
import { BackendLogsService } from "../logs/backend-logs.service.js";
import { attachmentFactsFromResult, effectiveFactsForTurn } from "./agent-turn-reconciliation.js";
import { selectRelevantDocumentation } from "./documentation-retrieval.js";
import { agentTurnResultSchema, type AgentTurnResult } from "./agent-turn.contracts.js";
import { moneyNormalizationSchema } from "./pipeline.contracts.js";
import type { Stage1Message } from "./stage1-store.service.js";

const PROMPT_VERSION = "single-agent-v3";
const NEUTRAL_REPLY = "Извините, сейчас не удалось обработать сообщение. Пожалуйста, напишите ещё раз или обратитесь к сотрудникам компании.";
const MAX_MODEL_ATTEMPTS = 3;
const MAX_LOG_VALUE_LENGTH = 4000;
const unnormalizedMoneyFactKeys = new Set(["vehicleValue", "requestedAmount", "vehicleValueSourceCurrency", "requestedAmountSourceCurrency"]);
const NORMALIZER_PROMPT = `Вы — технический JSON-нормализатор ответа менеджера.
Верните только один валидный JSON строго по переданной схеме AgentTurnResult.
Исправляйте только формат, типы, допустимые имена полей и лишние поля; не меняйте смысл reply и не придумывайте факты.
Не помещайте preliminaryLimit в leadCardPatch. targetEvent означает только уже достигнутое событие: documents после хотя бы одного вложения на этапе документов, полного комплекта или declinedDocuments=true; visit только после даты и времени; при обычном запросе документов используйте null.
Не запрашивайте уже полученные документы. Если исходный ответ нельзя безопасно восстановить, верните наиболее консервативный валидный результат без выдуманных фактов.`;

type AgentTurnInput = { messages: Stage1Message[]; facts: ApplicationFacts; settings: object; text?: string; attachments: InboundAttachment[]; currencyConversions?: unknown[]; conversationId?: string; signal?: AbortSignal };

@Injectable()
export class AgentTurnService {
  private readonly config = loadAppConfig();
  private readonly logger = new Logger(AgentTurnService.name);

  constructor(private readonly client: RouterAiClient, private readonly logs?: BackendLogsService) {}

  async normalizeMoney(input: { text?: string; facts: ApplicationFacts; messages: Stage1Message[]; signal?: AbortSignal }): Promise<NormalizedMoneyValue[]> {
    if (!this.client.isConfigured() || !input.text?.trim()) return [];
    try {
      const response = await this.client.createChatCompletion({
        model: this.config.routerAiNormalizerModel ?? this.config.routerAiTextModel ?? "routerai-text-model-not-configured",
        temperature: 0,
        max_tokens: 300,
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: loadPrompt("money-normalization.system.md") },
          // Keep normalization turn-local so old prices cannot be extracted
          // again. The one preceding assistant message is retained solely to
          // resolve a short answer to its immediately preceding offer.
          { role: "user", content: JSON.stringify({ currentMessage: input.text, lastAssistantMessage: [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "" }) }
        ]
      }, { timeoutMs: this.config.routerAiTimeoutMs, signal: input.signal });
      const parsed = moneyNormalizationSchema.safeParse(JSON.parse(response.choices?.[0]?.message?.content ?? "{}"));
      if (!parsed.success) return [];
      return parsed.data.values.map((value) => value.currency !== "KGS" && !explicitlyMentionsCurrency(input.text, value.currency)
        ? { ...value, currency: "KGS" as const }
        : value);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      this.logger.warn(`Money normalization unavailable: ${formatError(error)}`);
      return [];
    }
  }

  async run(input: AgentTurnInput): Promise<{ result?: AgentTurnResult; reply: string; model: string; promptVersion: string; error?: string }> {
    if (!this.client.isConfigured()) {
      await this.logFallback(input, "routerai_not_configured", []);
      return { reply: NEUTRAL_REPLY, model: "unconfigured", promptVersion: PROMPT_VERSION, error: "routerai_not_configured" };
    }
    const systemPrompt = loadPrompt("agent.system.md");
    const request = {
      // The configured production model (openai/gpt-5.4-mini) can return an
      // empty object for json_schema. JSON mode plus the strict Zod boundary
      // is compatible and lets normal short replies succeed on the first call.
      model: this.config.routerAiTextModel ?? "routerai-text-model-not-configured", temperature: 0.2, max_tokens: 1600, reasoning: { enabled: false }, response_format: { type: "json_object" as const }
    };
    let lastError = "unknown_model_error";
    let lastRawAgentResponse: string | undefined;
    let retryWithoutImages = false;
    const attempts: Array<{ attempt: number; error: string; agentResponse?: string }> = [];
    for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt += 1) {
      let agentResponse: string | undefined;
      try {
        throwIfAborted(input.signal);
        const retryInstruction = attempt > 1
          ? "\n\nПОВТОРНАЯ ПОПЫТКА: предыдущий ответ не прошёл техническую проверку формата. Верните новый, полностью валидный JSON строго по заданной схеме. Не повторяйте техническое извинение: ответьте клиенту по существу и сохраните только допустимые поля карточки."
          : "";
        const userMessage = { role: "user" as const, content: buildMessage(input, !retryWithoutImages) };
        const attemptRequest = {
          ...request,
          messages: [{ role: "system" as const, content: retryInstruction ? `${systemPrompt}${retryInstruction}` : systemPrompt }, userMessage]
        };
        const response = await this.client.createChatCompletion(attemptRequest, { timeoutMs: this.config.routerAiTimeoutMs, signal: input.signal });
        const rawAgentResponse = response.choices?.[0]?.message?.content;
        lastRawAgentResponse = typeof rawAgentResponse === "string" ? rawAgentResponse : undefined;
        agentResponse = truncateLogValue(rawAgentResponse);
        const payload = normalizeAgentPayload(parseAgentJson(typeof rawAgentResponse === "string" ? rawAgentResponse : undefined), input.facts);
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
        if (input.signal?.aborted) throw error;
        lastError = error instanceof Error ? error.message : String(error);
        attempts.push({ attempt, error: truncateLogValue(lastError), ...(agentResponse ? { agentResponse } : {}) });
        if (isFetchFailure(error) && input.attachments.some((attachment) => Boolean(attachment.contentBase64))) retryWithoutImages = true;
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
    if (input.attachments.length > 0) {
      const recovered = localAttachmentRecovery(input);
      this.logger.warn(`Single-agent attachment recovery activated after ${MAX_MODEL_ATTEMPTS} attempts: ${lastError}`);
      await this.logs?.warn("dialogue.single-agent.attachment-recovery", "Attachments accepted without AI recognition", {
        conversationId: input.conversationId,
        metadata: { error: truncateLogValue(lastError), attachmentCount: input.attachments.length, attempts }
      });
      return { result: recovered, reply: recovered.reply, model: "local-attachment-recovery", promptVersion: `${PROMPT_VERSION}-attachment-recovery`, error: lastError };
    }
    this.logger.warn(`Single-agent fallback activated after ${MAX_MODEL_ATTEMPTS} attempts: ${lastError}`);
    await this.logFallback(input, lastError, attempts);
    return { reply: NEUTRAL_REPLY, model: this.config.routerAiTextModel ?? "routerai", promptVersion: PROMPT_VERSION, error: lastError };
  }

  private async normalizeFailedResponse(input: AgentTurnInput, rawResponse: string, reason: string): Promise<{ result: AgentTurnResult; model: string } | undefined> {
    const model = this.config.routerAiNormalizerModel ?? this.config.routerAiEvalModel ?? "openai/gpt-4o-mini";
    try {
      const response = await this.client.createChatCompletion({
        model,
        temperature: 0,
        max_tokens: 2200,
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: NORMALIZER_PROMPT },
          { role: "user", content: JSON.stringify({
            schema: "AgentTurnResult from the main agent prompt",
            error: truncateLogValue(reason),
            rawAgentResponse: rawResponse.slice(0, 16000),
            currentMessage: input.text ?? "",
            currentFacts: input.facts,
            history: input.messages.slice(-8).map(({ author, body, createdAt }) => ({ author, text: body, createdAt })),
            attachments: input.attachments.map(({ id, fileName, mimeType, textContent, metadata }) => ({ id, fileName, mimeType, textContent, metadata }))
          }) }
        ]
      }, { timeoutMs: this.config.routerAiTimeoutMs, signal: input.signal });
      const content = response.choices?.[0]?.message?.content;
      const payload = normalizeAgentPayload(parseAgentJson(typeof content === "string" ? content : undefined), input.facts);
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

function explicitlyMentionsCurrency(text: string | undefined, currency: Exclude<NormalizedMoneyValue["currency"], "KGS">): boolean {
  const source = text ?? "";
  const patterns = {
    USD: /(?:\busd\b|\$|доллар)/iu,
    EUR: /(?:\beur\b|€|евро)/iu,
    KZT: /(?:\bkzt\b|₸|тенге)/iu,
    RUB: /(?:\brub\b|₽|руб)/iu
  };
  return patterns[currency].test(source);
}

function isFetchFailure(error: unknown): boolean {
  return error instanceof Error && /fetch failed|network|econnreset|enotfound|timeout|aborted/i.test(`${error.name}: ${error.message}`);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Dialogue turn superseded by a newer client message", "AbortError");
  }
}

function localAttachmentRecovery(input: AgentTurnInput): AgentTurnResult {
  const reply = "Фотографии получили. Продолжаем оформление; если какой-то снимок окажется неразборчивым, я уточню нужную сторону.";
  return {
    reply,
    hasMoney: false,
    language: input.facts.language ?? "ru",
    intent: "attachments_received_pending_recognition",
    leadCardPatch: input.facts,
    cardSummary: "Вложения получены, автоматическое распознавание временно недоступно.",
    preliminaryLimit: null,
    dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "collect_documents" },
    targetEvent: null,
    managerUpdate: { kind: "none", changedFields: [] },
    attachments: input.attachments.map((attachment) => ({ attachmentId: attachment.id, type: "unknown", status: "received" }))
  };
}

function finalizeAgentPayload(parsed: AgentTurnResult, input: AgentTurnInput): AgentTurnResult & { reply: string } {
  // Monetary facts belong exclusively to the turn-local normalizer. The main
  // dialogue model reads the whole history, so without this boundary it can
  // mistake an amount mentioned by Ailyn (for example a notary fee) for the
  // client's requested loan amount.
  const modelPatch = withoutUnnormalizedMoney(parsed.leadCardPatch);
  const effectiveFacts = effectiveFactsForTurn({
    previous: input.facts,
    modelPatch,
    explicitFacts: {},
    currencyFacts: {},
    attachmentFacts: attachmentFactsFromResult(input.facts, parsed.attachments)
  });
  return {
    ...parsed,
    // Keep the cumulative card inventory, while all stage and reply decisions
    // remain owned by the organizing model.
    leadCardPatch: effectiveFacts,
    reply: separateQuestions(removeRepeatedGreeting(parsed.reply, input.messages))
  };
}

function withoutUnnormalizedMoney(patch: Partial<ApplicationFacts>): Partial<ApplicationFacts> {
  return Object.fromEntries(Object.entries(patch).filter(([key]) => !unnormalizedMoneyFactKeys.has(key))) as Partial<ApplicationFacts>;
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
    // Some gateways occasionally prepend a short explanation around an
    // otherwise valid JSON object. Recover that object before retrying so a
    // formatting-only defect does not become a user-visible system fallback.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed: unknown = JSON.parse(text.slice(start, end + 1));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        // Preserve the original parse error in the retry/fallback diagnostics.
      }
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
  // Keep the model's wording, but make a standalone question visually
  // distinct when it follows an explanation in the same paragraph.
  return reply.replace(/([.!?])\s+(?=[А-ЯЁA-Z][^.!?\n]{0,160}\?)/gu, "$1\n\n").trim();
}

function buildMessage(input: { messages: Stage1Message[]; facts: ApplicationFacts; settings: object; text?: string; attachments: InboundAttachment[]; currencyConversions?: unknown[] }, includeImages = true) {
  const settings = input.settings as Record<string, unknown>;
  const timezone = typeof settings.timezone === "string" ? settings.timezone : "Asia/Bishkek";
  const retrieval = selectRelevantDocumentation({ facts: input.facts, currentMessage: input.text, messages: input.messages });
  const now = currentDateTime(timezone);
  // Date arithmetic is not delegated to the language model. The calendar is
  // only attached when a visit is relevant, so ordinary turns stay compact.
  const visitCalendar = retrieval.stages.includes("visit") ? buildVisitCalendar(now) : undefined;
  const context = { now, timezone, history: input.messages.map(({ author, body, createdAt }) => ({ author, text: body, createdAt })), leadCard: input.facts, settings: input.settings, currentMessage: input.text ?? "", currencyConversions: input.currencyConversions ?? [], ...(visitCalendar ? { visitCalendar } : {}), commonKnowledge: retrieval.commonKnowledge, relevantStages: retrieval.stages, stageInstructions: retrieval.stageInstructions, knowledge: retrieval.knowledge };
  const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "high" } }> = [{ type: "text", text: JSON.stringify(context) }];
  for (const attachment of input.attachments) {
    parts.push({ type: "text", text: JSON.stringify({ attachment: { id: attachment.id, fileName: attachment.fileName, mimeType: attachment.mimeType, textContent: attachment.textContent, metadata: attachment.metadata } }) });
    if (includeImages && attachment.contentBase64 && /^image\/(jpeg|png|webp|gif)$/i.test(attachment.mimeType ?? "")) parts.push({ type: "image_url", image_url: { url: `data:${attachment.mimeType};base64,${attachment.contentBase64}`, detail: "high" } });
  }
  return parts;
}

function currentDateTime(timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:00`;
}

function buildVisitCalendar(now: string) {
  const [year, month, day] = now.slice(0, 10).split("-").map(Number);
  const start = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long", timeZone: "UTC" });
  return {
    officeHours: "ПН–ПТ 11:00–19:00; для оформления приехать не позднее 18:00",
    dates: Array.from({ length: 15 }, (_, offset) => {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + offset);
      const isoDate = date.toISOString().slice(0, 10);
      const dayOfWeek = date.getUTCDay();
      return { date: isoDate, weekday: weekday.format(date), working: dayOfWeek !== 0 && dayOfWeek !== 6 };
    })
  };
}

function loadPrompt(name: string) {
  const directory = dirname(fileURLToPath(import.meta.url));
  const promptDirectories = [
    resolve(directory, "../ai/prompts"),
    resolve(process.cwd(), "src/ai/prompts"),
    resolve(process.cwd(), "dist/apps/api/src/ai/prompts"),
    resolve(process.cwd(), "apps/api/src/ai/prompts"),
    resolve(process.cwd(), "apps/api/dist/apps/api/src/ai/prompts")
  ];
  const candidates = promptDirectories.map((promptDirectory) => resolve(promptDirectory, name));
  const path = candidates.find(existsSync);
  if (!path) throw new Error(`Prompt file not found: ${name}. Checked: ${promptDirectories.join(", ")}`);
  return readFileSync(path, "utf8");
}

/** Translate model-friendly labels into the persisted Stage 1 enum before Zod
 * validates the final boundary. Unknown values stay unchanged and are rejected. */
const permittedLeadCardKeys = new Set(Object.keys(agentTurnResultSchema.shape.leadCardPatch.shape));

function normalizeAgentPayload(payload: Record<string, unknown>, currentFacts: ApplicationFacts = {}): Record<string, unknown> {
  const leadCardPatch = payload.leadCardPatch;
  if (leadCardPatch && typeof leadCardPatch === "object" && !Array.isArray(leadCardPatch)) {
    const carriedFacts = Object.fromEntries(Object.entries(currentFacts).filter(([key, value]) => permittedLeadCardKeys.has(key) && value !== undefined));
    const rawPatch = leadCardPatch as Record<string, unknown>;
    // The model sometimes mirrors derived/top-level fields (for example
    // preliminaryLimit) inside leadCardPatch. They are not application facts,
    // so drop them instead of rejecting an otherwise usable turn.
    const patch = {
      ...carriedFacts,
      ...Object.fromEntries(Object.entries(rawPatch).filter(([key]) => permittedLeadCardKeys.has(key) || key in leadCardAliases))
    };
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
      if (typeof patch[key] === "string" && ["true", "false"].includes(patch[key].trim().toLowerCase())) {
        patch[key] = patch[key].trim().toLowerCase() === "true";
      }
    }
    if (typeof patch.familyStatus === "string") {
      const normalizedStatus = familyStatusAliases[patch.familyStatus.trim().toLocaleLowerCase("ru-RU")];
      if (normalizedStatus) patch.familyStatus = normalizedStatus;
    }
    if (typeof patch.residenceRegion === "string") {
      const normalizedRegion = residenceRegionAliases[patch.residenceRegion.trim().toUpperCase()];
      if (normalizedRegion) patch.residenceRegion = normalizedRegion;
    }
    if (typeof patch.residenceCategory === "string" && ["UNKNOWN", "NONE", "NULL", ""].includes(patch.residenceCategory.trim().toUpperCase())) {
      delete patch.residenceCategory;
    } else if (typeof patch.residenceCategory === "string") {
      const normalizedCategory = residenceCategoryAliases[patch.residenceCategory.trim().toLocaleUpperCase("ru-RU")];
      if (normalizedCategory) patch.residenceCategory = normalizedCategory;
    }
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
  if (typeof payload.targetEvent === "string" && ["", "none", "null", "no"].includes(payload.targetEvent.trim().toLowerCase())) {
    payload.targetEvent = null;
  }
  return payload;
}

const stageAliases: Record<string, string> = {
  new: "NEW", initial: "NEW", collecting_vehicle: "COLLECTING_VEHICLE", collect_vehicle: "COLLECTING_VEHICLE",
  collecting_value: "COLLECTING_VALUE", collect_value: "COLLECTING_VALUE", collecting_amount: "COLLECTING_AMOUNT", collect_amount: "COLLECTING_AMOUNT",
  collecting_residence: "COLLECTING_RESIDENCE", collect_residence: "COLLECTING_RESIDENCE", eligibility_check: "ELIGIBILITY_CHECK",
  collecting_documents: "COLLECTING_DOCUMENTS", collect_documents: "COLLECTING_DOCUMENTS", collecting_family_status: "COLLECTING_FAMILY_STATUS",
  checking_guarantor: "CHECKING_GUARANTOR", check_guarantor: "CHECKING_GUARANTOR", scheduling_visit: "SCHEDULING_VISIT",
  target_reached_documents: "TARGET_REACHED_DOCUMENTS", target_reached_visit: "TARGET_REACHED_VISIT", refused: "REFUSED", paused: "PAUSED",
  existing_contract_redirect: "EXISTING_CONTRACT_REDIRECT"
};

const leadCardAliases: Record<string, string> = {
  carBrand: "vehicleMake", carMake: "vehicleMake", carModel: "vehicleModel", carYear: "vehicleYear", carValue: "vehicleValue",
  loanAmount: "requestedAmount", neededAmount: "requestedAmount", requestedLoanAmount: "requestedAmount",
  clientName: "fullName", customerName: "fullName", clientPhone: "phone", customerPhone: "phone",
  residence: "residenceRegion", program: "requestedProgram", visitDatetime: "visitDate",
  maritalStatus: "familyStatus", marriageStatus: "familyStatus", family_status: "familyStatus",
  appointmentDate: "visitDate", appointmentTime: "visitTime", scheduledDate: "visitDate", scheduledTime: "visitTime",
  visit_date: "visitDate", visit_time: "visitTime"
};

const residenceRegionAliases: Record<string, string> = {
  BISHKEK: "Бишкек",
  CHUY: "Чуйская область",
  OTHER_KG: "Другой регион Кыргызстана",
  FOREIGN: "Другая страна"
};

const residenceCategoryAliases: Record<string, string> = {
  BISHKEK: "BISHKEK_CHUY", "БИШКЕК": "BISHKEK_CHUY",
  CHUY: "BISHKEK_CHUY", CHUI: "BISHKEK_CHUY", "ЧУЙ": "BISHKEK_CHUY", "ЧУЙСКАЯ ОБЛАСТЬ": "BISHKEK_CHUY", BISHKEK_CHUY: "BISHKEK_CHUY",
  OTHER_KG: "OTHER_KG", "ДРУГОЙ РЕГИОН КЫРГЫЗСТАНА": "OTHER_KG",
  FOREIGN: "FOREIGN", "ДРУГАЯ СТРАНА": "FOREIGN"
};

const familyStatusAliases: Record<string, string> = {
  married: "married", "в браке": "married", женат: "married", замужем: "married",
  single: "single", "не женат": "single", "не замужем": "single", "не в браке": "single",
  divorced: "divorced", divorce: "divorced", "в разводе": "divorced", разведен: "divorced", разведён: "divorced", разведена: "divorced"
};

const numericLeadCardKeys = new Set(["vehicleYear", "reportedInvalidVehicleYear", "vehicleValue", "requestedAmount"]);
const booleanLeadCardKeys = new Set([
  "residenceNeedsClarification", "ownerChanged", "plateChanged", "ownerIsLegalEntity", "borrowerIsLegalEntity", "vehicleInCredit", "vehiclePledged", "vehicleArrested", "registrationRestricted", "refinancingRequested", "buyoutRequested", "accidentNotDrivable", "foreignTravelQuestion", "existingContractQuestion", "existingContractPaymentMessage", "borrowerIsOwner", "ownerCanVisit", "vehicleBoughtDuringMarriage", "spouseConsentReady", "spouseAway", "guarantorAvailable", "visitRequested", "clientPaused", "clientClosed", "declinedDocuments", "declinedCarPhoto", "vehiclePurchasedDuringMarriage", "divorceCertificateReady", "visitConfirmationPending", "handedToManager", "onTheWay", "arrivedAtOffice"
]);

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
