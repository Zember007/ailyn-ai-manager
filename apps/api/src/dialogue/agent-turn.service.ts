import { Injectable, Logger } from "@nestjs/common";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig } from "@ailyn/config";
import type { ApplicationFacts } from "@ailyn/business-rules";
import { RouterAiClient } from "../ai/router-ai/router-ai.client.js";
import type { InboundAttachment } from "../channels/channel.interface.js";
import { BackendLogsService } from "../logs/backend-logs.service.js";
import { attachmentFactsFromResult, effectiveFactsForTurn, programComparison, reconcileAgentTurn, type ProgramComparison } from "./agent-turn-reconciliation.js";
import { generatedDocumentationChunks } from "./documentation-chunks.generated.js";
import { agentTurnResultSchema, type AgentTurnResult } from "./agent-turn.contracts.js";
import type { Stage1Message } from "./stage1-store.service.js";

const PROMPT_VERSION = "single-agent-v3";
const NEUTRAL_REPLY = "Извините, сейчас не удалось обработать сообщение. Пожалуйста, напишите ещё раз или обратитесь к сотрудникам компании.";
const MAX_MODEL_ATTEMPTS = 3;
const MAX_LOG_VALUE_LENGTH = 4000;
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
        const retryInstruction = attempt > 1
          ? "\n\nПОВТОРНАЯ ПОПЫТКА: предыдущий ответ не прошёл техническую проверку формата. Верните новый, полностью валидный JSON строго по заданной схеме. Не повторяйте техническое извинение: ответьте клиенту по существу и сохраните только допустимые поля карточки."
          : "";
        const userMessage = { role: "user" as const, content: buildMessage(input, !retryWithoutImages) };
        const attemptRequest = {
          ...request,
          messages: [{ role: "system" as const, content: retryInstruction ? `${systemPrompt}${retryInstruction}` : systemPrompt }, userMessage]
        };
        const response = await this.client.createChatCompletion(attemptRequest, { timeoutMs: this.config.routerAiTimeoutMs });
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
      }, { timeoutMs: this.config.routerAiTimeoutMs });
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

function isFetchFailure(error: unknown): boolean {
  return error instanceof Error && /fetch failed|network|econnreset|enotfound|timeout|aborted/i.test(`${error.name}: ${error.message}`);
}

function localAttachmentRecovery(input: AgentTurnInput): AgentTurnResult {
  const reconciliation = reconcileAgentTurn({
    effectiveFacts: input.facts,
    proposedState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "collect_documents" },
    proposedTargetEvent: null,
    proposedPreliminaryLimit: null,
    settings: input.settings
  });
  const reply = reconciliation.pendingRequirement?.fact === "residenceRegion"
    ? "Фотографии получили.\n\nПодскажите, пожалуйста, Ваша прописка: Бишкек, Чуйская область или другой регион Кыргызстана?"
    : reconciliation.pendingRequirement?.fact === "familyStatus"
      ? "Фотографии получили.\n\nПодскажите, пожалуйста, состоите ли Вы в браке?"
      : "Фотографии получили. Продолжаем оформление; если какой-то снимок окажется неразборчивым, я уточню нужную сторону.";
  return {
    reply,
    language: input.facts.language ?? "ru",
    intent: "attachments_received_pending_recognition",
    leadCardPatch: input.facts,
    cardSummary: "Вложения получены, автоматическое распознавание временно недоступно.",
    ...(reconciliation.preliminaryLimit === null ? {} : { preliminaryLimit: reconciliation.preliminaryLimit }),
    dialogueState: reconciliation.state,
    targetEvent: null,
    managerUpdate: { kind: "none", changedFields: [] },
    attachments: input.attachments.map((attachment) => ({ attachmentId: attachment.id, type: "unknown", status: "received" }))
  };
}

function finalizeAgentPayload(parsed: AgentTurnResult, input: AgentTurnInput): AgentTurnResult & { reply: string } {
  const { preliminaryLimit: _proposedPreliminaryLimit, ...payloadWithoutProposedLimit } = parsed;
  const effectiveFacts = effectiveFactsForTurn({
    previous: input.facts,
    modelPatch: parsed.leadCardPatch,
    explicitFacts: {},
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
  const semanticErrors = validateAgentTurnSemantics({ result: parsed, effectiveFacts, inputAttachments: input.attachments, errors: reconciliation.semanticErrors });
  // Stage, preliminary limit and target event are all deterministically
  // reconciled below. A stale model proposal must not turn into a fallback
  // after the safe state has already been calculated from effective facts.
  const criticalErrors = semanticErrors.filter((issue) => !issue.startsWith("invalid_stage_transition:") && issue !== "preliminary_limit_conflict" && !issue.startsWith("invalid_target_event:"));
  if (criticalErrors.length > 0) throw new Error(`Agent response semantic validation failed (${criticalErrors.join("; ")})`);
  const stageSafeReply = missingRequirementReply({
    modelReply: parsed.reply,
    requirement: reconciliation.pendingRequirement,
    facts: effectiveFacts
  });
  const financialReply = reconcileFinancialReply({
    modelReply: stageSafeReply,
    comparison: reconciliation.programComparison,
    stage: reconciliation.state.stage,
    needsDeterministicLimitRewrite: semanticErrors.includes("preliminary_limit_conflict")
  });
  const acknowledgedReply = financialReply;
  const alternativeProgram = reconciliation.programComparison?.requestedAmountExceedsSelectedLimit && reconciliation.programComparison.alternative?.coversRequestedAmount
    ? reconciliation.programComparison.alternative.program
    : undefined;
  const finalPreliminaryLimit = alternativeProgram ? reconciliation.programComparison?.alternative?.limit : reconciliation.preliminaryLimit;
  const persistedFacts = {
    ...effectiveFacts,
    ...(alternativeProgram ? { requestedProgram: alternativeProgram } : {})
  };
  return {
    ...payloadWithoutProposedLimit,
    // Persist the reconciled, cumulative inventory rather than the model's
    // partial patch. This makes uploads independent of their order and stops
    // a later ID upload from replacing previously accepted STS sides.
    leadCardPatch: persistedFacts,
    dialogueState: reconciliation.state,
    targetEvent: reconciliation.targetEvent,
    ...(finalPreliminaryLimit == null ? {} : { preliminaryLimit: finalPreliminaryLimit }),
    reply: separateQuestions(removeRepeatedGreeting(acknowledgedReply, input.messages))
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

function reconcileFinancialReply(input: { modelReply: string; comparison?: ProgramComparison; stage: AgentTurnResult["dialogueState"]["stage"]; needsDeterministicLimitRewrite: boolean }): string {
  const comparison = input.comparison;
  if (!comparison) return input.modelReply;
  const selectedProgram = programLabel(comparison.selectedProgram);
  const selectedLimit = formatSom(comparison.selectedLimit);
  const requestedAmount = comparison.requestedAmount === undefined ? undefined : formatSom(comparison.requestedAmount);

  if (comparison.requestedAmountExceedsSelectedLimit) {
    const alternative = comparison.alternative;
    if (alternative?.coversRequestedAmount) {
      return [
        `По программе ${selectedProgram} предварительно доступно до ${selectedLimit} сом.`,
        `Для нужной суммы подойдёт программа ${programLabel(alternative.program)} — автомобиль остаётся на охраняемой парковке. Предварительно по ней доступно до ${formatSom(alternative.limit)} сом.`,
        "Окончательная сумма определяется после осмотра автомобиля и проверки документов менеджером.",
        "Пожалуйста, отправьте фото:\n• ID / паспорта — с двух сторон;\n• свидетельства о регистрации ТС — с двух сторон."
      ].join("\n\n");
    }
    if (alternative?.program === "parking") {
      return [
        `По программе ${selectedProgram} предварительно доступно до ${selectedLimit} сом.`,
        `Запрошенная сумма — ${requestedAmount} сом, она превышает этот лимит.`,
        `По программе со стоянкой автомобиль остаётся на охраняемой парковке. Предварительно доступно до ${formatSom(alternative.limit)} сом.`,
        `Запрошенная сумма превышает и этот лимит. Подскажите, пожалуйста, сможете рассмотреть сумму в пределах ${formatSom(alternative.limit)} сом?`
      ].join("\n\n");
    }
    return [
      `По программе ${selectedProgram} предварительно доступно до ${selectedLimit} сом.`,
      `Запрошенная сумма — ${requestedAmount} сом, она превышает этот лимит.`,
      "Подскажите, пожалуйста, сможете рассмотреть сумму в пределах предварительного лимита?"
    ].join("\n\n");
  }

  if (!input.needsDeterministicLimitRewrite) return input.modelReply;
  const blocks = [`По программе ${selectedProgram} для Ваших данных предварительно доступно до ${selectedLimit} сом.`];
  if (requestedAmount) blocks.push(`Запрошенная сумма — ${requestedAmount} сом, она укладывается в этот предварительный лимит.`);
  blocks.push("Окончательное решение будет после осмотра автомобиля и проверки документов.");
  if (input.stage === "COLLECTING_DOCUMENTS") {
    blocks.push("Пожалуйста, отправьте фото:\n• ID — лицевая и обратная стороны;\n• СТС — лицевая и обратная стороны.");
  }
  return blocks.join("\n\n");
}

function missingRequirementReply(input: { modelReply: string; requirement?: { fact: string }; facts: ApplicationFacts }): string {
  const fact = input.requirement?.fact;
  if (!fact) return input.modelReply;
  if (fact === "residenceRegion") {
    return "Подскажите, пожалуйста, Ваша прописка:\n• Бишкек;\n• Чуйская область;\n• другой регион Кыргызстана.";
  }
  if (fact === "familyStatus") {
    return "Подскажите, пожалуйста, состоите ли Вы в браке?";
  }
  if (fact === "spouseConsentReady") {
    return "Сможете предоставить нотариально заверенное согласие супруга или супруги?";
  }
  if (fact === "guarantorAvailable") {
    return "Подскажите, пожалуйста, есть ли у Вас поручитель?";
  }
  if (fact === "id_front" || fact === "id_back" || fact === "vehicle_registration_front" || fact === "vehicle_registration_back") {
    const missing = [
      input.facts.documents?.id_front !== "received" ? "ID — лицевая сторона" : undefined,
      input.facts.documents?.id_back !== "received" ? "ID — обратная сторона" : undefined,
      input.facts.documents?.vehicle_registration_front !== "received" ? "СТС — лицевая сторона" : undefined,
      input.facts.documents?.vehicle_registration_back !== "received" ? "СТС — обратная сторона" : undefined
    ].filter((value): value is string => Boolean(value));
    return `Пожалуйста, отправьте фото:\n${missing.map((value) => `• ${value};`).join("\n")}`;
  }
  if (replyAddressesRequirement(input.modelReply, fact)) return input.modelReply;
  return input.modelReply;
}

function replyAddressesRequirement(reply: string, fact: string): boolean {
  const value = reply.toLocaleLowerCase("ru-RU");
  if (fact === "residenceRegion") return /подскажите.{0,50}(?:пропис|бишкек|чуй|регион)|(?:бишкек|чуй|другой регион).{0,100}\?/u.test(value);
  if (fact === "familyStatus") return /(?:состоите.{0,30}браке|семейн.{0,30}положен|женат|замужем|в разводе)/u.test(value);
  if (fact === "spouseConsentReady") return /(?:нотариальн|согласие).{0,80}(?:сможете|готов|предостав)|(?:сможете|готов|предостав).{0,80}(?:нотариальн|согласие)/u.test(value);
  if (fact === "guarantorAvailable") return /поручител/u.test(value);
  if (fact.startsWith("id_") || fact.startsWith("vehicle_registration_")) return /(?:паспорт|\bid\b|стс|свидетельств)/u.test(value);
  return true;
}

function programLabel(program: "without_storage" | "parking"): string {
  return program === "without_storage" ? "без изъятия" : "со стоянкой";
}

function formatSom(value: number): string {
  return new Intl.NumberFormat("ru-RU").format(value);
}

function buildMessage(input: { messages: Stage1Message[]; facts: ApplicationFacts; settings: object; text?: string; attachments: InboundAttachment[]; currencyConversions?: unknown[] }, includeImages = true) {
  const settings = input.settings as Record<string, unknown>;
  const timezone = typeof settings.timezone === "string" ? settings.timezone : "Asia/Bishkek";
  const context = { now: currentDateTime(timezone), timezone, history: input.messages.map(({ author, body, createdAt }) => ({ author, text: body, createdAt })), leadCard: input.facts, settings: input.settings, currentMessage: input.text ?? "", deterministicProgramComparison: programComparison(input.facts, input.settings), currencyConversions: input.currencyConversions ?? [], knowledge: generatedDocumentationChunks };
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
  BISHKEK_CHUY: "Чуйская область",
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

function validateAgentTurnSemantics(input: { result: AgentTurnResult; effectiveFacts: ApplicationFacts; inputAttachments: InboundAttachment[]; errors: string[] }): string[] {
  const errors = [...input.errors];
  for (const attachment of input.result.attachments) {
    if (!input.inputAttachments.some((item) => item.id === attachment.attachmentId)) errors.push(`attachment_state_conflict:${attachment.attachmentId}`);
  }
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
