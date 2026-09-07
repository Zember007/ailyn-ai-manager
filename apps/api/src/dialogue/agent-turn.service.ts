import { Injectable, Logger } from "@nestjs/common";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig } from "@ailyn/config";
import { resolveKyrgyzstanLocality, type ApplicationFacts, type StageCompletion } from "@ailyn/business-rules";
import type { NormalizedMoneyValue } from "../ai/ai-provider.interface.js";
import { RouterAiClient } from "../ai/router-ai/router-ai.client.js";
import type { InboundAttachment } from "../channels/channel.interface.js";
import { BackendLogsService } from "../logs/backend-logs.service.js";
import { attachmentFactsFromResult, deriveStageCompletion, effectiveFactsForTurn } from "./agent-turn-reconciliation.js";
import { allApprovedKnowledge, selectRelevantDocumentation } from "./documentation-retrieval.js";
import { agentTurnResultSchema, knowledgeAnswerSchema, type AgentTurnResult } from "./agent-turn.contracts.js";
import { moneyNormalizationSchema } from "./pipeline.contracts.js";
import { calculateLoanPricing, type LoanPricing, type LoanPricingSettings } from "./loan-pricing.js";
import { formatSomMoney, resolveMoneyFacts, roundSomAmount } from "./money-normalization.js";
import type { Stage1Message } from "./stage1-store.service.js";

const PROMPT_VERSION = "single-agent-v3";
const NEUTRAL_REPLY = "Извините, сейчас не удалось обработать сообщение. Пожалуйста, напишите ещё раз или обратитесь к сотрудникам компании.";
const MAX_MODEL_ATTEMPTS = 3;
const MAX_LOG_VALUE_LENGTH = 4000;
// The complete lead card keeps durable facts, while a compact recent tail is
// enough to resolve conversational references. Keeping this bounded is one of
// the few latency levers that does not weaken application validation.
const MAX_CONTEXT_HISTORY_MESSAGES = 8;
const MAX_AGENT_RESPONSE_TOKENS = 500;
const unnormalizedMoneyFactKeys = new Set(["vehicleValue", "requestedAmount", "vehicleValueSourceCurrency", "requestedAmountSourceCurrency"]);
const NORMALIZER_PROMPT = `Вы — технический JSON-нормализатор ответа менеджера.
Верните только один валидный JSON строго по переданной схеме AgentTurnResult.
Исправляйте только формат, типы, допустимые имена полей и лишние поля; не меняйте смысл reply и не придумывайте факты.
Контекст содержит исходный ответ, полную историю, упорядоченные currentTurnMessages и серверный pricing. Используйте его только чтобы не потерять смысл, ранние вопросы и уже известные факты при исправлении формата. Не сокращайте и не заменяйте вопросы из currentTurnMessages.
pricing рассчитан сервером только по currentFacts до текущего пакета: available=false означает, что лимит пока неизвестен, а при available=true в ответе клиенту допустимо использовать только publicMax соответствующей программы. Не вычисляйте и не подменяйте лимиты самостоятельно.
Не помещайте preliminaryLimit в leadCardPatch. targetEvent означает только уже достигнутое событие: documents после хотя бы одного вложения на этапе документов, полного комплекта или declinedDocuments=true; visit только после даты и времени; при обычном запросе документов используйте null.
Не запрашивайте уже полученные документы. Если исходный ответ нельзя безопасно восстановить, верните наиболее консервативный валидный результат без выдуманных фактов.`;

type AgentTurnInput = {
  messages: Stage1Message[];
  facts: ApplicationFacts;
  settings: object;
  /** Compatibility view for existing callers and turn-local money parsing. */
  text?: string;
  /** Ordered, uncollapsed client messages from the current batch. */
  currentTurnMessages?: Array<{ index: number; text: string }>;
  pricing?: LoanPricing;
  /** A first-pass agent identified an atypical/office/FAQ question. */
  knowledgeLookup?: boolean;
  attachments: InboundAttachment[];
  currencyConversions?: unknown[];
  conversationId?: string;
  signal?: AbortSignal;
};

@Injectable()
export class AgentTurnService {
  private readonly config = loadAppConfig();
  private readonly logger = new Logger(AgentTurnService.name);

  constructor(private readonly client: RouterAiClient, private readonly logs?: BackendLogsService) {}

  async normalizeMoney(input: { text?: string; facts: ApplicationFacts; messages: Stage1Message[]; conversationId?: string; signal?: AbortSignal }): Promise<NormalizedMoneyValue[]> {
    if (!this.client.isConfigured() || !input.text?.trim()) return [];
    const model = this.config.routerAiNormalizerModel ?? this.config.routerAiTextModel ?? "routerai-text-model-not-configured";
    const normalizerContext = {
      currentMessage: input.text,
      lastAssistantMessage: [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? ""
    };
    try {
      const response = await this.client.createChatCompletion({
        model,
        temperature: 0,
        max_tokens: 300,
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: loadPrompt("money-normalization.system.md") },
          // Keep normalization turn-local so old prices cannot be extracted
          // again. The one preceding assistant message is retained solely to
          // resolve a short answer to its immediately preceding offer.
          { role: "user", content: JSON.stringify(normalizerContext) }
        ]
      }, { timeoutMs: this.config.routerAiTimeoutMs, signal: input.signal });
      const rawModelResponse = response.choices?.[0]?.message?.content ?? "{}";
      let decoded: unknown;
      try {
        decoded = JSON.parse(rawModelResponse);
      } catch (error) {
        await this.logs?.warn("dialogue.money-normalizer", "Money normalizer returned invalid JSON", {
          conversationId: input.conversationId,
          metadata: { model: response.model ?? model, normalizerContext, rawModelResponse, parseError: formatError(error) }
        });
        return [];
      }
      const parsed = moneyNormalizationSchema.safeParse(decoded);
      if (!parsed.success) {
        await this.logs?.warn("dialogue.money-normalizer", "Money normalizer response failed schema validation", {
          conversationId: input.conversationId,
          metadata: { model: response.model ?? model, normalizerContext, rawModelResponse, schemaIssues: parsed.error.issues }
        });
        return [];
      }
      const values = discardConflictingSingleAmountRole(parsed.data.values, input.text, input.facts).map((value) => value.currency !== "KGS" && !explicitlyMentionsCurrency(input.text, value.currency)
        ? { ...value, currency: "KGS" as const }
        : value);
      if (this.logs?.log) {
        await this.logs.log("dialogue.money-normalizer", "Money normalizer response parsed", {
          conversationId: input.conversationId,
          metadata: { model: response.model ?? model, normalizerContext, rawModelResponse, decodedResponse: decoded, schemaValues: parsed.data.values, acceptedValues: values }
        });
      }
      return values;
    } catch (error) {
      if (input.signal?.aborted) throw error;
      this.logger.warn(`Money normalization unavailable: ${formatError(error)}`);
      await this.logs?.warn("dialogue.money-normalizer", "Money normalizer request failed", {
        conversationId: input.conversationId,
        metadata: { model, error: formatError(error) }
      });
      return [];
    }
  }

  /**
   * Atypical questions do not need the main workflow prompt. This model sees
   * the complete approved corpus and can either cite it faithfully or state
   * honestly that the answer is outside the chat's approved information.
   */
  async answerWithKnowledge(input: {
    messages: Stage1Message[];
    facts: ApplicationFacts;
    text?: string;
    currentTurnMessages?: Array<{ index: number; text: string }>;
    workflowFollowUp: string;
    conversationId?: string;
    signal?: AbortSignal;
  }): Promise<{ reply: string; answerFound: boolean; model: string } | undefined> {
    if (!this.client.isConfigured()) return undefined;
    const model = this.config.routerAiKnowledgeModel ?? this.config.routerAiTextModel ?? "routerai-knowledge-model-not-configured";
    const context = {
      currentMessage: input.text ?? "",
      currentTurnMessages: input.currentTurnMessages ?? (input.text === undefined ? [] : [{ index: 1, text: input.text }]),
      history: input.messages.slice(-MAX_CONTEXT_HISTORY_MESSAGES).map(({ author, body, createdAt }) => ({ author, text: body, createdAt })),
      leadCard: input.facts,
      workflowFollowUp: input.workflowFollowUp,
      knowledge: allApprovedKnowledge()
    };
    try {
      throwIfAborted(input.signal);
      const response = await this.client.createChatCompletion({
        model,
        temperature: 0,
        max_tokens: MAX_AGENT_RESPONSE_TOKENS,
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: loadPrompt("knowledge-agent.system.md") },
          { role: "user", content: JSON.stringify(context) }
        ]
      }, { timeoutMs: this.config.routerAiTimeoutMs, signal: input.signal });
      const parsed = knowledgeAnswerSchema.safeParse(parseAgentJson(response.choices?.[0]?.message?.content));
      if (!parsed.success) throw new Error(`Knowledge response does not match schema: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
      await this.logs?.log("dialogue.knowledge-model", "Knowledge model response received", {
        conversationId: input.conversationId,
        metadata: { model: response.model ?? model, answerFound: parsed.data.answerFound }
      });
      return { ...parsed.data, model: response.model ?? model };
    } catch (error) {
      if (input.signal?.aborted) throw error;
      const message = formatError(error);
      this.logger.warn(`Knowledge model unavailable: ${message}`);
      await this.logs?.warn("dialogue.knowledge-model", "Knowledge model request failed", {
        conversationId: input.conversationId,
        metadata: { model, error: message }
      });
      return undefined;
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
      model: this.config.routerAiTextModel ?? "routerai-text-model-not-configured", temperature: 0.2, max_tokens: MAX_AGENT_RESPONSE_TOKENS, reasoning: { enabled: false }, response_format: { type: "json_object" as const }
    };
    let lastError = "unknown_model_error";
    let lastRawAgentResponse: string | undefined;
    let retryWithoutImages = false;
    const attempts: Array<{ attempt: number; error: string; agentResponse?: string }> = [];
    for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt += 1) {
      let agentResponse: string | undefined;
      let attemptRequest: unknown;
      try {
        throwIfAborted(input.signal);
        const retryInstruction = attempt > 1
          ? "\n\nПОВТОРНАЯ ПОПЫТКА: предыдущий ответ не прошёл техническую проверку формата. Верните новый, полностью валидный JSON строго по заданной схеме. Не повторяйте техническое извинение: ответьте клиенту по существу и сохраните только допустимые поля карточки."
          : "";
        const userMessage = { role: "user" as const, content: buildMessage(input, !retryWithoutImages) };
        const modelRequest = {
          ...request,
          messages: [{ role: "system" as const, content: retryInstruction ? `${systemPrompt}${retryInstruction}` : systemPrompt }, userMessage]
        };
        attemptRequest = modelRequest;
        const response = await this.client.createChatCompletion(modelRequest, { timeoutMs: this.config.routerAiTimeoutMs, signal: input.signal });
        const rawAgentResponse = response.choices?.[0]?.message?.content;
        lastRawAgentResponse = typeof rawAgentResponse === "string" ? rawAgentResponse : undefined;
        agentResponse = typeof rawAgentResponse === "string" ? rawAgentResponse : undefined;
        if (this.logs?.log) {
          await this.logs.log("dialogue.main-model", "Main model response received", {
            conversationId: input.conversationId,
            metadata: { attempt, model: response.model ?? request.model, request: attemptRequest, rawModelResponse: rawAgentResponse }
          });
        }
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
        attempts.push({ attempt, error: lastError, ...(agentResponse ? { agentResponse } : {}) });
        await this.logs?.warn("dialogue.main-model", "Main model response rejected", {
          conversationId: input.conversationId,
          metadata: { attempt, model: request.model, request: attemptRequest, rawModelResponse: agentResponse, error: lastError }
        });
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
    const normalizerInput = {
      schema: "AgentTurnResult from the main agent prompt",
      error: reason,
      // The repair model accepts a bounded source response; the full original
      // response is stored in the trace metadata below.
      rawAgentResponse: rawResponse.slice(0, 16000),
      currentMessage: input.text ?? "",
      currentFacts: input.facts,
      // Preserve the complete ordered batch and history for a
      // formatting-only repair. A tail slice could omit the first
      // question in a batched client turn.
      currentTurnMessages: input.currentTurnMessages ?? (input.text === undefined ? [] : [{ index: 1, text: input.text }]),
      history: input.messages.map(({ author, body, createdAt }) => ({ author, text: body, createdAt })),
      pricing: input.pricing,
      attachments: input.attachments.map(({ id, fileName, mimeType, textContent, metadata }) => ({ id, fileName, mimeType, textContent, metadata }))
    };
    try {
      const response = await this.client.createChatCompletion({
        model,
        temperature: 0,
        max_tokens: 2200,
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: NORMALIZER_PROMPT },
          { role: "user", content: JSON.stringify(normalizerInput) }
        ]
      }, { timeoutMs: this.config.routerAiTimeoutMs, signal: input.signal });
      const content = response.choices?.[0]?.message?.content;
      const payload = normalizeAgentPayload(parseAgentJson(typeof content === "string" ? content : undefined), input.facts);
      const parsed = agentTurnResultSchema.safeParse(payload);
      if (!parsed.success) {
        await this.logs?.warn("dialogue.response-normalizer", "Response normalizer output failed schema validation", {
          conversationId: input.conversationId,
          metadata: { model: response.model ?? model, normalizerInput, sourceResponse: rawResponse, rawModelResponse: content, decodedResponse: payload, schemaIssues: parsed.error.issues }
        });
        return undefined;
      }
      const result = finalizeAgentPayload(parsed.data, input);
      if (this.logs?.log) {
        await this.logs.log("dialogue.response-normalizer", "Response normalizer output parsed", {
          conversationId: input.conversationId,
          metadata: { model: response.model ?? model, normalizerInput, sourceResponse: rawResponse, rawModelResponse: content, decodedResponse: payload, parsedResult: result }
        });
      }
      return { result, model: response.model ?? model };
    } catch (error) {
      this.logger.warn(`Cheap JSON normalizer failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.logs?.warn("dialogue.response-normalizer", "Response normalizer request failed", {
        conversationId: input.conversationId,
        metadata: { model, normalizerInput, sourceResponse: rawResponse, error: formatError(error) }
      });
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

/** A single client amount with an explicit role must never fill both money fields. */
function discardConflictingSingleAmountRole(
  values: NormalizedMoneyValue[],
  text: string | undefined,
  facts: ApplicationFacts
): NormalizedMoneyValue[] {
  const resolved = resolveMoneyFacts({ text, currentFacts: facts });
  if (resolved.mentions.length !== 1) return values;
  const role = explicitSingleMoneyRole(text);
  return role
    ? values.filter((value) => value.field === role)
    : values;
}

function explicitSingleMoneyRole(text: string | undefined): "requestedAmount" | "vehicleValue" | undefined {
  const source = text?.toLocaleLowerCase("ru-RU") ?? "";
  const requested = /(?:нужн|надо|сумм(?:а)?\s+займ|займ|получить|хочу|хотел(?:ось)?|надобно|требуется|дайте|выдайте|дадите)/iu.test(source);
  const vehicle = /(?:стоит|стоимость|цена|оцен|машина|авто|автомобил|рыночн)/iu.test(source);
  if (requested === vehicle) return undefined;
  return requested ? "requestedAmount" : "vehicleValue";
}

function explicitlyMentionsCurrency(text: string | undefined, currency: Exclude<NormalizedMoneyValue["currency"], "KGS">): boolean {
  const source = text ?? "";
  const patterns = {
    USD: /(?:\busd\b|\$|доллар)/iu,
    EUR: /(?:\beur(?:o)?s?\b|€|евро)/iu,
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
    needsKnowledgeLookup: false,
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
  // Monetary fields normally come from the turn-local normalizer so amounts
  // mentioned by Ailyn in history cannot leak into the card. There is one
  // important conversational exception: a short confirmation such as «ок»
  // contains no number for the normalizer, while the main model must still be
  // able to commit the public limit that the client just accepted.
  const { knowledgeRequest: modelKnowledgeRequest, ...leadCardFacts } = parsed.leadCardPatch;
  // Office amenities are a direct FAQ even if the compact first-pass model
  // misses the relevant chunk. Always send them to the full approved corpus.
  const knowledgeRequest = modelKnowledgeRequest ?? (isOfficeAmenitiesQuestion(input)
    ? { required: true as const, reason: "missing_approved_answer" as const }
    : undefined);
  const rawModelPatch = {
    ...modelMoneyPatchForTurn(leadCardFacts, input, parsed.hasMoney),
    ...residencePatchFromExplicitClientText(input.text, leadCardFacts, input.facts),
    ...guarantorPatchFromClearReply(input, input.facts),
    ...limitChoicePatch(parsed.limitChoice, input, input.facts),
    ...familyPatchFromClearReply(input, input.facts, leadCardFacts),
    ...visitPatchFromClearReply(input, input.facts),
    ...(isClearDocumentsRefusal(input) ? { declinedDocuments: true } : {}),
    ...(isClearCarPhotoRefusal(input) ? { declinedCarPhoto: true } : {})
  };
  const region10PolicyQuestion = isRegion10PolicyQuestion(input);
  const candidateModelPatch = region10PolicyQuestion
    ? Object.fromEntries(Object.entries(rawModelPatch).filter(([key]) => key !== "vehicleRegistrationRegion")) as Partial<ApplicationFacts>
    : rawModelPatch;
  // An upload is sufficient to close the optional document-handoff stage.
  // Recognition remains best-effort: classifications and FIO may be missing,
  // but the client must never be asked to send the same files again.
  const attachmentFacts = {
    ...attachmentFactsFromResult(input.facts, parsed.attachments),
    ...(input.attachments.length > 0 ? { documentsProvided: true } : {})
  };
  const candidateFacts = effectiveFactsForTurn({
    previous: input.facts,
    modelPatch: candidateModelPatch,
    explicitFacts: {},
    currencyFacts: {},
    attachmentFacts
  });
  // A model may understand a time expression perfectly, but it may not create
  // or confirm a visit until the application itself has reached that stage.
  // Keep the language model free to interpret intent; the server owns this
  // workflow boundary.
  const candidateCompletion = deriveStageCompletion(candidateFacts);
  const modelPatch = candidateCompletion.readyForVisit
    ? candidateModelPatch
    : omitVisitFacts(candidateModelPatch);
  const effectiveFacts = modelPatch === candidateModelPatch
    ? candidateFacts
    : effectiveFactsForTurn({ previous: input.facts, modelPatch, explicitFacts: {}, currencyFacts: {}, attachmentFacts });
  const stageCompletion = deriveStageCompletion(effectiveFacts);
  const mandatoryKnowledgeAnswer = selectRelevantDocumentation({
    facts: input.facts,
    currentMessage: input.text,
    messages: input.messages,
    includeCrossStageMatches: input.knowledgeLookup
  }).mandatoryAnswer;
  const guardedModelReply = removeUnaskedCurrencyProse(removeUnaskedLimitProse(enforceOptionalStageRefusalMessage(enforceGuarantorQuestionRequirements(enforceIdentityAnswer(
    guardWorkflowStageOrder(replacePrematureVisitQuestion(deduplicateRepeatedGuarantorBlock(parsed.reply), effectiveFacts, stageCompletion), effectiveFacts, stageCompletion),
    input
  ), effectiveFacts), input), input), input);
  // `input.pricing` was calculated before this turn. Recalculate it whenever
  // the client has just changed a fact that affects a limit; otherwise a
  // residence correction (for example Cholpon-Ata -> Tokmok) would still use
  // the old region's limits in this same reply.
  const pricing = pricingForEffectiveFacts(input, effectiveFacts);
  const maximumLoanInputReply = maximumLoanInputExplanation(input, effectiveFacts);
  const maximumLoanReply = maximumLoanRangeReply({ ...input, pricing }, effectiveFacts);
  const loanRateReply = loanRateReplyForProgram(input.text, effectiveFacts);
  const requestedAmountLimit = requestedAmountLimitReply(pricing, effectiveFacts);
  const selectedLimitNotice = selectedProgramLimitNotice(input.facts, effectiveFacts, pricing);
  const vehicleNeedClarification = ambiguousVehicleNeedReply(input, effectiveFacts);
  const familyNotice = familyTransitionNotice(input, input.facts, effectiveFacts);
  const visitNotice = visitConfirmationNotice(input, input.facts, effectiveFacts);
  const attachmentAcceptanceNotice = input.attachments.length > 0 ? "Фотографии получены. Продолжаем оформление." : undefined;
  const acceptedLimitNotice = acceptedLimitChoiceNotice(input.facts, effectiveFacts);
  const olderVehicleNotice = olderVehicleProgramNotice(input, effectiveFacts);
  const region10Answer = isRegion10PolicyQuestion(input) ? "Автомобили с регионом 10 у нас не принимаются в залог по правилам компании." : undefined;
  // The model interprets the client, but it never owns the application
  // workflow. It may answer a direct question (or ask for KB routing); this
  // boundary supplies the one and only next application question.
  const workflowFollowUp = serverWorkflowFollowUp(input.text, effectiveFacts, stageCompletion, requestedAmountLimit, selectedLimitNotice);
  const directAnswer = attachmentAcceptanceNotice ?? visitNotice ?? acceptedLimitNotice ?? (region10Answer ? [region10Answer, olderVehicleNotice].filter(Boolean).join("\n\n") : undefined) ?? olderVehicleNotice ?? spouseVisitAnswer(input) ?? familyNotice ?? loanRateReply ?? maximumLoanInputReply ?? maximumLoanReply;
  const answerBeforeWorkflow = directAnswer ?? replaceUnsupportedFallbackWithApprovedAnswer(guardedModelReply, mandatoryKnowledgeAnswer, input);
  // Limits and eligibility are calculated by the server. If an amount is
  // over the selected programme's limit, preserve a normal acknowledgement or
  // FAQ answer but remove the model's competing explanation before adding the
  // one canonical calculation below.
  const serverSafeAnswer = requestedAmountLimit ? removeModelLimitClaim(answerBeforeWorkflow) : answerBeforeWorkflow;
  const modelReply = appendRequiredWorkflowFollowUp(
    appendContinuationAfterRegion10PolicyQuestion(
      removeModelWorkflowQuestion(removeQuestionsForKnownLeadFacts(removeRepeatedProgramExplanation(enforceFirstContactGreeting(serverSafeAnswer, input), effectiveFacts, input), effectiveFacts, input.facts)),
      input,
      effectiveFacts
    ),
    isIdentityQuestion(input) ? undefined : workflowFollowUp
  );
  return {
    ...parsed,
    leadCardPatch: { ...effectiveFacts, ...(knowledgeRequest ? { knowledgeRequest } : {}) },
    dialogueState: region10PolicyQuestion && !input.facts.vehicleRegistrationRegion && parsed.dialogueState.stage === "REFUSED"
      ? { stage: "COLLECTING_VEHICLE", status: "need_more_data", nextAction: "continue_application" }
      : parsed.dialogueState,
    // Reconciliation belongs to the orchestrator's persistence boundary.
    // The model is the sole owner of conversational meaning and client prose.
    // A limit warning answers a client-provided amount, but must never erase
    // an unrelated FAQ answer from the same turn.
    reply: vehicleNeedClarification ? enforceFirstContactGreeting(vehicleNeedClarification, input) : modelReply
  };
}

function omitVisitFacts(patch: Partial<ApplicationFacts>): Partial<ApplicationFacts> {
  const { visitRequested: _visitRequested, visitDate: _visitDate, visitTime: _visitTime, visitConfirmationPending: _visitConfirmationPending, ...safePatch } = patch;
  return safePatch;
}

function visitPatchFromClearReply(input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages" | "settings">, facts: ApplicationFacts): Partial<ApplicationFacts> {
  if (!deriveStageCompletion(facts).readyForVisit) return {};
  const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  if (!/(?:на\s+какой\s+день|день\s+и\s+время|когда\s+вам\s+удобно).{0,100}(?:подъехать|приехать)/iu.test(lastAssistant)) return {};
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim().toLocaleLowerCase("ru-RU");
  const timeMatch = text.match(/(?:в\s*)?(\d{1,2})(?::(\d{2}))?\s*(?:час(?:а|ов)?|ч)?\b/iu);
  if (!timeMatch) return {};
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2] ?? "0");
  // During the working-day visit window, colloquial «в 5» means 17:00.
  if (hour >= 1 && hour <= 8) hour += 12;
  if (hour < 11 || hour > 18 || minute > 59) return {};
  const settings = input.settings as Record<string, unknown>;
  const timezone = typeof settings.timezone === "string" ? settings.timezone : "Asia/Bishkek";
  const visitDate = relativeVisitDate(text, timezone);
  if (!visitDate) return {};
  return { visitRequested: true, visitDate, visitTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

function relativeVisitDate(text: string, timezone: string): string | undefined {
  const offset = /сегодня/iu.test(text) ? 0 : /завтра/iu.test(text) ? 1 : undefined;
  if (offset === undefined) return undefined;
  const date = new Date(`${currentDateTime(timezone).slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  // The office accepts visits Monday through Friday only.
  if (date.getUTCDay() === 0 || date.getUTCDay() === 6) return undefined;
  return date.toISOString().slice(0, 10);
}

function limitChoicePatch(choice: AgentTurnResult["limitChoice"], input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages" | "pricing">, facts: ApplicationFacts): Partial<ApplicationFacts> {
  if (facts.requestedProgram !== "without_storage" || facts.requestedAmount === undefined) return {};
  const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  if (!/могу\s+продолжить\s+либо[\s\S]{0,500}(?:перейти|стоянк)/iu.test(lastAssistant)) return {};
  const withoutLimit = input.pricing?.withoutStorage.publicMax;
  const parkingLimit = input.pricing?.parking.publicMax;
  // The server made a two-option offer: retain the car with a lower amount,
  // or move it to parking. A terse negative response therefore rejects the
  // offered parking alternative, not the loan itself. The model handles all
  // richer language semantically; this only protects the unambiguous bare
  // refusal if the model left its routing field undecided.
  const resolvedChoice = choice === "undecided" && isBareRefusal(input) ? "keep_car" : choice;
  if (resolvedChoice === "keep_car" && typeof withoutLimit === "number") return { requestedAmount: withoutLimit };
  if (resolvedChoice === "parking" && typeof parkingLimit === "number") return {
    requestedProgram: "parking",
    requestedAmount: Math.min(facts.requestedAmount, parkingLimit)
  };
  return {};
}

function isBareRefusal(input: Pick<AgentTurnInput, "text" | "currentTurnMessages">): boolean {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
  return /^(?:нет|неа|не\s+хочу|не\s+буду|отказываюсь|не\s+подходит)[.!\s]*$/iu.test(text);
}

function acceptedLimitChoiceNotice(previous: ApplicationFacts, current: ApplicationFacts): string | undefined {
  if (previous.requestedAmount === current.requestedAmount || current.requestedAmount === undefined || !current.requestedProgram) return undefined;
  const program = current.requestedProgram === "parking" ? "со стоянкой" : "без изъятия";
  return `Поняла, продолжим по программе ${program} на сумму ${formatSomMoney(current.requestedAmount)} сом.`;
}

function removeUnaskedLimitProse(reply: string, input: Pick<AgentTurnInput, "text" | "currentTurnMessages">): string {
  const text = input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "";
  if (asksMaximumLoan(text)) return reply;
  return reply
    .replace(/\s*По\s+авто[^.!?]*сумм[^.!?]*максимальн[^.!?]*[.!?]/iu, "")
    .replace(/\s*Если\s+нужен\s+займ\s+свыше[^.!?]*[.!?]/iu, "")
    .replace(/[ \t]{2,}/gu, " ").trim();
}

function removeUnaskedCurrencyProse(reply: string, input: Pick<AgentTurnInput, "currencyConversions">): string {
  if (input.currencyConversions?.length) return reply;
  return reply
    .replace(/\s*По\s+(?:текущему|официальному)\s+курсу[^.!?\n]*[.!?]/giu, "")
    .replace(/\s*это\s+ориентировочно\s+[\d\s\u00a0]+сом[.!?]?/giu, "")
    .replace(/[ \t]{2,}/gu, " ").trim();
}

function olderVehicleProgramNotice(input: Pick<AgentTurnInput, "messages" | "settings">, facts: ApplicationFacts): string | undefined {
  if (!facts.vehicleYear || new Date().getFullYear() - facts.vehicleYear <= 15) return undefined;
  const notice = "По общему правилу мы принимаем в залог автомобили старше 15 лет только на стоянку, но если вы планируете получить займ без изъятия, то мы готовы рассмотреть вашу заявку индивидуально.";
  const alreadyExplained = input.messages.some((message) => message.author === "ai" && /автомобил\p{L}*\s+старше\s+15\s+лет[\s\S]{0,180}(?:только\s+на\s+стоянк|индивидуально)/iu.test(message.body));
  return alreadyExplained ? undefined : notice;
}

function visitConfirmationNotice(input: Pick<AgentTurnInput, "settings">, previous: ApplicationFacts, current: ApplicationFacts): string | undefined {
  if (!current.visitDate || !current.visitTime || (previous.visitDate === current.visitDate && previous.visitTime === current.visitTime)) return undefined;
  const settings = input.settings as Record<string, unknown>;
  const timezone = typeof settings.timezone === "string" ? settings.timezone : "Asia/Bishkek";
  const date = new Date(`${current.visitDate}T00:00:00Z`);
  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long", timeZone: "UTC" }).format(date);
  const displayDate = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(date);
  const address = typeof settings.address === "string" ? settings.address : "Б. Молодой Гвардии, 22, Бишкек";
  const twoGis = typeof settings.twoGisUrl === "string" ? settings.twoGisUrl : "https://go.2gis.com/Y34m4";
  const googleMaps = typeof settings.googleMapsUrl === "string" ? settings.googleMapsUrl : "https://maps.app.goo.gl/9xiWLVvdyRgn3Sx4A";
  void timezone;
  return `Поняла, записываю Вас на ${weekday}, ${displayDate}, в ${current.visitTime}.\nЗапись предварительная, её подтвердит менеджер.\nАдрес: ${address}\n2ГИС: ${twoGis}\nGoogle Maps: ${googleMaps}`;
}

function replacePrematureVisitQuestion(reply: string, facts: ApplicationFacts, stageCompletion = deriveStageCompletion(facts)): string {
  const asksForVisit = /(?:на\s+какой\s+день|когда\s+вам\s+удобно|во\s+сколько).{0,100}(?:подъехать|приехать|визит)|(?:подъехать|приехать).{0,80}(?:день|время|час)/iu.test(reply);
  if (!asksForVisit || stageCompletion.readyForVisit) return reply;
  return nextRequiredStageQuestion(facts, stageCompletion) ?? reply;
}

/** Do not let a prose-only model response skip from vehicle collection to a
 * later form stage. Preserve a FAQ answer, but remove its premature follow-up.
 */
function guardWorkflowStageOrder(reply: string, facts: ApplicationFacts, completion = deriveStageCompletion(facts)): string {
  const nextQuestion = nextRequiredStageQuestion(facts, completion);
  if (!nextQuestion || facts.residenceRegion || facts.residenceCategory) return reply;
  const residenceQuestion = /\s*подскажите,?\s+(?:пожалуйста,?\s+)?(?:вашу?\s+)?пропис\p{L}*[^\n]*?(?:[?!.]|$)/iu;
  const prematureQuestion = !completion.vehicle
    ? residenceQuestion
    : !completion.requestedAmount
      ? residenceQuestion
      : !completion.program
        ? residenceQuestion
        : !completion.residence
          ? /\s*(?:подскажите,?\s+пожалуйста,?\s+)?(?:есть\s+ли\s+у\s+вас\s+)?поручител[^?!.\n]*[?]/iu
          : !completion.guarantor
            ? /\s*(?:пожалуйста,?\s*)?(?:отправьте|пришлите)[^?!.\n]*(?:ID|документ|СТС)[^?!.\n]*[?!.]?/iu
            : undefined;
  if (!prematureQuestion || !prematureQuestion.test(reply)) return reply;
  const withoutPrematureQuestion = reply.replace(prematureQuestion, "").replace(/[ \t]{2,}/gu, " ").trim();
  return withoutPrematureQuestion || nextQuestion;
}

export function nextRequiredStageQuestion(facts: ApplicationFacts, completion = deriveStageCompletion(facts)): string | undefined {
  if (!completion?.vehicle) {
    const missing = [
      !facts.vehicleModel || !facts.vehicleYear ? "модель и год выпуска автомобиля" : undefined,
      facts.vehicleValue === undefined ? "ориентировочную стоимость автомобиля" : undefined
    ].filter((value): value is string => Boolean(value));
    return `Подскажите, пожалуйста, ${missing.join(" и ")}.`;
  }
  if (!completion.requestedAmount) return "Какая сумма займа Вам необходима?";
  if (!completion.program) return "Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?";
  if (!completion.residence) return "Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.";
  if (!completion.guarantor) {
    return facts.guarantorAvailable === false && !facts.guarantorAlternativeDeclined
      ? GUARANTOR_PARKING_ALTERNATIVE
      : GUARANTOR_REQUIREMENTS;
  }
  if (!completion.documents) return "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.";
  if (!completion.carPhoto) return "Пожалуйста, отправьте 2–3 фотографии автомобиля.";
  if (!completion.family) return nextFamilyStageQuestion(facts);
  if (completion.readyForVisit && !completion.visit) return "Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?";
  return undefined;
}

function nextFamilyStageQuestion(facts: ApplicationFacts): string {
  if (!facts.familyStatus || facts.familyStatus === "unknown") return "Подскажите, пожалуйста, Ваше семейное положение — Вы в браке, в разводе или не в браке.";
  if (facts.familyStatus === "divorced" && facts.vehicleBoughtDuringMarriage === undefined) {
    return "Подскажите, пожалуйста, автомобиль был приобретён во время брака или после развода?";
  }
  if (facts.familyStatus === "married" && facts.spouseAway) {
    if (facts.visitDate || facts.visitTime) return "Супруг или супруга может оформить нотариальное согласие у любого нотариуса по месту нахождения и отправить Вам оригинал. Вам удобнее отменить визит или перенести его на другую дату?";
    return "Супруг или супруга может оформить нотариальное согласие у любого нотариуса по месту нахождения и отправить Вам оригинал. Напишите, пожалуйста, когда согласие будет у Вас — после этого продолжим оформление.";
  }
  if (facts.familyStatus === "married") return "Для оформления потребуется нотариальное согласие супруга или супруги. Его можно оформить у любого нотариуса или у нотариуса в нашем здании; ориентировочная стоимость — 1500 сом. Вам удобно оформить согласие при визите в офис?";
  return "Подскажите, пожалуйста, Ваше семейное положение — Вы в браке, в разводе или не в браке.";
}

function asksMaximumLoan(text: string | undefined): boolean {
  return /(?:сколько[^.!?]{0,40}(?:денег|дадут|дадите)|максим|лимит|доступн[^.!?]{0,30}сумм|\d[^.!?]{0,24}дадите)/iu.test(text ?? "");
}

function asksLoanRate(text: string | undefined): boolean {
  return /(?:процент|ставк)/iu.test(text ?? "");
}

function loanRateReplyForProgram(text: string | undefined, facts: ApplicationFacts): string | undefined {
  if (!asksLoanRate(text)) return undefined;
  const parking = "Программа со стоянкой (авто на парковке): ставка 2,4% в месяц + стоимость парковки 130 сом/сутки; сумма до 2 000 000 сом.";
  const withoutStorage = "Программа БЕЗ ИЗЪЯТИЯ (авто остаётся у клиента): ставка определяется индивидуально после осмотра; сумма до 600 000 сом.";
  if (facts.requestedProgram === "parking") return parking;
  if (facts.requestedProgram === "without_storage") return withoutStorage;
  return `${parking}\n${withoutStorage}`;
}

function maximumLoanInputExplanation(input: Pick<AgentTurnInput, "text">, facts: ApplicationFacts): string | undefined {
  if (!asksMaximumLoan(input.text)) return undefined;
  if (facts.vehicleModel && facts.vehicleYear && facts.vehicleValue !== undefined && facts.residenceRegion && facts.residenceCategory) return undefined;
  return "Максимальная сумма зависит от автомобиля, выбранной программы и прописки.";
}

function maximumLoanRangeReply(input: Pick<AgentTurnInput, "text" | "pricing">, facts: ApplicationFacts): string | undefined {
  if (!asksMaximumLoan(input.text) || !facts.vehicleModel || !facts.vehicleYear || facts.vehicleValue === undefined || !facts.residenceRegion || !facts.residenceCategory) return undefined;
  const withoutStorage = input.pricing?.withoutStorage;
  const parking = input.pricing?.parking;
  if (!withoutStorage?.available || typeof withoutStorage.publicMax !== "number" || !parking?.available || typeof parking.publicMax !== "number") return undefined;
  return [
    `Без изъятия: от 50 000 сом до ${formatSomMoney(withoutStorage.publicMax)} сом`,
    `Со стоянкой: от 50 000 сом до ${formatSomMoney(parking.publicMax)} сом`
  ].join("\n");
}

function requestedAmountLimitReply(pricing: LoanPricing | undefined, facts: ApplicationFacts): string | undefined {
  if (facts.requestedAmount === undefined || !facts.requestedProgram) return undefined;
  const selectedPricing = facts.requestedProgram === "without_storage" ? pricing?.withoutStorage : pricing?.parking;
  if (!selectedPricing?.available || typeof selectedPricing.publicMax !== "number" || facts.requestedAmount <= selectedPricing.publicMax) return undefined;
  const programName = facts.requestedProgram === "without_storage" ? "без изъятия" : "со стоянкой";
  const limit = formatSomMoney(selectedPricing.publicMax);
  const requested = formatSomMoney(facts.requestedAmount);
  if (facts.requestedProgram === "without_storage") {
    const parkingMaximum = pricing?.parking.available && typeof pricing.parking.publicMax === "number"
      ? pricing.parking.publicMax
      : undefined;
    // Parking remains a useful alternative when it raises the available
    // amount, even if the same appraisal still cannot support the client's
    // original request. State both server-calculated values so it is clear
    // why the requested amount cannot be approved and what can change.
    if (parkingMaximum !== undefined && parkingMaximum > selectedPricing.publicMax) {
      const parkingLimit = formatSomMoney(parkingMaximum);
      const parkingExplanation = facts.requestedAmount <= parkingMaximum
        ? `Со стоянкой при текущей стоимости автомобиля доступно до ${parkingLimit} сом.`
        : `Со стоянкой при текущей стоимости автомобиля доступно до ${parkingLimit} сом, поэтому ${requested} сом также не проходит.`;
      return `По программе ${programName} доступно до ${limit} сом. Сумма ${requested} сом по этой программе не проходит. ${parkingExplanation} Могу продолжить либо на сумму до ${limit} сом без изъятия, либо перейти на программу со стоянкой и рассмотреть сумму до ${parkingLimit} сом.`;
    }
    return `По программе ${programName} доступно до ${limit} сом. Сумма ${requested} сом по этой программе не проходит. Могу продолжить на сумму до ${limit} сом.`;
  }
  return `По программе ${programName} доступно до ${limit} сом. Сумма ${requested} сом по этой программе не проходит. Могу продолжить на сумму до ${limit} сом.`;
}

function removeModelLimitClaim(reply: string): string {
  return reply
    .split(/(?<=[?!.])(?=\s|$)/gu)
    .filter((sentence) => {
      const isLimitOrEligibilityClaim = /(?:по\s+(?:этой\s+)?программе|лимит|поручител)/iu.test(sentence);
      const isRejection = /(?:не\s+проход|не\s+подход|не\s+доступ|не\s+получится|доступно\s+до)/iu.test(sentence);
      return !(isLimitOrEligibilityClaim && isRejection);
    })
    .join("")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

function pricingForEffectiveFacts(input: Pick<AgentTurnInput, "facts" | "pricing" | "settings">, facts: ApplicationFacts): LoanPricing {
  const pricingFactChanged = facts.vehicleValue !== input.facts.vehicleValue
    || facts.residenceRegion !== input.facts.residenceRegion
    || facts.residenceCategory !== input.facts.residenceCategory;
  return pricingFactChanged || !input.pricing
    ? calculateLoanPricing(facts, input.settings as LoanPricingSettings)
    : input.pricing;
}

function selectedProgramLimitNotice(previous: ApplicationFacts, current: ApplicationFacts, pricing: LoanPricing): string | undefined {
  const applicationFactsAreComplete = Boolean(
    current.vehicleModel && current.vehicleYear && current.vehicleValue !== undefined &&
    current.requestedAmount !== undefined && current.requestedProgram &&
    current.residenceRegion && current.residenceCategory && !current.residenceNeedsClarification
  );
  if (!applicationFactsAreComplete) return undefined;
  const previousApplicationFactsWereComplete = Boolean(
    previous.vehicleModel && previous.vehicleYear && previous.vehicleValue !== undefined &&
    previous.requestedAmount !== undefined && previous.requestedProgram &&
    previous.residenceRegion && previous.residenceCategory && !previous.residenceNeedsClarification
  );
  // Announce the limit at the moment the base application becomes complete,
  // and again when the client deliberately selects a different programme or
  // corrects their residence. Do not re-announce it merely because a model
  // echoes a stale car value from a completed stage.
  const programmeChanged = previous.requestedProgram !== undefined && current.requestedProgram !== previous.requestedProgram;
  const residenceChanged = previous.residenceRegion !== current.residenceRegion || previous.residenceCategory !== current.residenceCategory;
  if (previousApplicationFactsWereComplete && !programmeChanged && !residenceChanged) return undefined;
  const selectedPricing = current.requestedProgram === "without_storage" ? pricing.withoutStorage : pricing.parking;
  if (!selectedPricing.available || typeof selectedPricing.publicMax !== "number") return undefined;
  const programName = current.requestedProgram === "without_storage" ? "без изъятия" : "со стоянкой";
  return `По программе ${programName} доступно до ${formatSomMoney(selectedPricing.publicMax)} сом.`;
}

function removeQuestionsForKnownLeadFacts(reply: string, facts: ApplicationFacts, previousFacts: ApplicationFacts = {}): string {
  // An acknowledgement is useful exactly once: in the turn that closes an
  // optional stage. On subsequent turns it is stale model context and must
  // never survive into a reply to a different question or stage.
  if (facts.declinedCarPhoto && previousFacts.declinedCarPhoto) {
    reply = reply.replace(/\s*(?:хорошо,?\s*)?фотографи\p{L}*\s+автомобил\p{L}*\s+можно\s+отправить\s+позже[.!]?/iu, "").trim();
  }
  if (facts.declinedDocuments && previousFacts.declinedDocuments) {
    reply = reply.replace(/\s*(?:хорошо,?\s*)?документ\p{L}*\s+можно\s+отправить\s+позже[.!]?/iu, "").trim();
  }
  if (facts.documentsProvided) {
    reply = reply
      .replace(/\s*(?:пожалуйста,?\s*)?(?:отправьте|пришлите)[^.!?\n]{0,180}(?:\bid\b|паспорт|свидетельств|стс)[^.!?\n]*[?!.]?/iu, "")
      .replace(/\s*пожалуйста,?\s+отправьте\s+фото\s+документ[^.!?\n]*[?!.]?/iu, "")
      .replace(/[ \t]{2,}/gu, " ")
      .trim();
  }
  if (facts.requestedAmount !== undefined && facts.requestedProgram) {
    reply = reply
      .replace(/\s*у\s+вас\s+(?:всё\s+ещё\s+)?актуальн[^?!.]*[?!.]?/iu, "")
      .replace(/[ \t]{2,}/gu, " ")
      .trim();
  }
  const completion = deriveStageCompletion(facts);
  const nextStageQuestion = nextRequiredStageQuestion(facts, completion);
  if (completion.guarantor && /(?:есть\s+ли\s+у\s+вас\s+поручител|нуж(?:ен|на)\s+поручител)/iu.test(reply)) {
    const withoutRepeatedGuarantorQuestion = reply
      .replace(/\s*[^.!?\n]{0,160}поручител[^.!?\n]*[.!?]/iu, "")
      .replace(/\s*(?:подскажите,?\s+пожалуйста,?\s+)?(?:есть\s+ли\s+у\s+вас\s+поручител[^?!.]*|поручител[^?!.]{0,100}нуж(?:ен|на)[^?!.]*)[?!.]?/iu, "")
      .replace(/[ \t]{2,}/gu, " ")
      .trim();
    return [withoutRepeatedGuarantorQuestion, nextStageQuestion].filter(Boolean).join("\n\n") || reply;
  }
  const completedStageQuestion = completion.vehicle
    ? /\s*подскажите,?\s+пожалуйста,?\s+[^?\n]{0,100}(?:сто[ий]мост|сто[ий]т|цен)[^?\n]*[?!.]?/iu
    : completion.requestedAmount
      ? /\s*подскажите,?\s+пожалуйста,?\s+[^?\n]{0,100}(?:сумм[ау]\s+займ|сколько\s+(?:денег|нужно))[^?\n]*[?!.]?/iu
      : completion.program
        ? /\s*(?:вас\s+)?интересует[^?\n]*(?:без\s+изъятия|стоянк)[^?\n]*[?!.]?/iu
        : undefined;
  if (completedStageQuestion?.test(reply)) {
    const withoutRepeatedQuestion = reply.replace(completedStageQuestion, "").replace(/[ \t]{2,}/gu, " ").trim();
    return withoutRepeatedQuestion || nextStageQuestion || reply;
  }
  if (!facts.residenceRegion && !facts.residenceCategory) return reply;
  // The lead card is authoritative: a state-machine stage can never reopen a
  // residence question already answered by the client and persisted earlier.
  const withoutRepeatedResidenceQuestion = reply
    .replace(/\s*подскажите,?\s+пожалуйста,?\s+ваша\s+прописка\s*[—:-]\s*бишкек,?\s*чуйская\s+область\s+или\s+другой\s+регион\s+кыргызстана[?!.]?/iu, "")
    .replace(/\s*подскажите,?\s+пожалуйста,?\s+вы\s+прописаны\s+(?:в\s+)?(?:бишкеке|чуйской\s+области|другом\s+регионе)[?!.]?/iu, "")
    .replace(/\s*подскажите,?\s+пожалуйста,?\s+вы\s+зарегистрирован\p{L}*[^?!.\n]*(?:бишкек|чуйск|друг(?:ом|ой)\s+регион)[^?!.\n]*(?:[?!.]|$)/iu, "")
    .replace(/\s*подскажите,?\s+пожалуйста,?\s+в\s+каком\s+(?:районе|городе)\s+вы\s+(?:прописан|зарегистрирован)\p{L}*[^?!.\n]*(?:[?!.]|$)/iu, "")
    .replace(/\s*(?:чтобы\s+продолжить\s+расч[её]т,?\s*)?подскажите,?\s+пожалуйста,?\s+прописку(?:\s+полностью)?\s*[—:-]?\s*(?:город\s+или\s+область)?[?!.]?/iu, "")
    .replace(/\s*[^.!?\n]{0,120}пропис\p{L}*[^.!?\n]*\?/iu, "")
    .replace(/\s*подскажите,?\s*(?:пожалуйста,?\s*)?куда\s+(?:сейчас\s+)?направл\p{L}*\s+заявк[^?!.\n]*(?:[?!.]|$)/iu, "")
    .replace(/\s*куда\s+(?:сейчас\s+)?направл\p{L}*\s+заявк[^?!.\n]*(?:[?!.]|$)/iu, "")
    .replace(/\s*(?:для\s+оформления\s+)?нуж\p{L}*[^.!?\n]{0,80}(?:насел[её]нн\p{L}*\s+пункт|город|област)[^.!?\n]{0,80}пропис\p{L}*[^.!?\n]*[.!]?/iu, "")
    // A model sometimes disguises the same completed residence check as a
    // question about where the car is located. This is not a separate stage:
    // the authoritative card already has the residence category required for
    // eligibility, so continue with the next false completion flag instead.
    .replace(/\s*подскажите,?\s*(?:пожалуйста,?\s*)?(?:автомобил[ья]\s+у\s+вас|ваш\s+автомобиль)[^?!\n]{0,100}(?:бишкек|чуйск|друг(?:ом|ой)\s+регион)[^?!\n]*[?!.]?/iu, "")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
  if (withoutRepeatedResidenceQuestion === reply.trim()) return withoutRepeatedResidenceQuestion;
  const nextQuestion = nextRequiredStageQuestion(facts, completion) ?? nextLeadCardQuestionAfterResidence(facts);
  return [withoutRepeatedResidenceQuestion, nextQuestion].filter(Boolean).join("\n\n");
}

/**
 * A completed lead card is calculated only on the server.  Keep every
 * application prompt here too, so the model cannot advance, reorder, or
 * reopen a stage with a differently worded question.
 */
function serverWorkflowFollowUp(text: string | undefined, facts: ApplicationFacts, completion: StageCompletion, amountLimitReply: string | undefined, selectedLimitNotice: string | undefined): string | undefined {
  // A question about the maximum is answered by the calculation above. Do not
  // turn that answer into a repeated request for the amount the client needs.
  if (asksMaximumLoan(text)) return amountLimitReply;
  if (asksLoanRate(text)) return undefined;
  if (amountLimitReply) return amountLimitReply;
  return [selectedLimitNotice, nextRequiredStageQuestion(facts, completion)].filter(Boolean).join("\n\n") || undefined;
}

function removeModelWorkflowQuestion(reply: string): string {
  // The divorce transition is a single canonical server response: its first
  // sentence explains the rule and its second sentence asks the purchase
  // timing. It must remain atomic so the workflow appender does not preserve
  // the explanation and append the same full prompt a second time.
  if (/Нотариальное\s+согласие\s+бывшего\s+супруга\s+или\s+супруги\s+не\s+требуется/iu.test(reply) && /автомобиль\s+был\s+приобрет\p{L}*\s+во\s+время\s+брака\s+или\s+после\s+развода/iu.test(reply)) {
    return reply.trim();
  }
  const isWorkflowQuestion = (question: string): boolean => {
    const normalized = question.toLocaleLowerCase("ru-RU");
    // This is an extraction clarification, not an application-stage prompt:
    // the model may use it only when a monetary role is truly ambiguous.
    if (/это.*стоимост.*или.*сумм.*займ/u.test(normalized)) return false;
    return /(?:марку|модел[ьи]|год(?:а|\s+выпуска)?|стоимост[ьи]|цен[ау]|автомобил[ья])/.test(normalized)
      || /(?:сумм[ау]\s+займ|сколько\s+(?:денег|нужно)|какую\s+сумм)/.test(normalized)
      || /(?:без\s+изъятия|со?\s+стоянк|программ[ау]\s+займ)/.test(normalized)
      || /(?:пропис|зарегистрирован|бишкек|чуйск|регион\s+кыргызстан)/.test(normalized)
      || /поручител/.test(normalized)
      || /(?:отправьте|пришлите).*(?:документ|паспорт|\bid\b|стс|фото)/.test(normalized)
      || /(?:семейн|в\s+браке|согласие\s+супруг)/.test(normalized)
      || /(?:какой\s+день|когда\s+вам\s+удобно|во\s+сколько|день\s+и\s+время).*(?:подъехать|приехать|визит)?/.test(normalized);
  };
  const stagePromptStart = /^(?:подскажите|уточните|есть\s+ли\s+у\s+вас|вас\s+интересует|пожалуйста,?\s*(?:отправьте|пришлите)|на\s+какой\s+день|когда\s+вам\s+удобно|во\s+сколько|можно\s+рассмотреть)/iu;
  // Models sometimes terminate a prompt with a period despite it being a
  // question. Remove only prompt-shaped application sentences; a question
  // embedded in FAQ prose is left intact for the knowledge-answer path.
  return reply
    .split(/(?<=[?!.])(?=\s|$)/gu)
    .filter((sentence) => !(stagePromptStart.test(sentence.trim()) && isWorkflowQuestion(sentence)))
    .join("")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function nextLeadCardQuestionAfterResidence(facts: ApplicationFacts): string | undefined {
  if (!facts.requestedProgram) {
    return "Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?";
  }
  if (!facts.vehicleModel || !facts.vehicleYear || facts.vehicleValue === undefined) {
    const missing = [
      !facts.vehicleModel || !facts.vehicleYear ? "модель и год выпуска автомобиля" : undefined,
      facts.vehicleValue === undefined ? "ориентировочную стоимость автомобиля" : undefined
    ].filter((item): item is string => Boolean(item));
    return `Подскажите, пожалуйста, ${missing.join(" и ")}.`;
  }
  if (facts.requestedAmount === undefined) return "Какая сумма займа Вам необходима?";
  return undefined;
}

function enforceFirstContactGreeting(reply: string, input: Pick<AgentTurnInput, "messages" | "text" | "currentTurnMessages">): string {
  if (input.messages.some((message) => message.author === "ai")) return reply;
  const officialGreeting = "Здравствуйте! Меня зовут Айлин. Я менеджер по оформлению новых займов автоломбарда «Молодой». Информируем Вас, что мы не выдаем займ под залог автомобиля с регионом 10.";
  // First contact is a compliance requirement, so do not rely on the model
  // remembering the greeting. Identity questions retain their exact approved
  // wording and are the only exception.
  if (isIdentityQuestion(input)) return reply;
  const rest = reply
    .replace(/^\s*здравствуйте[!,.]?\s*(?:(?:меня\s+зовут|я)\s+Айлин[^.!?]*[.!?]\s*)?(?:я\s+менеджер\s+по\s+оформлению\s+новых\s+займов\s+автоломбарда\s+«Молодой»[.!?]\s*)?(?:информируем\s+Вас,?\s+что\s+мы\s+не\s+выдаем[^.!?]*[.!?]\s*)*/iu, "")
    .replace(/^(?:я\s+менеджер\s+по\s+оформлению\s+новых\s+займов\s+автоломбарда\s+«Молодой»[.!?]\s*)+/iu, "")
    .trim();
  return [officialGreeting, rest].filter(Boolean).join("\n\n");
}

function removeRepeatedProgramExplanation(reply: string, facts: ApplicationFacts, input: Pick<AgentTurnInput, "messages" | "text" | "currentTurnMessages">): string {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "");
  if (/(?:ставк|процент|услови\p{L}*\s+программ|без\s+изъят)/iu.test(text)) return reply;
  const previousAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  const repeated = /\s*по\s+программе\s+без\s+изъятия\s+автомобил[^.!?]*оста[её]тся[^.!?]*[.!?]\s*(?:а\s+)?ставк[^.!?]*индивидуальн[^.!?]*[.!?]?/iu;
  if (!repeated.test(reply) || !repeated.test(previousAssistant)) return reply;
  const withoutRepeated = reply.replace(repeated, "").replace(/[ \t]{2,}/gu, " ").trim();
  return withoutRepeated || nextRequiredStageQuestion(facts) || reply;
}

function ambiguousVehicleNeedReply(input: Pick<AgentTurnInput, "text" | "currentTurnMessages">, facts: ApplicationFacts): string | undefined {
  if (facts.vehicleModel || facts.vehicleYear || facts.vehicleValue !== undefined) return undefined;
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
  return /^(?:мне\s+)?нуж(?:ен|на|ны)\s+(?:авто|автомобил\p{L}*)[.!?]?$/iu.test(text)
    ? "Вы хотите получить займ под залог своего автомобиля?"
    : undefined;
}

const IDENTITY_REPLY = "Я Айлин — виртуальный помощник по вопросам оформления новых займов. Если у Вас уже оформлен займ, пожалуйста, позвоните по телефону +996 502 108 108 или напишите в WhatsApp +996 776 108 108. Наши специалисты проверят информацию по Вашему договору и помогут решить Ваш вопрос.";
const SPOUSE_VISIT_ANSWER = "Возьмите с собой супругу (супруга) для нотариального оформления согласия. Если согласие у Вас будет на руках, присутствие супруги (супруга) необязательно.";

function spouseVisitAnswer(input: Pick<AgentTurnInput, "text" | "currentTurnMessages">): string | undefined {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").toLocaleLowerCase("ru-RU");
  // Do not use a bare `жен…` stem: it is contained in «нужен». The family
  // relation must appear as a standalone, inflected spouse word.
  const mentionsSpouse = /(?:^|[^\p{L}])(?:жен(?:а|у|ы|е|ой|ою)?|муж(?:а|у|ем|ья)?|супруг\p{L}*)(?=$|[^\p{L}])/iu.test(text);
  const asksAboutAttendance = /(?:нуж\p{L}*|брать|привез|приех|визит|вместе|присутств)/iu.test(text);
  return mentionsSpouse && asksAboutAttendance ? SPOUSE_VISIT_ANSWER : undefined;
}

function isIdentityQuestion(input: Pick<AgentTurnInput, "text" | "currentTurnMessages">): boolean {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").toLocaleLowerCase("ru-RU");
  return /(?:ты|вы)\s+(?:бот|робот|ии)|(?:это|ты|вы)\s+(?:ai|ии)|(?:кто\s+(?:ты|вы)\s+(?:такой|такая)|жив(?:ой|ая)|настоящ(?:ий|ая))/iu.test(text);
}

function enforceIdentityAnswer(reply: string, input: Pick<AgentTurnInput, "text" | "currentTurnMessages">): string {
  return isIdentityQuestion(input) ? IDENTITY_REPLY : reply;
}

function residencePatchFromExplicitClientText(text: string | undefined, patch: Partial<ApplicationFacts>, previousFacts: ApplicationFacts): Partial<ApplicationFacts> {
  const locality = resolveKyrgyzstanLocality(text);
  const shortLocalityCorrection = Boolean(locality && (text?.trim().split(/\s+/u).length ?? 0) <= 3);
  // A bare locality after any earlier answer is a client correction, not a
  // reference to the old residence. Its canonical category must supersede a
  // stale OTHER_KG value before the guarantor gate is evaluated.
  if (shortLocalityCorrection) {
    return {
      residenceText: text?.trim(),
      residenceRegion: locality!.residenceRegion,
      residenceCategory: locality!.category,
      residenceNeedsClarification: false
    };
  }
  if (patch.residenceRegion || patch.residenceCategory) return {};
  const followsResidenceQuestion = Boolean(
    previousFacts.vehicleModel && previousFacts.vehicleYear && previousFacts.vehicleValue !== undefined &&
    previousFacts.requestedAmount !== undefined && previousFacts.requestedProgram &&
    !previousFacts.residenceRegion && !previousFacts.residenceCategory
  );
  if (!followsResidenceQuestion && !/(?:прописан|прописка|регистрац(?:ия|ии)|живу)/iu.test(text ?? "")) return {};
  if (!locality) return {};
  return {
    residenceText: text?.trim(),
    residenceRegion: locality.residenceRegion,
    residenceCategory: locality.category,
    residenceNeedsClarification: false
  };
}

function familyPatchFromClearReply(input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages">, facts: ApplicationFacts, modelPatch: Partial<ApplicationFacts>): Partial<ApplicationFacts> {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim().toLocaleLowerCase("ru-RU");
  const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  const patch: Partial<ApplicationFacts> = {};
  // Once the client is already recorded as divorced, the question about when
  // the car was bought has a different meaning from the family-status
  // question. A short answer such as «в браке» describes the purchase, not a
  // change back to married. Do not let a model patch erase that distinction.
  if (facts.familyStatus === "divorced" && isDivorcePurchaseTimingQuestion(lastAssistant)) {
    patch.familyStatus = "divorced";
    if (isBoughtDuringMarriageReply(text)) patch.vehicleBoughtDuringMarriage = true;
    else if (isBoughtAfterDivorceReply(text)) patch.vehicleBoughtDuringMarriage = false;
    return patch;
  }
  const currentStatus = modelPatch.familyStatus ?? facts.familyStatus;
  if (!currentStatus || currentStatus === "unknown") {
    if (/(?:в\s+браке|состо(?:ю|ит)\s+в\s+браке|женат|замужем)/iu.test(text) && !/(?:не\s+(?:в\s+)?браке|не\s+женат|не\s+замужем)/iu.test(text)) patch.familyStatus = "married";
    else if (/(?:в\s+разводе|развед[её]н|развел[а-яё]*сь)/iu.test(text)) patch.familyStatus = "divorced";
    else if (/(?:не\s+(?:состо(?:ю|ит)\s+)?в\s+браке|не\s+женат|не\s+замужем|холост)/iu.test(text)) patch.familyStatus = "single";
  }
  const familyStatus = patch.familyStatus ?? currentStatus;
  if (familyStatus === "divorced" && facts.vehicleBoughtDuringMarriage === undefined) {
    if (isBoughtDuringMarriageReply(text)) patch.vehicleBoughtDuringMarriage = true;
    else if (isBoughtAfterDivorceReply(text)) patch.vehicleBoughtDuringMarriage = false;
  }
  if (familyStatus === "married") {
    if (/(?:супруг[аи]?.{0,50}(?:не\s+в\s+бишкек|в\s+отъезд|за\s+границ)|(?:не\s+в\s+бишкек|в\s+отъезд|за\s+границ).{0,50}супруг[аи]?)/iu.test(text)) patch.spouseAway = true;
    const officeConsentQuestion = /(?:согласие|нотариальн).{0,100}(?:офис|здани)/iu.test(lastAssistant);
    if (officeConsentQuestion && /^(?:да|ага|угу|конечно|будет|yes|oui|ооба|оа)$/iu.test(text)) patch.spouseConsentAtOffice = true;
    if (officeConsentQuestion && /^(?:нет|неа|нету|no|жок)$/iu.test(text)) patch.spouseConsentAtOffice = false;
    if (/(?:согласие|нотариальн).{0,40}(?:готов|есть\s+на\s+руках|оформил[а-яё]*)/iu.test(text)) patch.spouseConsentReady = true;
  }
  return patch;
}

function familyTransitionNotice(input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages">, previous: ApplicationFacts, current: ApplicationFacts): string | undefined {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").toLocaleLowerCase("ru-RU");
  const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  const explicitFamilyStatus = /(?:браке|женат|замужем|развод|холост)/iu.test(text);
  if (previous.familyStatus !== current.familyStatus && current.familyStatus === "divorced" && explicitFamilyStatus) {
    // Return the complete server-owned follow-up. This replaces, rather than
    // prefixes, a model acknowledgement and avoids saying the same consent
    // rule twice in one reply.
    return nextFamilyStageQuestion(current);
  }
  if (previous.familyStatus !== current.familyStatus && current.familyStatus === "single" && explicitFamilyStatus) {
    return "Нотариальное согласие супруга или супруги в таком случае не требуется.";
  }
  if (previous.vehicleBoughtDuringMarriage !== current.vehicleBoughtDuringMarriage && current.familyStatus === "divorced" && (isDivorcePurchaseTimingQuestion(lastAssistant) || isBoughtDuringMarriageReply(text) || isBoughtAfterDivorceReply(text))) {
    return current.vehicleBoughtDuringMarriage
      ? "В таком случае, пожалуйста, возьмите с собой оригинал свидетельства о расторжении брака. Если удобно, заранее пришлите его фотографию — это ускорит рассмотрение заявки."
      : "В таком случае свидетельство о расторжении брака не потребуется.";
  }
  if (previous.spouseConsentAtOffice !== current.spouseConsentAtOffice && current.familyStatus === "married" && current.spouseConsentAtOffice === false && /(?:согласие|нотариальн).{0,100}(?:офис|здани)/iu.test(lastAssistant)) {
    return "Тогда, пожалуйста, возьмите с собой оригинал нотариального согласия супруга или супруги.";
  }
  return undefined;
}

function isDivorcePurchaseTimingQuestion(text: string): boolean {
  return /(?:автомобил|авто).{0,80}(?:приобрет|куп).{0,80}(?:во\s+время\s+брака|после\s+развода)/iu.test(text);
}

function isBoughtDuringMarriageReply(text: string): boolean {
  return /^(?:в(?:о)?\s+)?браке[.!]?$/iu.test(text.trim())
    || /(?:куп(?:ил|ила|лен|лена)|приобр[её]л[а-яё]*).{0,40}(?:в(?:о)?\s+)?браке|(?:в(?:о)?\s+)?браке.{0,40}(?:куп(?:ил|ила|лен|лена)|приобр[её]л[а-яё]*)/iu.test(text);
}

function isBoughtAfterDivorceReply(text: string): boolean {
  return /после\s+развод|(?:куп(?:ил|ила|лен|лена)|приобр[её]л[а-яё]*).{0,40}развод/iu.test(text);
}

function requiresGuarantorForFacts(facts: ApplicationFacts): boolean {
  return facts.requestedProgram === "without_storage" && facts.residenceCategory === "OTHER_KG" && (facts.vehicleValue ?? 0) >= 1_000_000;
}

function isGuarantorQuestion(text: string): boolean {
  return /(?:есть\s+ли\s+у\s+вас\s+(?:такой\s+)?поручител|у\s+вас\s+есть\s+(?:такой\s+)?поручител)/iu.test(text);
}

function isGuarantorParkingAlternativeQuestion(text: string): boolean {
  return /(?:поручител.{0,160}(?:стоянк|охраняемую\s+стоянк)|(?:стоянк|охраняемую\s+стоянк).{0,160}поручител)/iu.test(text);
}

function clearAffirmation(text: string): boolean {
  return /^(?:да|ага|угу|есть|конечно|будет|будут|имеется|yes|oui|ооба|оа|бар)$/iu.test(text);
}

function clearNegation(text: string): boolean {
  return /^(?:нет|неа|нету|не\s+будет|не\s+имеется|no|жок)$/iu.test(text);
}

function guarantorPatchFromClearReply(input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages">, facts: ApplicationFacts): Partial<ApplicationFacts> {
  if (!requiresGuarantorForFacts(facts)) return {};
  const lastAssistantReply = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim().toLocaleLowerCase("ru-RU");
  if (isGuarantorParkingAlternativeQuestion(lastAssistantReply)) {
    if (clearAffirmation(text)) return { requestedProgram: "parking", guarantorAlternativeDeclined: false };
    if (clearNegation(text)) return { guarantorAlternativeDeclined: true };
    return {};
  }
  if (!isGuarantorQuestion(lastAssistantReply)) return {};
  if (clearAffirmation(text)) return { guarantorAvailable: true, guarantorAlternativeDeclined: false };
  if (clearNegation(text)) return { guarantorAvailable: false, guarantorAlternativeDeclined: false };
  return {};
}

const GUARANTOR_REQUIREMENTS = "Для вашей прописки требуется поручитель\n- возраст от 25 лет\n- проживает в г. Бишкек или Чуйской области\n- должен лично присутствовать при выдаче займа и иметь с собой ID (паспорт)\nУ Вас есть такой поручитель?";
const GUARANTOR_PARKING_ALTERNATIVE = "Поручитель обязателен для программы без изъятия в Вашем регионе. Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?";

function enforceGuarantorQuestionRequirements(reply: string, _facts: ApplicationFacts): string {
  // The model is prohibited from asking workflow questions. The canonical
  // requirements are appended later by `nextRequiredStageQuestion`, so this
  // guard intentionally does not manufacture a second copy in model prose.
  return reply;
}

function deduplicateRepeatedGuarantorBlock(reply: string): string {
  const question = /У Вас есть (?:такой )?поручитель\?/iu.exec(reply);
  if (!question) return reply;
  const end = question.index;
  const questionEnd = end + question[0].length;
  const first = reply.slice(0, questionEnd).trim();
  const remainder = reply.slice(questionEnd).trim();
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("ru-RU");
  return remainder && normalize(remainder) === normalize(first) ? first : reply;
}

function isOfficeAmenitiesQuestion(input: Pick<AgentTurnInput, "text" | "currentTurnMessages">): boolean {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").toLocaleLowerCase("ru-RU");
  return /(?:удобств|wi.?fi|вайфай|зона\s+ожидания|кулер|кондиционер|зарядить\s+телефон|чай|кофе|туалет).{0,60}офис|офис.{0,60}(?:удобств|wi.?fi|вайфай|зона\s+ожидания|кулер|кондиционер|зарядить\s+телефон|чай|кофе|туалет)/iu.test(text);
}

function appendRequiredWorkflowFollowUp(reply: string, followUp: string | undefined): string {
  if (!followUp) return reply;
  const parts = followUp.split("\n\n").filter(Boolean);
  const finalStagePrompt = parts.at(-1);
  // A defensive cleanup function can already have restored the canonical
  // stage prompt before the calculated-limit notice is appended. Remove that
  // trailing copy, then add the combined server-owned follow-up in its proper
  // order (limit first, prompt second).
  const base = finalStagePrompt && reply.trimEnd().endsWith(finalStagePrompt)
    ? reply.trimEnd().slice(0, -finalStagePrompt.length).trimEnd()
    : reply.trim();
  const missing = parts.filter((part) => !base.includes(part));
  return [base, ...missing].filter(Boolean).join("\n\n");
}

function isRegion10PolicyQuestion(input: Pick<AgentTurnInput, "text" | "currentTurnMessages">): boolean {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").toLocaleLowerCase("ru-RU");
  return /почему[^.!?]{0,80}(?:под\s*)?(?:10\s*)?регион|(?:10\s*)?регион[^.!?]{0,80}почему/u.test(text);
}

function appendContinuationAfterRegion10PolicyQuestion(reply: string, input: Pick<AgentTurnInput, "text" | "currentTurnMessages">, facts: ApplicationFacts): string {
  const messages = input.currentTurnMessages ?? (input.text === undefined ? [] : [{ index: 1, text: input.text }]);
  const exactPolicyAnswer = "Автомобили с регионом 10 у нас не принимаются в залог по правилам компании.";
  const officialGreeting = "Здравствуйте! Меня зовут Айлин. Я менеджер по оформлению новых займов автоломбарда «Молодой». Информируем Вас, что мы не выдаем займ под залог автомобиля с регионом 10.";
  const hasGreeting = reply.trimStart().startsWith(officialGreeting);
  const answer = hasGreeting ? reply.trimStart().slice(officialGreeting.length).trim() : reply.trim();
  if (messages.filter((message) => message.text.trim()).length < 2 || !isRegion10PolicyQuestion(input) || answer !== exactPolicyAnswer) return reply;
  if (!facts.vehicleModel || !facts.vehicleYear || !facts.vehicleValue || !facts.requestedAmount || facts.requestedProgram) return reply;
  const over15 = new Date().getFullYear() - facts.vehicleYear > 15;
  const ageNotice = over15
    ? " По автомобилю: ему больше 15 лет, поэтому по общему правилу принимаем в залог только на стоянку, а без изъятия можем рассмотреть индивидуально."
    : "";
  const continuation = `${exactPolicyAnswer}${ageNotice} Подскажите, пожалуйста, Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?`;
  return hasGreeting ? `${officialGreeting}\n\n${continuation}` : continuation;
}

function replaceUnsupportedFallbackWithApprovedAnswer(reply: string, mandatoryAnswer: string | undefined, input: Pick<AgentTurnInput, "text" | "currentTurnMessages">): string {
  // A precise FAQ match must not be lost merely because the model ignored a
  // supplied chunk and emitted the generic no-information template. Limit the
  // replacement to a single client message so a batched turn cannot lose an
  // answer to another question.
  const messages = input.currentTurnMessages ?? (input.text === undefined ? [] : [{ index: 1, text: input.text }]);
  const hasFallback = /к сожалению,?\s+у меня нет достоверной информации|когда вы приедете, сотрудники|свяжитесь с нашими сотрудниками[\s\S]{0,180}(?:телефон|whatsapp)|напишите менеджеру/iu.test(reply);
  return mandatoryAnswer && messages.length === 1 && hasFallback ? mandatoryAnswer : reply;
}

function isClearDocumentsRefusal(input: Pick<AgentTurnInput, "text" | "messages" | "attachments">): boolean {
  return isClearOptionalStageRefusal(input, /(?:отправьте|пришлите).{0,140}(?:(?:фото\s*)?(?:id|паспорт)|свидетельств\p{L}*\s+о\s+регистрац|\bстс\b)/iu);
}

function isClearCarPhotoRefusal(input: Pick<AgentTurnInput, "text" | "messages" | "attachments">): boolean {
  return isClearOptionalStageRefusal(input, /(?:2\s*[–-]\s*3|несколько)\s+фотограф(?:и|ий).{0,80}автомоб|фотограф(?:и|ий).{0,80}автомоб/iu);
}

function isClearOptionalStageRefusal(input: Pick<AgentTurnInput, "text" | "messages" | "attachments">, stageQuestion: RegExp): boolean {
  const text = input.text?.trim().toLocaleLowerCase("ru-RU") ?? "";
  if (!text || input.attachments.length > 0) return false;
  const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  const stagePrompt = [...lastAssistant.matchAll(new RegExp(stageQuestion.source, stageQuestion.flags.includes("g") ? stageQuestion.flags : `${stageQuestion.flags}g`))]
    .find((match) => {
      const afterPrompt = lastAssistant.slice((match.index ?? 0) + match[0].length);
      return !/[?？]/u.test(afterPrompt)
        && !/(?:подскажите|у\s+вас\s+есть|на\s+какой\s+день|когда\s+вам\s+удобно|состоите\s+ли)/iu.test(afterPrompt);
    });
  if (!stagePrompt) return false;

  // The document and vehicle-photo stages are optional. A short declarative
  // answer to the current upload request defers that current stage, even if
  // the client uses words previously associated with documents. This derives
  // the meaning from the last server question instead of a fixed word list.
  return /^(?:нет|неа|нету|их\s+нет|нет\s+с\s+собой|не\s+буду|не\s+хочу|не\s+могу|не\s+получится|не\s+получится\s+сейчас)[.!\s]*$/u.test(text)
    || (text.length <= 120 && !/[?？]/u.test(text) && !/^(?:зачем|почему|как|какие|какой|где|когда|можно|нужно|а\s+можно)\b/iu.test(text));
}

function enforceOptionalStageRefusalMessage(reply: string, input: Pick<AgentTurnInput, "text" | "messages" | "attachments">): string {
  if (isClearDocumentsRefusal(input)) return "Хорошо, документы можно отправить позже.";
  if (isClearCarPhotoRefusal(input)) return "Хорошо, фотографии автомобиля можно отправить позже.";
  return reply;
}

function modelMoneyPatchForTurn(patch: Partial<ApplicationFacts>, input: Pick<AgentTurnInput, "text" | "pricing">, hasMoney: boolean): Partial<ApplicationFacts> {
  const result = Object.fromEntries(Object.entries(patch).filter(([key]) => !unnormalizedMoneyFactKeys.has(key))) as Partial<ApplicationFacts>;
  const foreignCurrencyMentioned = /(?:\busd\b|\$|dollars?|доллар|\beur(?:o)?s?\b|€|евро|\bkzt\b|₸|тенге|\brub\b|₽|руб)/iu.test(input.text ?? "");
  // For KGS-only turns the main agent is the fast-path money parser. It
  // understands conversational spellings and returns the normalized number;
  // foreign currency remains exclusive to the dedicated converter.
  const modelOwnsKgsMoney = hasMoney && !foreignCurrencyMentioned;
  const offeredPublicLimits = new Set([
    input.pricing?.withoutStorage.publicMax,
    input.pricing?.parking.publicMax
  ].filter((value): value is number => typeof value === "number"));
  for (const key of ["vehicleValue", "requestedAmount"] as const) {
    const value = patch[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const rounded = roundSomAmount(value);
    if (modelOwnsKgsMoney || offeredPublicLimits.has(rounded)) result[key] = rounded;
  }
  return result;
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

function buildMessage(input: Pick<AgentTurnInput, "messages" | "facts" | "settings" | "text" | "currentTurnMessages" | "pricing" | "attachments" | "currencyConversions" | "knowledgeLookup">, includeImages = true) {
  const settings = input.settings as Record<string, unknown>;
  const timezone = typeof settings.timezone === "string" ? settings.timezone : "Asia/Bishkek";
  const currentLocality = resolveKyrgyzstanLocality(input.text);
  // The orchestrator calculates pricing before the model processes this turn.
  // A direct locality reply (for example «Токмок») is deterministic enough to
  // make that calculation current immediately, rather than forcing a vague
  // follow-up turn after the client already supplied the missing residence.
  const pricing = currentLocality
    ? calculateLoanPricing({ ...input.facts, residenceText: input.text, residenceRegion: currentLocality.residenceRegion, residenceCategory: currentLocality.category }, input.settings as LoanPricingSettings)
    : input.pricing;
  const retrieval = selectRelevantDocumentation({ facts: input.facts, currentMessage: input.text, messages: input.messages, maxChunks: 2 });
  const now = currentDateTime(timezone);
  // Date arithmetic is not delegated to the language model. The calendar is
  // only attached when a visit is relevant, so ordinary turns stay compact.
  const visitCalendar = retrieval.stages.includes("visit") ? buildVisitCalendar(now) : undefined;
  const currentTurnMessages = input.currentTurnMessages ?? (input.text === undefined ? [] : [{ index: 1, text: input.text }]);
  const history = input.messages.slice(-MAX_CONTEXT_HISTORY_MESSAGES).map(({ author, body, createdAt }) => ({ author, text: body, createdAt }));
  const knownLeadCardFields = Object.entries(input.facts)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key]) => key);
  const guarantorRequirement = guarantorRequirementFor(input.facts);
  const context = { now, timezone, history, leadCard: input.facts, knownLeadCardFields, currentMessage: input.text ?? "", currentTurnMessages, pricing, guarantorRequirement, pricingAuthority: "Pricing is calculated by the server. Use only available publicMax; never calculate or expose rawMax.", currencyConversions: input.currencyConversions ?? [], ...(visitCalendar ? { visitCalendar } : {}), relevantStages: retrieval.stages, knowledge: retrieval.knowledge };
  const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "high" } }> = [{ type: "text", text: JSON.stringify(context) }];
  for (const attachment of input.attachments) {
    parts.push({ type: "text", text: JSON.stringify({ attachment: { id: attachment.id, fileName: attachment.fileName, mimeType: attachment.mimeType, textContent: attachment.textContent, metadata: attachment.metadata } }) });
    if (includeImages && attachment.contentBase64 && /^image\/(jpeg|png|webp|gif)$/i.test(attachment.mimeType ?? "")) parts.push({ type: "image_url", image_url: { url: `data:${attachment.mimeType};base64,${attachment.contentBase64}`, detail: "high" } });
  }
  return parts;
}

function guarantorRequirementFor(facts: ApplicationFacts) {
  const baseApplicationComplete = Boolean(
    facts.vehicleModel &&
    facts.vehicleYear &&
    facts.vehicleValue !== undefined &&
    facts.requestedAmount !== undefined
  );
  const required = baseApplicationComplete && facts.requestedProgram === "without_storage" && facts.residenceCategory === "OTHER_KG" && facts.guarantorAvailable === undefined;
  return required
    ? { required: true, reason: "without_storage_outside_bishkek_chuy" }
    : { required: false, reason: facts.residenceCategory === "BISHKEK_CHUY" ? "bishkek_or_chuy" : "not_applicable" };
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
  // These fields are agent bookkeeping rather than client facts. Repair
  // harmless shorthand so a good client answer is not discarded merely
  // because a model used a human label instead of the JSON enum.
  if (typeof payload.cardSummary !== "string") payload.cardSummary = "";
  if (!payload.managerUpdate || typeof payload.managerUpdate !== "object" || Array.isArray(payload.managerUpdate)) {
    payload.managerUpdate = { kind: "none", changedFields: [] };
  } else {
    const update = payload.managerUpdate as Record<string, unknown>;
    payload.managerUpdate = {
      kind: ["none", "initial", "delta"].includes(String(update.kind)) ? update.kind : "none",
      changedFields: Array.isArray(update.changedFields) ? update.changedFields.filter((value): value is string => typeof value === "string") : []
    };
  }
  if (typeof payload.preliminaryLimit === "string") {
    // A numeric string is a formatting defect, not a reason to discard an
    // otherwise complete multi-question answer after three expensive retries.
    const value = Number(payload.preliminaryLimit.replace(/[\s_]/g, "").replace(",", "."));
    if (Number.isFinite(value)) payload.preliminaryLimit = value;
  }
  const leadCardPatch = payload.leadCardPatch;
  if (leadCardPatch && typeof leadCardPatch === "object" && !Array.isArray(leadCardPatch)) {
    const carriedFacts = Object.fromEntries(Object.entries(currentFacts).filter(([key, value]) => permittedLeadCardKeys.has(key) && value !== undefined));
    const rawPatch = leadCardPatch as Record<string, unknown>;
    // `limitChoice` is transient routing metadata, not a lead fact. Some
    // otherwise correct model replies put it next to the chosen program in
    // leadCardPatch. Lift that value before filtering the persisted patch so a
    // semantic choice to keep the car can actually apply the public limit.
    if (payload.limitChoice === undefined && ["keep_car", "parking", "undecided"].includes(String(rawPatch.limitChoice))) {
      payload.limitChoice = rawPatch.limitChoice;
    }
    // The model sometimes mirrors derived/top-level fields (for example
    // preliminaryLimit) inside leadCardPatch. They are not application facts,
    // so drop them instead of rejecting an otherwise usable turn.
    const patch = {
      ...carriedFacts,
      ...Object.fromEntries(Object.entries(rawPatch).filter(([key]) => permittedLeadCardKeys.has(key) || key in leadCardAliases))
    };
    // Older prompt versions emitted this signal at the top level. Keep those
    // replies routable, but normalize every new turn to the transient patch
    // field so the orchestrator has one routing boundary.
    if (payload.needsKnowledgeLookup === true && patch.knowledgeRequest === undefined) {
      patch.knowledgeRequest = { required: true, reason: "missing_approved_answer" };
    }
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
    // `residenceRegion` is an open text field, so a model-friendly label such
    // as `other_region` passes Zod unless we canonicalize it here. A complete
    // region/category pair is required for the server-owned stage controller;
    // infer the unambiguous OTHER_KG category instead of reopening residence.
    if (patch.residenceRegion === "Другой регион Кыргызстана" && patch.residenceCategory === undefined) {
      patch.residenceCategory = "OTHER_KG";
      patch.residenceNeedsClarification = false;
    }
    payload.leadCardPatch = patch;
    payload.needsKnowledgeLookup = Boolean((patch.knowledgeRequest as { required?: unknown } | undefined)?.required);
  }
  const rawState = payload.dialogueState;
  const state = typeof rawState === "string"
    ? { stage: rawState }
    : rawState && typeof rawState === "object" && !Array.isArray(rawState)
      ? rawState as Record<string, unknown>
      : undefined;
  if (state) {
    const stage = typeof state.stage === "string" ? state.stage : "";
    const normalizedStage = stageAliases[stage.trim().toLowerCase()] ?? stage;
    if (workflowStages.has(normalizedStage)) {
      const status = typeof state.status === "string" && workflowStatuses.has(state.status)
        ? state.status
        : normalizedStage === "REFUSED" ? "refuse" : "need_more_data";
      payload.dialogueState = {
        stage: normalizedStage,
        status,
        nextAction: typeof state.nextAction === "string" && state.nextAction.trim() ? state.nextAction : "continue_application"
      };
    }
  }
  if (typeof payload.targetEvent === "string") {
    const event = payload.targetEvent.trim().toLowerCase();
    if (!["documents", "visit"].includes(event)) payload.targetEvent = null;
  }
  return payload;
}

const stageAliases: Record<string, string> = {
  new: "NEW", initial: "NEW", application: "COLLECTING_VEHICLE", loan_application: "COLLECTING_VEHICLE", collecting_vehicle: "COLLECTING_VEHICLE", collect_vehicle: "COLLECTING_VEHICLE",
  collecting_value: "COLLECTING_VALUE", collect_value: "COLLECTING_VALUE", collecting_amount: "COLLECTING_AMOUNT", collect_amount: "COLLECTING_AMOUNT",
  collecting_residence: "COLLECTING_RESIDENCE", collect_residence: "COLLECTING_RESIDENCE", eligibility_check: "ELIGIBILITY_CHECK",
  collecting_documents: "COLLECTING_DOCUMENTS", collect_documents: "COLLECTING_DOCUMENTS", collecting_family_status: "COLLECTING_FAMILY_STATUS",
  checking_guarantor: "CHECKING_GUARANTOR", check_guarantor: "CHECKING_GUARANTOR", scheduling_visit: "SCHEDULING_VISIT",
  target_reached_documents: "TARGET_REACHED_DOCUMENTS", target_reached_visit: "TARGET_REACHED_VISIT", refused: "REFUSED", paused: "PAUSED",
  existing_contract_redirect: "EXISTING_CONTRACT_REDIRECT"
};
const workflowStages = new Set([
  "NEW", "COLLECTING_VEHICLE", "COLLECTING_VALUE", "COLLECTING_AMOUNT", "COLLECTING_RESIDENCE", "ELIGIBILITY_CHECK", "COLLECTING_DOCUMENTS", "COLLECTING_FAMILY_STATUS", "CHECKING_GUARANTOR", "SCHEDULING_VISIT", "TARGET_REACHED_DOCUMENTS", "TARGET_REACHED_VISIT", "REFUSED", "PAUSED", "EXISTING_CONTRACT_REDIRECT"
]);
const workflowStatuses = new Set(["continue", "refuse", "need_more_data", "redirect_existing_contract", "target_reached", "blocked"]);

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
  OTHER_REGION: "Другой регион Кыргызстана",
  FOREIGN: "Другая страна"
};

const residenceCategoryAliases: Record<string, string> = {
  BISHKEK: "BISHKEK_CHUY", "БИШКЕК": "BISHKEK_CHUY",
  CHUY: "BISHKEK_CHUY", CHUI: "BISHKEK_CHUY", "ЧУЙ": "BISHKEK_CHUY", "ЧУЙСКАЯ ОБЛАСТЬ": "BISHKEK_CHUY", BISHKEK_CHUY: "BISHKEK_CHUY",
  OTHER_KG: "OTHER_KG", OTHER_REGION: "OTHER_KG", "ДРУГОЙ РЕГИОН КЫРГЫЗСТАНА": "OTHER_KG",
  FOREIGN: "FOREIGN", "ДРУГАЯ СТРАНА": "FOREIGN"
};

const familyStatusAliases: Record<string, string> = {
  married: "married", "в браке": "married", женат: "married", замужем: "married",
  single: "single", "не женат": "single", "не замужем": "single", "не в браке": "single",
  divorced: "divorced", divorce: "divorced", "в разводе": "divorced", разведен: "divorced", разведён: "divorced", разведена: "divorced"
};

const numericLeadCardKeys = new Set(["vehicleYear", "reportedInvalidVehicleYear", "vehicleValue", "requestedAmount"]);
const booleanLeadCardKeys = new Set([
  "residenceNeedsClarification", "ownerChanged", "plateChanged", "ownerIsLegalEntity", "borrowerIsLegalEntity", "vehicleInCredit", "vehiclePledged", "vehicleArrested", "registrationRestricted", "buyoutRequested", "accidentNotDrivable", "foreignTravelQuestion", "existingContractQuestion", "existingContractPaymentMessage", "borrowerIsOwner", "ownerCanVisit", "vehicleBoughtDuringMarriage", "spouseConsentReady", "spouseConsentAtOffice", "spouseAway", "guarantorAvailable", "guarantorAlternativeDeclined", "visitRequested", "clientPaused", "clientClosed", "declinedDocuments", "declinedCarPhoto", "vehiclePurchasedDuringMarriage", "divorceCertificateReady", "visitConfirmationPending", "handedToManager", "onTheWay", "arrivedAtOffice"
]);

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
