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
import { attachmentFactsForCurrentStage, deriveStageCompletion, effectiveFactsForTurn, isCarPhotoStagePrompt } from "./agent-turn-reconciliation.js";
import { isContextualKnowledgeFollowUpText } from "./contextual-knowledge-follow-up.js";
import { compactKnowledgeForPrompt, hasApprovedKnowledgeMatch, isExistingContractServiceRequest, isMaximumLoanKnowledgeQuestion, isStandaloneProgramSelection, prioritizedKnowledgeForQuestion, selectRelevantDocumentation } from "./documentation-retrieval.js";
import { agentTurnResultSchema, dialogueSummarySchema, knowledgeAnswerSchema, type AgentTurnResult } from "./agent-turn.contracts.js";
import { moneyNormalizationSchema } from "./pipeline.contracts.js";
import { calculateLoanPricing, MINIMUM_VEHICLE_VALUE, type LoanPricing, type LoanPricingSettings } from "./loan-pricing.js";
import { referencesOtherPersonsVehicle, removeOtherPersonsVehicleFacts } from "./lead-card-ownership.js";
import { detectMoneyMentions, formatSomMoney, hasExplicitRequestedAmountMention, resolveMoneyFacts, roundSomAmount } from "./money-normalization.js";
import type { Stage1Message } from "./stage1-store.service.js";

const PROMPT_VERSION = "single-agent-v4";
const NEUTRAL_REPLY = "Извините, сейчас не удалось обработать сообщение. Пожалуйста, напишите ещё раз или обратитесь к сотрудникам компании.";
// Retry transient provider failures and malformed structured payloads before
// falling back to the JSON normalizer or a local recovery path.
const MAX_MODEL_ATTEMPTS = 3;
const MAX_LOG_VALUE_LENGTH = 4000;
const DEFAULT_OFFICE_ADDRESS = "Б. Молодой Гвардии, 22, Бишкек";
const DEFAULT_TWO_GIS_URL = "https://go.2gis.com/Y34m4";
const DEFAULT_GOOGLE_MAPS_URL = "https://maps.app.goo.gl/9xiWLVvdyRgn3Sx4A";
const UNKNOWN_KNOWLEDGE_ANSWER = "К сожалению, у меня нет достоверной информации по этому вопросу. Когда Вы приедете, сотрудники с удовольствием подскажут Вам.";
const WORKFLOW_STAGE_RESPONSE_SENTINEL = "__WORKFLOW_STAGE_RESPONSE__";
// JSON mode validates only that the response is an object, so `{}` is valid
// there. The KB contract must instead be enforced by the provider before the
// response reaches the Zod boundary.
const KNOWLEDGE_RESPONSE_JSON_SCHEMA = {
  name: "knowledge_response",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      reply: { type: "string" },
      answerFound: { type: "boolean" },
      questionUnderstood: { type: "boolean" },
      sourceKeys: { type: "array", items: { type: "string" } },
      requestScope: { type: "string", enum: ["new_loan", "not_new_loan", "unknown"] },
      contextualPolicyRelation: {
        anyOf: [
          { type: "string", enum: ["follow_up", "new_question"] },
          { type: "null" }
        ]
      }
    },
    required: ["reply", "answerFound", "questionUnderstood", "sourceKeys", "requestScope", "contextualPolicyRelation"]
  }
} as const;
const KNOWLEDGE_ROUTER_RESPONSE_JSON_SCHEMA = {
  name: "knowledge_router_response",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { lookup: { type: "boolean" } },
    required: ["lookup"]
  }
} as const;
export const OLDER_VEHICLE_PROGRAM_NOTICE = "По общему правилу мы принимаем в залог автомобили старше 15 лет только на стоянку, но если вы планируете получить займ без изъятия, то мы готовы рассмотреть вашу заявку индивидуально.";
type ContextualKnowledgePolicy = { key: "region_10_refusal" | "previous_assistant_answer"; approvedAnswer: string };
// The complete lead card keeps durable facts, while a compact recent tail is
// enough to resolve conversational references. Keeping this bounded is one of
// the few latency levers that does not weaken application validation.
const MAX_AGENT_RESPONSE_TOKENS = 500;
// Auxiliary classifiers and JSON normalizers have deterministic fallbacks.
// They must never make a client wait for the full dialogue-model timeout.
const AUXILIARY_MODEL_TIMEOUT_MS = 7_000;
const MAX_KNOWLEDGE_ROUTER_ATTEMPTS = 3;
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
  /** Dedicated classifier result for an active monetary confirmation. */
  moneyClarificationDecision?: "accept" | "reject";
  /** A normalized current-turn amount held outside persisted facts until its minimum is confirmed. */
  minimumRequestedAmountCandidate?: number;
  /** A clarification of a previous guarantor prompt which is already invalid under current facts. */
  inactiveGuarantorClarification?: boolean;
  /** Preserves first-contact semantics after obsolete workflow text is suppressed from history. */
  hadPriorAssistantMessage?: boolean;
  conversationId?: string;
  signal?: AbortSignal;
  /** A speculative result for the programme model, started alongside main extraction. */
  programDecisionPrefetch?: Promise<import("../ai/router-ai/router-ai.types.js").RouterAiChatResponse | undefined>;
};

export type PendingMoneyClarificationDecision = {
  decision: "accept" | "reject" | "undecided";
  currency?: Exclude<NormalizedMoneyValue["currency"], "KGS">;
};

@Injectable()
export class AgentTurnService {
  private readonly config = loadAppConfig();
  private readonly logger = new Logger(AgentTurnService.name);
  private readonly auxiliaryModelTimeoutMs = Math.min(this.config.routerAiTimeoutMs, AUXILIARY_MODEL_TIMEOUT_MS);

  constructor(private readonly client: RouterAiClient, private readonly logs?: BackendLogsService) { }

  async classifyPendingMoneyClarification(input: { text?: string; messages: Stage1Message[]; conversationId?: string; signal?: AbortSignal }): Promise<PendingMoneyClarificationDecision | undefined> {
    const lastAssistantMessage = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
    const clientReply = input.text?.trim() ?? "";
    if (!this.client.isConfigured() || !clientReply || !hasPendingMoneyCurrencyClarification(lastAssistantMessage)) return undefined;
    const explicitRejection = clearNegation(clientReply);
    const model = this.config.routerAiNormalizerModel ?? this.config.routerAiTextModel ?? "routerai-text-model-not-configured";
    try {
      const response = await this.client.createChatCompletion({
        model,
        temperature: 0,
        max_tokens: 30,
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Определи смысл ответа клиента только относительно денежного уточнения AI. Верни строго JSON {\"decision\":\"accept\"|\"reject\"|\"undecided\",\"currency\":\"USD\"|\"EUR\"|\"KZT\"|\"RUB\"|null}. Подтверждение суммы, в том числе ответ только названием валюты, означает accept. Отрицание или исправление суммы без нового числа означает reject. Укажи currency только если клиент явно назвал валюту в текущем ответе; иначе null. Нейтральный или неясный ответ — undecided. Не добавляй текст." },
          { role: "user", content: JSON.stringify({ lastAssistantQuestion: lastAssistantMessage, clientReply }) }
        ]
      }, { operation: "money_clarification", timeoutMs: this.auxiliaryModelTimeoutMs, signal: input.signal });
      const parsed = parseAgentJson(response.choices?.[0]?.message?.content);
      const decision = parsed.decision;
      const currency = parsed.currency;
      if (decision !== "accept" && decision !== "reject" && decision !== "undecided") return explicitRejection ? { decision: "reject" } : undefined;
      return {
        decision: decision === "undecided" && explicitRejection ? "reject" : decision,
        ...(currency === "USD" || currency === "EUR" || currency === "KZT" || currency === "RUB"
          ? explicitlyMentionsCurrency(clientReply, currency) ? { currency } : {}
          : {})
      };
    } catch (error) {
      if (input.signal?.aborted) throw error;
      this.logger.warn(`Money-clarification classifier unavailable: ${formatError(error)}`);
      return explicitRejection ? { decision: "reject" } : undefined;
    }
  }

  async normalizeMoney(input: { text?: string; facts: ApplicationFacts; messages: Stage1Message[]; conversationId?: string; signal?: AbortSignal }): Promise<NormalizedMoneyValue[]> {
    if (!this.client.isConfigured() || !input.text?.trim()) return [];
    const model = this.config.routerAiNormalizerModel ?? this.config.routerAiTextModel ?? "routerai-text-model-not-configured";
    const normalizerContext = {
      currentMessage: input.text,
      lastAssistantMessage: [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "",
      pendingMoneyField: pendingMoneyFieldFromHistory(input.messages)
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
      }, { operation: "money_normalization", timeoutMs: this.auxiliaryModelTimeoutMs, signal: input.signal });
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
      const modelValues = discardConflictingSingleAmountRole(parsed.data.values, input.text, input.facts).map((value) => value.currency !== "KGS" && !explicitlyMentionsCurrency(input.text, value.currency)
        ? { ...value, currency: "KGS" as const }
        : value);
      const values = reconcileExplicitMoneyRoles(modelValues, input.text, input.facts);
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
   * A tiny gate before the expensive knowledge answer. It intentionally sees
   * no lead card or KB corpus: only enough dialogue context to distinguish a
   * workflow answer from an independent question.
   */
  async shouldLookupKnowledge(input: {
    messages: Stage1Message[];
    text?: string;
    currentTurnMessages?: Array<{ index: number; text: string }>;
    conversationId?: string;
    signal?: AbortSignal;
  }): Promise<boolean> {
    const currentMessage = input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "";
    if (!this.client.isConfigured() || !currentMessage.trim()) return false;
    const previousAssistantMessage = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
    const model = this.config.routerAiKnowledgeRouterModel
      ?? this.config.routerAiKnowledgeModel
      ?? "routerai-knowledge-router-model-not-configured";
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_KNOWLEDGE_ROUTER_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.client.createChatCompletion({
          model,
          temperature: 0,
          max_tokens: 20,
          reasoning: { enabled: false },
          response_format: { type: "json_schema", json_schema: KNOWLEDGE_ROUTER_RESPONSE_JSON_SCHEMA },
          structured_outputs: true,
          messages: [
            { role: "system", content: loadPrompt("knowledge-router.system.md") },
            { role: "user", content: JSON.stringify({ previousAssistantMessage, currentMessage }) }
          ]
        }, { operation: "knowledge_routing", timeoutMs: this.auxiliaryModelTimeoutMs, signal: input.signal });
        const lookup = parseAgentJson(response.choices?.[0]?.message?.content).lookup === true;
        await this.logs?.log("dialogue.knowledge-router", "Knowledge route decided", {
          conversationId: input.conversationId,
          metadata: { model: response.model ?? model, lookup, currentMessage, attempt }
        });
        return lookup;
      } catch (error) {
        if (input.signal?.aborted) throw error;
        lastError = error;
        if (attempt < MAX_KNOWLEDGE_ROUTER_ATTEMPTS) {
          this.logger.warn(`Knowledge router attempt ${attempt} failed: ${formatError(error)}; retrying`);
        }
      }
    }
    this.logger.warn(`Knowledge router unavailable after ${MAX_KNOWLEDGE_ROUTER_ATTEMPTS} attempts: ${formatError(lastError)}`);
    await this.logs?.warn("dialogue.knowledge-router", "Knowledge route failed; applying local fallback", {
      conversationId: input.conversationId,
      metadata: { model, error: formatError(lastError), currentMessage, attempts: MAX_KNOWLEDGE_ROUTER_ATTEMPTS }
    });
    // The router is an optimisation, not an availability boundary. If it
    // times out, preserve knowledge access for an explicit/FAQ question using
    // the local classifier. Otherwise a transient provider timeout silently
    // turns a question into an ordinary workflow turn and the KB is never
    // called at all.
    const fallbackLookup = isLikelyKnowledgeQuestion(currentMessage)
      || hasApprovedKnowledgeMatch(currentMessage)
      || isOfficeLocationQuestion(currentMessage);
    await this.logs?.log("dialogue.knowledge-router", "Knowledge route fallback applied", {
      conversationId: input.conversationId,
      metadata: { fallbackLookup, currentMessage, reason: "router_unavailable" }
    });
    return fallbackLookup;
  }

  /**
   * Atypical questions do not need the main workflow prompt. This model sees
   * the complete approved corpus and can either cite it faithfully or state
   * honestly that the answer is outside the chat's approved information.
   */
  async answerWithKnowledge(input: {
    messages: Stage1Message[];
    facts: ApplicationFacts;
    settings: object;
    text?: string;
    currentTurnMessages?: Array<{ index: number; text: string }>;
    workflowFollowUp: string;
    isFirstClientMessage?: boolean;
    /** Time of the inbound message for time-dependent approved answers. */
    currentTime?: Date;
    conversationId?: string;
    signal?: AbortSignal;
  }): Promise<{ reply: string; answerFound: boolean; questionUnderstood?: boolean; shouldUseReply?: boolean; requestScope?: "new_loan" | "not_new_loan" | "unknown"; model: string } | undefined> {
    if (!this.client.isConfigured()) return undefined;
    // Calls reach this method only after the lightweight knowledge router
    // selected the turn. The remaining guards still protect against a model
    // misclassifying a workflow fact as an independent question.
    const model = this.config.routerAiKnowledgeModel ?? "routerai-knowledge-model-not-configured";
    const requiredFallbacks = unsupportedKnowledgeFallbacks(input.text ?? "");
    const officeLocationResponse = isOfficeLocationQuestion(input.text)
      ? officeLocationReply(input.settings)
      : undefined;
    const maximumLoanQuestion = isMaximumLoanKnowledgeQuestion(input.text ?? "");
    const maximumLoanChunk = prioritizedKnowledgeForQuestion({
      facts: input.facts,
      currentMessage: input.text,
      messages: input.messages
    }).find((chunk) => chunk.key === "faq_maximum_loan_range");
    const maximumLoanTemplate = maximumLoanChunk && "approvedAnswer" in maximumLoanChunk
      ? maximumLoanChunk.approvedAnswer
      : undefined;
    const contextualPolicy = contextualKnowledgePolicy(input.messages, input.text ?? "");
    const knowledge = prioritizedKnowledgeForQuestion({
      facts: input.facts,
      currentMessage: input.text,
      messages: input.messages
    });
    const context = {
      currentMessage: input.text ?? "",
      isFirstClientMessage: input.isFirstClientMessage === true,
      currentTurnMessages: input.currentTurnMessages ?? (input.text === undefined ? [] : [{ index: 1, text: input.text }]),
      currentTime: input.currentTime?.toISOString(),
      // KB answers may depend on a client statement immediately before a
      // failed/unclear assistant reply. Preserve a short alternating tail,
      // rather than only the last workflow question.
      history: recentKnowledgeHistory(input.messages),
      leadCard: input.facts,
      workflowFollowUp: input.workflowFollowUp,
      existingContractServiceRequest: isExistingContractServiceRequest(input.text ?? ""),
      // Server-owned settings, not model knowledge, are authoritative for
      // office location and map links.
      officeLocationResponse,
      // The FAQ template is a server contract. The orchestrator recognises
      // its two markers and either substitutes current limits or asks for the
      // missing calculation facts after this answer.
      maximumLoanTemplate: maximumLoanQuestion ? maximumLoanTemplate : undefined,
      // A short question after a terminal policy must be classified against
      // that policy before the broad corpus is considered.
      contextualPolicy,
      // Keep the model focused on the approved answer most relevant to this
      // message. The packet always starts with FAQ, then section 3.18 rules,
      // instead of making it search a large, competing corpus by itself.
      // Every approved chunk is retained. This projection removes only
      // server-side retrieval metadata, which otherwise exceeds the model's
      // context window before it can produce an answer.
      knowledge: compactKnowledgeForPrompt(knowledge),
      requiredFallbacks
    };
    try {
      throwIfAborted(input.signal);
      const response = await this.client.createChatCompletion({
        model,
        temperature: 0,
        max_tokens: MAX_AGENT_RESPONSE_TOKENS,
        reasoning: { enabled: false },
        response_format: { type: "json_schema", json_schema: KNOWLEDGE_RESPONSE_JSON_SCHEMA },
        structured_outputs: true,
        messages: [
          { role: "system", content: loadPrompt("knowledge-agent.system.md") },
          { role: "user", content: JSON.stringify(context) }
        ]
      }, { operation: "knowledge_answer", timeoutMs: this.config.routerAiTimeoutMs, signal: input.signal });
      const responseChoice = response.choices?.[0];
      const rawModelResponse = responseChoice?.message?.content;
      const parsed = knowledgeAnswerSchema.safeParse(parseAgentJson(rawModelResponse));
      if (!parsed.success) {
        await this.logs?.warn("dialogue.knowledge-model", "Knowledge model response failed schema validation", {
          conversationId: input.conversationId,
          metadata: {
            model: response.model ?? model,
            currentMessage: input.text ?? "",
            // Use null rather than undefined: JSON serialization drops
            // undefined fields, which hid the actual gateway response in
            // production logs.
            rawModelResponse: rawModelResponse ?? null,
            responseChoice: responseChoice ?? null,
            // RouterAI may return a successful HTTP response containing an
            // error envelope instead of `choices`. Preserve that envelope so
            // this failure is diagnosable without reproducing the request.
            routerAiResponse: response,
            schemaIssues: parsed.error.issues
          }
        });
        throw new Error(`Knowledge response does not match schema: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
      }
      const questionText = input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "";
      const explicitQuestion = isExplicitQuestionText(questionText);
      const standaloneProgramSelection = isStandaloneProgramSelection(questionText);
      const lastAssistantQuestion = lastActiveAssistantMessage(input.messages);
      const isWorkflowFactResponse = isResidenceWorkflowFactResponse(
        questionText,
        lastAssistantQuestion,
        input.workflowFollowUp
      );
      // Natural service requests such as «Есть мастер по ремонту у вас» are
      // questions even without «ли» or a question mark. They must receive
      // the approved no-information fallback rather than the workflow
      // sentinel when the corpus has no confirmed answer.
      const knowledgeQuestionUnderstood = !isWorkflowFactResponse
        && !standaloneProgramSelection
        && (
          parsed.data.questionUnderstood === true
          || isLikelyKnowledgeQuestion(questionText)
          // A server-recognised unsupported topic is still a question even
          // when the model incorrectly labels it as a workflow fact. Without
          // this, its honest raw fallback becomes the workflow sentinel and
          // an unrelated main-agent reply can win delivery priority.
          || requiredFallbacks.length > 0
        );
      const knownKnowledgeKeys = new Set(knowledge.map((chunk) => chunk.key));
      // FAQ chunks travel to the model with an `faq_` transport prefix, but
      // models occasionally cite the stable source name without it. Restore
      // that prefix only when it resolves to a key in this exact packet.
      const sourceKeys = normalizeKnowledgeSourceKeys(parsed.data.sourceKeys ?? [], knownKnowledgeKeys);
      const hasInvalidSourceKeys = parsed.data.answerFound && (
        sourceKeys.length === 0
        || sourceKeys.some((key) => key !== "lead_card" && key !== "conversation_context" && !knownKnowledgeKeys.has(key))
      );
      // A maximum range is a server calculation, but only the current client
      // question may select that branch. A model can cite the maximum FAQ as
      // nearby context while its raw answer addresses another topic (for
      // example, a corrected vehicle value). A citation alone must never
      // replace that answer with a limit template.
      // `questionUnderstood=false` is the KB protocol for a workflow fact.
      // A `lead_card` source without a request is also a prohibited summary.
      // Never expose arbitrary prose in either case, even if a model
      // incorrectly also marks `answerFound=true`.
      const modelReturnedWorkflowStageResponse = isWorkflowFactResponse || standaloneProgramSelection || (!knowledgeQuestionUnderstood && (
        parsed.data.questionUnderstood === false || sourceKeys?.includes("lead_card") === true
      ));
      const ungroundedCreditAnswer = isUngroundedVehicleCreditAnswer(parsed.data.reply, input.text ?? "");
      // The region-10 refusal has a single, narrow triggering condition. A
      // model/year/value supplied for the application (for example «Rio 2020
      // пять миллионов») must never be interpreted as a registration region.
      // Do not let the KB promote that rule unless the client named region 10
      // in this turn or in the immediately relevant history.
      // Keep a continuation of a client statement about region 10
      // valid, including when the previous assistant message was an
      // unhelpful fallback. The short history window is the same one passed
      // to the KB for that recovery.
      const followsExplicitRegion10 = input.messages.slice(-8)
        .some((message) => message.author === "client" && hasExplicitRegion10Mention(message.body));
      const ungroundedRegion10Answer = sourceKeys?.includes("docx_0381") === true
        && !hasExplicitRegion10Mention(questionText)
        && !followsExplicitRegion10;
      const modelAnswerFound = !hasInvalidSourceKeys && !modelReturnedWorkflowStageResponse && !ungroundedCreditAnswer && !ungroundedRegion10Answer
        && parsed.data.answerFound;
      const answerFound = modelAnswerFound;
      // The KB owns these answers, but its prose can still repeat the rule
      // before stating the already-known result. Normalize that KB payload
      // to the short answer contract; do not append a separate server reply.
      const normalizedKnowledgeReply = modelAnswerFound
        ? normalizeConciseEligibilityReply(parsed.data.reply, input.facts, questionText, sourceKeys)
        : parsed.data.reply;
      // The complete corpus is available to the KB model on every turn. It,
      // rather than a keyword/retrieval filter, decides which approved rule
      // answers the client's wording. Only live office settings remain
      // server-owned because their values are configuration, not KB prose.
      const knowledgeReply = modelReturnedWorkflowStageResponse || ungroundedRegion10Answer
        ? WORKFLOW_STAGE_RESPONSE_SENTINEL
        : contextualPolicy?.key === "region_10_refusal" && parsed.data.contextualPolicyRelation === "follow_up"
        // The policy is server-approved; keep a model from blending in a
        // semantically nearby but unrelated rule such as the 15-year policy.
        ? contextualPolicy.approvedAnswer
        : modelAnswerFound
          ? removeInternalPricingInstruction(officeLocationResponse ?? ensureGeneralRateCoverage(normalizedKnowledgeReply, input.text))
          // A fact supplied for the application is intentionally not a KB
          // answer. Keep it empty so the workflow model remains the sole
          // author of the client-facing continuation.
          : parsed.data.questionUnderstood === false
            ? parsed.data.reply
            : requiredFallbacks[0] ?? UNKNOWN_KNOWLEDGE_ANSWER;
      // The maximum range is server-owned, but it is only one answer in a
      // multi-question turn. Keep the canonical range and retain all other
      // independent KB answers (rate, office amenities, vehicle conditions).
      // Explicit fallbacks protect unanswered parts only; they never bypass
      // the KB call itself.
      const replyWithFallbacks = appendKnowledgeFallbacks(knowledgeReply, requiredFallbacks);
      const onlyMaximumLoanSource = sourceKeys.length > 0
        && sourceKeys.every((key) => key === "faq_maximum_loan_range");
      const reply = maximumLoanQuestion && maximumLoanTemplate
        ? mergeMaximumLoanTemplateWithOtherAnswers(maximumLoanTemplate, onlyMaximumLoanSource ? "" : replyWithFallbacks)
        : replyWithFallbacks;
      // This marker is protocol-only: it means that the KB was invoked but
      // the current message belongs to the workflow. It must never gain
      // delivery priority merely because a money statement contains «нужно».
      const isWorkflowStageSentinel = reply.trim() === WORKFLOW_STAGE_RESPONSE_SENTINEL;
      const shouldUseReply = !isWorkflowStageSentinel
        && (knowledgeQuestionUnderstood || explicitQuestion);
      await this.logs?.log("dialogue.knowledge-model", "Knowledge model response received", {
        conversationId: input.conversationId,
        metadata: {
          model: response.model ?? model,
          currentMessage: input.text ?? "",
          modelAnswerFound: parsed.data.answerFound,
          answerFound,
          sourceKeys,
          invalidSourceKeys: hasInvalidSourceKeys,
          requestScope: parsed.data.requestScope,
          explicitQuestion,
          questionUnderstood: knowledgeQuestionUnderstood,
          replyMode: answerFound ? "approved_answer" : "knowledge_fallback",
          // Keep both values: the first makes a model mistake diagnosable,
          // while the second shows the exact KB text passed to orchestration
          // after server-owned normalisation (for example max-limit template).
          rawKnowledgeReply: parsed.data.reply,
          selectedKnowledgeReply: reply
        }
      });
      return { reply, answerFound, questionUnderstood: knowledgeQuestionUnderstood, shouldUseReply, requestScope: parsed.data.requestScope, model: response.model ?? model };
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

  /**
   * The workflow and pricing code own the response plan. This last model is
   * deliberately a formatter, not a decision maker: it may make the plan
   * sound natural, but it cannot add a fact, calculation, product, or a new
   * question. A malformed or expanded reply is discarded server-side.
   */
  async renderClientReply(input: {
    responsePlan: string;
    clientMessage?: string;
    facts: ApplicationFacts;
    conversationId?: string;
    signal?: AbortSignal;
  }): Promise<{ reply: string; model: string; rendered: boolean }> {
    const responsePlan = input.responsePlan.trim();
    const fallback = { reply: responsePlan, model: "server-response-plan", rendered: false };
    if (!responsePlan || !this.client.isConfigured()) return fallback;
    const model = this.config.routerAiOutputModel ?? this.config.routerAiTextModel ?? "routerai-output-model-not-configured";
    try {
      const response = await this.client.createChatCompletion({
        model,
        temperature: 0,
        max_tokens: MAX_AGENT_RESPONSE_TOKENS,
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "Вы — финальный рендерер ответа клиенту. Верните строго JSON {\"reply\":string}. Единственный источник содержания — responsePlan. Можно только сделать формулировку естественной и краткой, не меняя смысла. Запрещено добавлять или убирать факты, суммы, валюты, условия, продукты, объяснения, приветствия, выводы и вопросы. Нельзя пересказывать сообщение клиента. Если plan содержит вопрос, сохраните ровно этот один вопрос; если вопроса нет, не задавайте вопрос. Если нет безопасного улучшения, верните responsePlan дословно."
          },
          {
            role: "user",
            content: JSON.stringify({ responsePlan, clientMessage: input.clientMessage ?? "", recognizedFacts: input.facts })
          }
        ]
      }, { operation: "output_rendering", timeoutMs: this.config.routerAiTimeoutMs, signal: input.signal });
      const reply = parseRendererReply(response.choices?.[0]?.message?.content ?? undefined);
      if (!reply || !isSafeRenderedReply(reply, responsePlan)) {
        await this.logs?.warn("dialogue.output-renderer", "Output renderer response rejected; using server response plan", {
          conversationId: input.conversationId,
          metadata: { model: response.model ?? model, responsePlan, rawModelResponse: response.choices?.[0]?.message?.content }
        });
        return fallback;
      }
      await this.logs?.log("dialogue.output-renderer", "Server response plan rendered", {
        conversationId: input.conversationId,
        metadata: { model: response.model ?? model }
      });
      return { reply, model: response.model ?? model, rendered: true };
    } catch (error) {
      if (input.signal?.aborted) throw error;
      const message = formatError(error);
      this.logger.warn(`Output renderer unavailable: ${message}`);
      await this.logs?.warn("dialogue.output-renderer", "Output renderer request failed; using server response plan", {
        conversationId: input.conversationId,
        metadata: { model, error: message }
      });
      return fallback;
    }
  }

  /** Generates a private snapshot of the lead card after facts change. */
  async summarizeDialogue(input: {
    messages: Stage1Message[];
    facts: ApplicationFacts;
    conversationId?: string;
    signal?: AbortSignal;
  }): Promise<string | undefined> {
    if (!this.client.isConfigured()) return undefined;
    const model = this.config.routerAiKnowledgeModel ?? "routerai-summary-model-not-configured";
    try {
      const response = await this.client.createChatCompletion({
        model,
        temperature: 0,
        max_tokens: 400,
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: loadPrompt("dialogue-summary.system.md") },
          {
            role: "user", content: JSON.stringify({
              messages: input.messages.map(({ author, body, createdAt }) => ({ author, text: body, createdAt })),
              finalFacts: input.facts
            })
          }
        ]
      }, { operation: "dialogue_summary", timeoutMs: this.config.routerAiTimeoutMs, signal: input.signal });
      const parsed = dialogueSummarySchema.safeParse(parseAgentJson(response.choices?.[0]?.message?.content));
      if (!parsed.success) throw new Error("Dialogue summary response does not match schema");
      await this.logs?.log("dialogue.summary-model", "Dialogue summary generated", {
        conversationId: input.conversationId,
        metadata: { model: response.model ?? model, messageCount: input.messages.length }
      });
      return parsed.data.summary.trim();
    } catch (error) {
      if (input.signal?.aborted) throw error;
      await this.logs?.warn("dialogue.summary-model", "Dialogue summary generation failed", {
        conversationId: input.conversationId,
        metadata: { model, error: formatError(error) }
      });
      return undefined;
    }
  }

  async run(input: AgentTurnInput): Promise<{ result?: AgentTurnResult; reply: string; model: string; promptVersion: string; error?: string }> {
    // This boundary runs before the main model and every semantic classifier.
    // A previously sent guarantor prompt is invalid state once the persisted
    // programme/residence makes a guarantor unnecessary, so do not expose it
    // as the current action for another model to repeat or interpret.
    const rawLastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
    const currentClientText = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
    const inactiveGuarantorClarification = !requiresGuarantorForFacts(input.facts)
      && isGuarantorQuestion(rawLastAssistant)
      && isGuarantorContextClarification(currentClientText);
    input = {
      ...input,
      inactiveGuarantorClarification,
      hadPriorAssistantMessage: input.messages.some((message) => message.author === "ai"),
      messages: suppressInactiveGuarantorPrompts(input.messages, input.facts)
    };
    if (!this.client.isConfigured()) {
      await this.logFallback(input, "routerai_not_configured", []);
      return { reply: NEUTRAL_REPLY, model: "unconfigured", promptVersion: PROMPT_VERSION, error: "routerai_not_configured" };
    }
    input = { ...input, programDecisionPrefetch: this.prefetchProgramDecision(input) };
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
        const userMessage = { role: "user" as const, content: buildMessage(input, !retryWithoutImages) };
        const modelRequest = {
          ...request,
          messages: [{ role: "system" as const, content: systemPrompt }, userMessage]
        };
        attemptRequest = modelRequest;
        const response = await this.client.createChatCompletion(modelRequest, { operation: "main_agent", timeoutMs: this.config.routerAiTimeoutMs, signal: input.signal });
        const rawAgentResponse = response.choices?.[0]?.message?.content;
        lastRawAgentResponse = typeof rawAgentResponse === "string" ? rawAgentResponse : undefined;
        agentResponse = typeof rawAgentResponse === "string" ? rawAgentResponse : undefined;
        if (this.logs?.log) {
          await this.logs.log("dialogue.main-model", "Main model response received", {
            conversationId: input.conversationId,
            metadata: { attempt, model: response.model ?? request.model, request: attemptRequest, rawModelResponse: rawAgentResponse }
          });
        }
        const payload = normalizeAgentPayload(parseAgentJson(typeof rawAgentResponse === "string" ? rawAgentResponse : undefined), input.attachments);
        const parsed = agentTurnResultSchema.safeParse(payload);
        if (!parsed.success) {
          const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
          const state = payload.dialogueState && typeof payload.dialogueState === "object"
            ? (payload.dialogueState as Record<string, unknown>).stage
            : undefined;
          throw new Error(`Agent response does not match AgentTurnResult (${issues}; stage=${JSON.stringify(state)}; targetEvent=${JSON.stringify(payload.targetEvent)})`);
        }
        const result = finalizeAgentPayload(await this.resolveSemanticClarifications(parsed.data, input), input);
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
      }
    }
    if (lastRawAgentResponse) {
      const repaired = await this.normalizeFailedResponse(input, lastRawAgentResponse, lastError);
      if (repaired) {
        this.logger.warn(`JSON normalizer repaired the response after ${MAX_MODEL_ATTEMPTS} rejected main-agent attempts (model=${repaired.model})`);
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

  private async resolveSemanticClarifications(parsed: AgentTurnResult, input: AgentTurnInput): Promise<AgentTurnResult> {
    const limitChoiceNormalized = await this.resolveLimitChoice(parsed, input);
    const programNormalized = await this.resolveProgramDecision(limitChoiceNormalized, input);
    const optionalStageNormalized = await this.resolveOptionalStageDecision(programNormalized, input);
    const documentsNormalized = await this.resolveDocumentIdentityFacts(optionalStageNormalized, input);
    const familyNormalized = await this.resolveUnofficialMarriageStatus(documentsNormalized, input);
    const residenceNormalized = await this.normalizeResidenceLocality(familyNormalized, input);
    const divorceTimingResolved = await this.resolveDivorcePurchaseTiming(residenceNormalized, input);
    const officeResolved = await this.resolveOfficeConsent(await this.resolveGuarantorDecision(await this.resolveResidenceClarification(divorceTimingResolved, input), input), input);
    return this.resolveVisitTimeAvailability(await this.resolveFinalQuestionsDecision(officeResolved, input), input);
  }

  /** A visit-time deferral is a valid stage answer, not an invitation for the
   * conversational model to repeat the same time question. The classifier is
   * deliberately scoped to that one active prompt; regex below is an outage
   * fallback for short, unambiguous phrases. */
  private async resolveVisitTimeAvailability(parsed: AgentTurnResult, input: AgentTurnInput): Promise<AgentTurnResult> {
    if (!deriveStageCompletion(input.facts).readyForVisit) return parsed;
    const lastAssistant = lastActiveAssistantMessage(input.messages);
    if (!isVisitSchedulingQuestion(lastAssistant)) return parsed;
    const clientReply = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
    if (!clientReply) return parsed;
    // The conversational model does not own this transient decision. Only
    // the scoped normalizer below (or its deterministic fallback) may set it.
    const normalizedParsed = { ...parsed, visitTimeAvailability: undefined };
    try {
      const response = await this.client.createChatCompletion({
        model: this.config.routerAiNormalizerModel ?? this.config.routerAiTextModel ?? "routerai-text-model-not-configured",
        temperature: 0, max_tokens: 30, reasoning: { enabled: false }, response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Ты нормализуешь только ответ клиента на вопрос о времени визита. Верни JSON {\"visitTimeAvailability\":\"known\"|\"unknown\"|\"not_a_visit_answer\"}. known: клиент назвал время, включая приблизительное («примерно в 5»). unknown: явно говорит, что время пока неизвестно («по времени пока не знаю», «как только смогу — сообщу»). Не извлекай и не придумывай время." },
          { role: "user", content: JSON.stringify({ lastAssistant, clientReply }) }
        ]
      }, { operation: "visit_time_classification", timeoutMs: this.auxiliaryModelTimeoutMs, signal: input.signal });
      const decision = parseAgentJson(response.choices?.[0]?.message?.content).visitTimeAvailability;
      if (decision === "known" || decision === "unknown" || decision === "not_a_visit_answer") {
        return decision === "unknown"
          ? {
            ...normalizedParsed,
            visitTimeAvailability: decision,
            leadCardPatch: { ...normalizedParsed.leadCardPatch, clientPaused: false },
            dialogueState: { stage: "SCHEDULING_VISIT", status: "need_more_data", nextAction: "schedule_visit" }
          }
          : { ...normalizedParsed, visitTimeAvailability: decision };
      }
    } catch (error) {
      if (input.signal?.aborted) throw error;
      this.logger.warn(`Visit-time classifier unavailable: ${formatError(error)}`);
    }
    return visitTimeUnavailableFallback(clientReply)
      ? {
        ...normalizedParsed,
        visitTimeAvailability: "unknown",
        leadCardPatch: { ...normalizedParsed.leadCardPatch, clientPaused: false },
        dialogueState: { stage: "SCHEDULING_VISIT", status: "need_more_data", nextAction: "schedule_visit" }
      }
      : normalizedParsed;
  }

  /**
   * Civil/unregistered partnerships are not an official marriage for this
   * workflow. The semantic classifier is primary because clients often
   * describe that status over several messages; the narrow text fallback is
   * used only when the classifier is unavailable or returns no decision.
   */
  private async resolveUnofficialMarriageStatus(parsed: AgentTurnResult, input: AgentTurnInput): Promise<AgentTurnResult> {
    const clientReply = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
    const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
    // A past-tense marriage statement answers the current-status question
    // directly. It must win before a general model can mistake the words
    // «в браке» for a present marriage.
    if (isFamilyStatusQuestion(lastAssistant) && isPastMarriageStatusReply(clientReply)) {
      return { ...parsed, leadCardPatch: { ...parsed.leadCardPatch, familyStatus: "divorced" } };
    }
    if (!looksLikeUnofficialMarriageStatement(clientReply) && !isFamilyStatusQuestion(lastAssistant)) return parsed;
    const fallback = unofficialMarriageStatusFallback(clientReply);
    try {
      const response = await this.client.createChatCompletion({
        model: this.config.routerAiNormalizerModel ?? this.config.routerAiTextModel ?? "routerai-text-model-not-configured",
        temperature: 0, max_tokens: 30, reasoning: { enabled: false }, response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Определи только текущий официальный семейный статус клиента из его реплики и последнего вопроса AI. Верни JSON {\"familyStatus\":\"single\"|\"married\"|\"divorced\"|null}. Гражданский брак, совместная жизнь, дети без официальной регистрации, фразы «официально не расписаны», «брак не регистрировал» означают single. Прошедшее время о браке — «в браке был», «была замужем», «был женат», «раньше состоял в браке» — означает divorced, если клиент не сообщил явно о нынешнем браке. «в разводе, но сейчас снова женат» означает married. Не додумывай статус." },
          { role: "user", content: JSON.stringify({ previousFamilyStatus: input.facts.familyStatus ?? null, lastAssistantQuestion: lastAssistant, clientReply }) }
        ]
      }, { operation: "unofficial_marriage_classification", timeoutMs: this.auxiliaryModelTimeoutMs, signal: input.signal });
      const familyStatus = parseAgentJson(response.choices?.[0]?.message?.content).familyStatus;
      if (familyStatus === "single" || familyStatus === "married" || familyStatus === "divorced") {
        return { ...parsed, leadCardPatch: { ...parsed.leadCardPatch, familyStatus } };
      }
    } catch (error) {
      if (input.signal?.aborted) throw error;
      this.logger.warn(`Unofficial-marriage classifier unavailable: ${formatError(error)}`);
    }
    return fallback ? { ...parsed, leadCardPatch: { ...parsed.leadCardPatch, familyStatus: fallback } } : parsed;
  }

  /** A narrow vision pass prevents the prose model from dropping a readable
   * name or a second document shown in the same photograph. */
  private async resolveDocumentIdentityFacts(parsed: AgentTurnResult, input: AgentTurnInput): Promise<AgentTurnResult> {
    const imageAttachments = input.attachments.filter((attachment) =>
      Boolean(attachment.contentBase64) && Boolean(imageAttachmentMediaType(attachment))
    );
    // A name returned by the main conversational pass is only a provisional
    // extraction.  It must not prevent the focused document pass from filling
    // (or correcting) the field: the latter sees the original image and has a
    // deliberately narrow ID/STS-only contract.  A name already persisted on
    // the card, however, belongs to a previous verified turn and is retained.
    const hasClientName = Boolean(input.facts.fullName);
    // FIO extraction is independent from document-side recognition and from
    // the current workflow prompt. The client can attach ID/STS immediately
    // after choosing a programme, before the server has sent its document
    // question; skipping the vision pass here loses readable names forever.
    // Do not use an already known FIO as a reason to skip the pass: document
    // sides and owner data are separate outcomes as well.
    if (imageAttachments.length === 0) return parsed;

    try {
      const response = await this.client.createChatCompletion({
        model: this.config.routerAiVisionModel ?? this.config.routerAiTextModel ?? "routerai-vision-model-not-configured",
        temperature: 0,
        max_tokens: 500,
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Ты — точный классификатор каждого приложенного изображения и OCR документов Кыргызстана. Верни строго JSON {\"fullName\":string|null,\"attachments\":[{\"attachmentId\":string,\"type\":\"id_front\"|\"id_back\"|\"vehicle_registration_front\"|\"vehicle_registration_back\"|\"car\"|\"unknown\"|\"poor_quality\",\"documentTypes\":[\"id_front\"|\"id_back\"|\"vehicle_registration_front\"|\"vehicle_registration_back\"],\"status\":\"received\"|\"poor_quality\"}]}. Верни ровно один объект attachments для КАЖДОГО attachmentId из входа. Не пропускай фото: если тип нельзя надёжно определить, поставь unknown; если изображение слишком размыто/тёмное для классификации — poor_quality со status poor_quality. type — основной, самый заметный тип файла. documentTypes — ВСЕ видимые стороны ID и СТС в этом изображении; их может быть несколько, например [\"id_back\",\"vehicle_registration_front\"]. ID — физический ID/паспорт или его экран в Tunduk; СТС — свидетельство о регистрации ТС или его экран в Tunduk; car — видимый автомобиль без документа. Сторону ID/СТС указывай только когда она видна, иначе unknown и пустой documentTypes. Из документов можно извлечь только полное ФИО клиента с лицевой стороны ID/паспорта: fullName заполняй исключительно кириллицей. Если ФИО написано латиницей, транслитерируй его в кириллицу; заполняй поле только если ФИО читается целиком. Из СТС не извлекай и не передавай никакие данные, включая ФИО собственника, марку, модель, год, номер и регистрацию. Не угадывай и не сокращай ФИО, не используй имя файла как источник данных и не добавляй текст вне JSON." },
          {
            role: "user",
            content: [
              { type: "text" as const, text: JSON.stringify({ attachmentIds: imageAttachments.map((attachment) => attachment.id) }) },
              ...imageAttachments.map((attachment) => ({
                type: "image_url" as const,
                image_url: { url: `data:${imageAttachmentMediaType(attachment)};base64,${attachment.contentBase64}`, detail: "high" as const }
              }))
            ]
          }
        ]
      }, { operation: "document_identity_extraction", timeoutMs: this.auxiliaryModelTimeoutMs, signal: input.signal });
      const extracted = parseDocumentIdentityExtraction(response.choices?.[0]?.message?.content ?? undefined);
      // The focused pass sees the original image and has a deliberately
      // narrow classification contract. When it returns the keyed format it
      // therefore owns the type persisted for every image. A missing model
      // row still becomes `unknown`, rather than inheriting an unrelated
      // conversational guess or silently disappearing from recognition.
      const focusedAttachments = extracted.hasAttachmentClassification
        ? mergeFocusedAttachmentClassification(parsed.attachments, imageAttachments, extracted.attachments)
        : parsed.attachments;
      const documents = {
        ...(parsed.leadCardPatch.documents ?? {}),
        ...Object.fromEntries([
          ...Object.entries(extracted.documents).filter(([, present]) => present).map(([type]) => [type, "received"]),
          ...extracted.attachments.flatMap((attachment) =>
            attachment.documentTypes.map((type) => [type, attachment.status === "poor_quality" ? "poor_quality" : "received"])
          ),
          ...focusedAttachments
            .filter((attachment) => isDocumentAttachmentType(attachment.type))
            .map((attachment) => [attachment.type, attachment.status === "poor_quality" ? "poor_quality" : "received"])
        ])
      };
      // An ID/STS scan is never evidence for vehicle or owner facts. The
      // focused pass is the only document reader allowed to write a fact,
      // and its one allowed fact is a complete Cyrillic client name from ID.
      const documentScan = hasRecognizedDocument(extracted.attachments);
      const safeParsed = documentScan ? removeDocumentDerivedFacts(parsed) : parsed;
      const fullName = normalizeDocumentFullName(extracted.fullName);
      const patch = {
        ...(hasClientName || !fullName ? {} : { fullName }),
        ...(Object.keys(documents).length > 0 ? { documents } : {})
      };
      return Object.keys(patch).length > 0
        ? { ...safeParsed, attachments: focusedAttachments, leadCardPatch: { ...safeParsed.leadCardPatch, ...patch } }
        : focusedAttachments === safeParsed.attachments ? safeParsed : { ...safeParsed, attachments: focusedAttachments };
    } catch (error) {
      if (input.signal?.aborted) throw error;
      this.logger.warn(`Document identity extraction unavailable: ${formatError(error)}`);
      return parsed;
    }
  }

  /** The short answer is meaningful only in the immediately preceding
   * divorce purchase-timing question. A semantic classifier owns rich forms;
   * deterministic phrases below are its outage/undecided fallback. */
  private async resolveDivorcePurchaseTiming(parsed: AgentTurnResult, input: AgentTurnInput): Promise<AgentTurnResult> {
    const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
    const clientReply = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
    // A client can correct the old divorce status while answering this
    // question. "В текущем браке" describes the present official status,
    // not the date of purchase in the previous marriage.
    if (currentMarriageStatusCorrection(clientReply)) {
      return { ...parsed, leadCardPatch: { ...parsed.leadCardPatch, familyStatus: "married" } };
    }
    if (input.facts.familyStatus !== "divorced" || !isDivorcePurchaseTimingQuestion(lastAssistant)) return parsed;
    if (!clientReply) return parsed;
    const apply = (duringMarriage: boolean) => ({
      ...parsed,
      leadCardPatch: {
        ...parsed.leadCardPatch,
        familyStatus: "divorced" as const,
        vehicleBoughtDuringMarriage: duringMarriage,
        vehiclePurchasedDuringMarriage: duringMarriage
      }
    });
    try {
      const response = await this.client.createChatCompletion({
        model: this.config.routerAiNormalizerModel ?? this.config.routerAiTextModel ?? "routerai-text-model-not-configured",
        temperature: 0, max_tokens: 30, reasoning: { enabled: false }, response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Определи смысл ответа клиента только на вопрос: автомобиль куплен до брака, во время брака или после развода. Верни JSON {\"timing\":\"before_marriage\"|\"during_marriage\"|\"after_divorce\"|\"undecided\"|\"not_an_answer\"}. «в», «во», «во время», «в браке», «во время брака» означают during_marriage. «до», «до брака», «раньше брака», «до того как поженились», «наверное до ещё» означают before_marriage. «после», «не в», «не в браке», «вне брака», «после развода» означают after_divorce. Отдельный вопрос клиента — not_an_answer. Не меняй семейное положение и не добавляй текст." },
          { role: "user", content: JSON.stringify({ questionAsked: lastAssistant, clientReply }) }
        ]
      }, { operation: "divorce_purchase_timing", timeoutMs: this.auxiliaryModelTimeoutMs, signal: input.signal });
      const timing = parseAgentJson(response.choices?.[0]?.message?.content).timing;
      if (timing === "during_marriage") return apply(true);
      if (timing === "before_marriage" || timing === "after_divorce") return apply(false);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      this.logger.warn(`Divorce purchase-timing classifier unavailable: ${formatError(error)}`);
    }
    const fallback = divorcePurchaseTimingFallback(clientReply);
    return fallback === undefined ? parsed : apply(fallback);
  }

  /**
   * Documents and vehicle photos are optional stages, but their response must
   * still be interpreted against the precise outstanding question. The model
   * is primary here; the existing narrow regexes remain outage fallbacks in
   * finalizeAgentPayload.
   */
  private async resolveOptionalStageDecision(parsed: AgentTurnResult, input: AgentTurnInput): Promise<AgentTurnResult> {
    const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
    const action = isDocumentRequest(lastAssistant) ? "documents" : isCarPhotoRequest(lastAssistant) ? "car_photo" : undefined;
    if (!action) return parsed;
    const clientReply = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
    if (!clientReply || input.attachments.length > 0) return parsed;
    try {
      const response = await this.client.createChatCompletion({
        model: this.config.routerAiNormalizerModel ?? this.config.routerAiTextModel ?? "routerai-text-model-not-configured",
        temperature: 0, max_tokens: 30, reasoning: { enabled: false }, response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Определи смысл реплики клиента только относительно активного действия AI. Верни JSON {\"decision\":\"accept\"|\"reject\"|\"undecided\"|\"not_an_answer\"}. accept — клиент отправит или уже готов отправить запрошенные файлы; reject — явно отказывается или откладывает их; not_an_answer — клиент задал отдельный вопрос или изменил другой факт; undecided — смысла недостаточно. Не додумывай ответ и не добавляй текст." },
          { role: "user", content: JSON.stringify({ action, questionAsked: lastAssistant, clientReply }) }
        ]
      }, { operation: "optional_stage_decision", timeoutMs: this.auxiliaryModelTimeoutMs, signal: input.signal });
      const decision = parseAgentJson(response.choices?.[0]?.message?.content).decision;
      if (decision !== "reject") return parsed;
      return {
        ...parsed,
        leadCardPatch: {
          ...parsed.leadCardPatch,
          ...(action === "documents" ? { declinedDocuments: true } : { declinedCarPhoto: true })
        }
      };
    } catch (error) {
      if (input.signal?.aborted) throw error;
      this.logger.warn(`Optional-stage classifier unavailable: ${formatError(error)}`);
      return parsed;
    }
  }

  /**
   * The amount-limit branch is a server offer, not ordinary programme
   * collection. A one-word response such as «стоянка» must therefore be
   * interpreted against that offer by a dedicated JSON normalizer, rather
   * than hoping the main conversational model supplies `limitChoice`.
   */
  private async resolveLimitChoice(parsed: AgentTurnResult, input: AgentTurnInput): Promise<AgentTurnResult> {
    const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
    const clientReply = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
    if (!clientReply || !isAmountLimitChoiceQuestion(lastAssistant)) return parsed;
    const singleProgrammeOffer = isSingleProgrammeLimitOffer(lastAssistant);
    const fallbackChoice = singleProgrammeOffer
      ? singleProgrammeLimitChoiceFromClearReply(clientReply)
      : limitChoiceFromClearReply(clientReply);
    // A direct FAQ such as «а кофе есть в офисе?» does not answer the limit
    // offer. The main agent already routes it to knowledge; do not add a
    // second, sequential classifier request just to rediscover "undecided".
    // Keep the classifier for an actual programme/limit choice, including
    // conversational forms without an explicit programme name.
    if ((isExplicitQuestionText(clientReply) || isLikelyKnowledgeQuestion(clientReply))
      && fallbackChoice === "undecided"
      && programFromExplicitReply(clientReply) === undefined) return parsed;
    if (!this.client.isConfigured()) return fallbackChoice === "undecided" ? parsed : { ...parsed, limitChoice: fallbackChoice };
    try {
      const response = await this.client.createChatCompletion({
        model: this.config.routerAiNormalizerModel ?? this.config.routerAiTextModel ?? "routerai-text-model-not-configured",
        temperature: 0,
        max_tokens: 60,
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system", content: singleProgrammeOffer
              ? "Интерпретируй ответ клиента только на серверное предложение продолжить по уже выбранной программе на меньшую сумму. Верни строго JSON {\"choice\":\"keep_car\"|\"parking\"|\"undecided\",\"hasOtherStageAnswer\":boolean,\"question\":string|null}. `keep_car` означает согласие принять предложенный лимит — в том числе «да», «ок», «хорошо», «подходит». `undecided` означает отказ или неясный ответ. `parking` не выбирай, если клиент явно не просит сменить программу на стоянку. Если клиент одновременно задаёт иной вопрос или меняет иной факт, hasOtherStageAnswer=true; question содержит только этот вопрос. Не придумывай выбор."
              : "Интерпретируй ответ клиента только на серверную развилку лимита: либо снизить сумму по программе без изъятия, либо перейти на охраняемую стоянку. Верни строго JSON {\"choice\":\"keep_car\"|\"parking\"|\"undecided\",\"hasOtherStageAnswer\":boolean,\"question\":string|null}. `parking` — клиент выбирает стоянку: «стоянка», «на стоянку», «парковка», «со стоянкой». `keep_car` — без изъятия или уменьшение суммы: «без изъятия», «оставляю машину у себя», «уменьшаем сумму»; а также ясное согласие И ясный отказ на эту развилку — в обоих случаях сервер оставляет без изъятия и снижает сумму до предложенного лимита. Если клиент одновременно задаёт иной вопрос или меняет иной факт, hasOtherStageAnswer=true; question содержит только этот вопрос. Не придумывай выбор."
          },
          { role: "user", content: JSON.stringify({ limitOffer: lastAssistant, clientReply }) }
        ]
      }, { operation: "limit_choice", timeoutMs: this.auxiliaryModelTimeoutMs, signal: input.signal });
      const normalized = parseAgentJson(response.choices?.[0]?.message?.content);
      const modelChoice = normalized.choice === "keep_car" || normalized.choice === "parking" || normalized.choice === "undecided"
        ? normalized.choice
        : undefined;
      // Model interpretation is primary. A narrow lexical decision is used
      // only after an unavailable or undecided model result, and only for a
      // terse unequivocal response such as «ок».
      const choice = !modelChoice || modelChoice === "undecided" ? fallbackChoice : modelChoice;
      const clientQuestion = normalized.hasOtherStageAnswer === true
        ? extractExplicitClientQuestion(normalized.question, clientReply)
        : undefined;
      return {
        ...parsed,
        ...(choice === "undecided" ? {} : { limitChoice: choice }),
        ...(clientQuestion ? { clientQuestion } : {})
      };
    } catch (error) {
      if (input.signal?.aborted) throw error;
      this.logger.warn(`Amount-limit choice classifier unavailable: ${formatError(error)}`);
      return fallbackChoice === "undecided" ? parsed : { ...parsed, limitChoice: fallbackChoice };
    }
  }

  private async resolveProgramDecision(parsed: AgentTurnResult, input: AgentTurnInput): Promise<AgentTurnResult> {
    const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
    const clientReply = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
    // The client may switch programmes at any point: while answering about a
    // guarantor, after documents, or together with a correction to another
    // card field. Do not bind programme normalization only to its collection
    // question.
    if (!clientReply || (!parsed.programStatement && !isProgramSelectionQuestion(lastAssistant) && !hasExplicitProgramSelectionSignal(clientReply))) return parsed;
    const modelSelectedProgram = parsed.leadCardPatch.requestedProgram;
    if (parsed.programStatement && (modelSelectedProgram === "without_storage" || modelSelectedProgram === "parking")) return parsed;
    try {
      const response = await input.programDecisionPrefetch
        ?? await this.client.createChatCompletion(this.programDecisionRequest(lastAssistant, clientReply), {
          operation: "program_decision", timeoutMs: this.auxiliaryModelTimeoutMs, signal: input.signal, conversationId: input.conversationId
        });
      const classifierResult = parseAgentJson(response.choices?.[0]?.message?.content);
      const program = classifierResult.program;
      const clientQuestion = classifierResult.hasOtherStageAnswer === true
        ? extractExplicitClientQuestion(classifierResult.question, clientReply)
        : undefined;
      if (program !== "without_storage" && program !== "parking") {
        // The semantic model is primary; accept a terse unambiguous choice
        // only as fallback when it returns no decision.
        const fallback = programFromShortReply(clientReply);
        const fallbackResult = fallback ? { ...parsed, leadCardPatch: { ...parsed.leadCardPatch, requestedProgram: fallback } } : parsed;
        return clientQuestion ? { ...fallbackResult, clientQuestion } : fallbackResult;
      }
      const selectedProgram: "without_storage" | "parking" = program;
      // This is a focused semantic decision for the active programme context.
      // Preserve it through final reconciliation without requiring a second
      // local phrase match for the client's wording.
      const normalized: AgentTurnResult = { ...parsed, programStatement: true, leadCardPatch: { ...parsed.leadCardPatch, requestedProgram: selectedProgram } };
      return clientQuestion ? { ...normalized, clientQuestion } : normalized;
    } catch (error) {
      if (input.signal?.aborted) throw error;
      this.logger.warn(`Program classifier unavailable: ${formatError(error)}`);
      const program = programFromExplicitReply(clientReply) ?? programFromShortReply(clientReply);
      return program ? { ...parsed, leadCardPatch: { ...parsed.leadCardPatch, requestedProgram: program } } : parsed;
    }
  }

  private prefetchProgramDecision(input: AgentTurnInput) {
    // Test doubles deliberately preserve their existing one-call contracts.
    // Production RouterAiClient is the only client that should spend a
    // speculative request while the universal extractor is running.
    if (!(this.client instanceof RouterAiClient)) return undefined;
    const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
    const clientReply = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
    if (!clientReply || (!isProgramSelectionQuestion(lastAssistant) && !hasExplicitProgramSelectionSignal(clientReply))) return undefined;
    return this.client.createChatCompletion(this.programDecisionRequest(lastAssistant, clientReply), {
      operation: "program_decision", timeoutMs: this.auxiliaryModelTimeoutMs, signal: input.signal, conversationId: input.conversationId
    }).catch((error: unknown) => {
      if (input.signal?.aborted) throw error;
      this.logger.warn(`Programme classifier prefetch unavailable: ${formatError(error)}`);
      return undefined;
    });
  }

  private programDecisionRequest(lastAssistant: string, clientReply: string) {
    return {
      model: this.config.routerAiTextModel ?? "routerai-text-model-not-configured",
      temperature: 0, max_tokens: 40, reasoning: { enabled: false }, response_format: { type: "json_object" as const },
      messages: [
        { role: "system" as const, content: "Определи, изменяет ли клиент программу займа в текущей реплике, независимо от текущего этапа. Верни строго JSON {\"program\":\"without_storage\"|\"parking\"|null,\"hasOtherStageAnswer\":boolean,\"question\":string|null}. Выбор определяется по смыслу, не только по точному названию: «давай стоянку тогда», «стоянка устроит», «парковка подойдёт», «этот вариант устраивает», «на стоянку», «со стоянкой», «оставить на парковке», «оставлю авто у вас», «пускай у вас авто останется», «пускай у вас будет машина», «могу без машины обойтись», «машину могу оставить у вас», «авто может остаться у вас» означают parking. «без изъятия», «без изъятия устроит», «с правом пользования», «с правом пользоваться», «тогда с правом пользования», «пользоваться автомобилем», «машина нужна для пользования», «мне нужен авто в использовании», «мне нужен авто», «оставить машину у себя», «мне нужно авто у себя», «мне надо ездить на машине», «чтобы авто у меня осталось», «машина должна быть у меня», «не могу без машины» означают without_storage: клиент сохраняет автомобиль у себя и может им пользоваться. Критично: короткое «мне нужен авто» означает without_storage только когда currentStageQuestion — прямой вопрос о выборе программы; в другом контексте это не выбор и program=null. Считай остальные фразы выбором только когда клиент утверждает, где ему нужен автомобиль, а не задаёт отвлечённый или условный вопрос. Короткие «без» и «со» интерпретируй только после прямого вопроса о программе. Если в реплике есть вопрос или явный ответ на другой этап, поставь hasOtherStageAnswer=true и верни question, если он есть. Не придумывай выбор." },
        { role: "user" as const, content: JSON.stringify({ currentStageQuestion: lastAssistant, clientReply }) }
      ]
    };
  }

  private async resolveFinalQuestionsDecision(parsed: AgentTurnResult, input: AgentTurnInput): Promise<AgentTurnResult> {
    const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
    // The response normalizer carries known facts into leadCardPatch. Only a
    // changed value is a model decision; a carried value must still receive
    // semantic interpretation of the client's final answer.
    if (!isFinalQuestionsPrompt(lastAssistant) || parsed.leadCardPatch.clientClosed !== input.facts.clientClosed) return parsed;
    const currentReply = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
    if (!currentReply) return parsed;
    try {
      const response = await this.client.createChatCompletion({
        model: this.config.routerAiTextModel ?? "routerai-text-model-not-configured",
        temperature: 0,
        max_tokens: 20,
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Определи смысл ответа клиента только относительно последнего вопроса AI: есть ли у него ещё вопросы. Верни строго JSON {\"decision\":\"accept\"|\"reject\"|\"undecided\"}. Ответ, что вопросов нет, всё понятно, больше ничего не нужно — reject. Если клиент хочет что-то уточнить — accept. Нейтральная, несвязанная, оценочная или бессмысленная реплика без ясного смысла — undecided. Не додумывай согласие или отказ. Не добавляй текст." },
          { role: "user", content: JSON.stringify({ lastAssistantQuestion: lastAssistant, clientReply: currentReply }) }
        ]
      }, { operation: "final_questions_decision", timeoutMs: this.auxiliaryModelTimeoutMs, signal: input.signal });
      const decision = parseAgentJson(response.choices?.[0]?.message?.content).decision;
      return decision === "reject"
        ? { ...parsed, leadCardPatch: { ...parsed.leadCardPatch, clientClosed: true } }
        : parsed;
    } catch (error) {
      if (input.signal?.aborted) throw error;
      this.logger.warn(`Final-questions classifier unavailable: ${formatError(error)}`);
      return parsed;
    }
  }

  /**
   * The model only repairs a client-written locality into a likely canonical
   * name. It never assigns a region: its output is accepted only when the
   * SOATE catalogue resolves it in the deterministic boundary below.
   */
  private async normalizeResidenceLocality(parsed: AgentTurnResult, input: AgentTurnInput): Promise<AgentTurnResult> {
    const currentReply = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
    // An exact catalogue hit is already canonical. Transliterations and
    // typos deliberately go through the normalizer so the stored display
    // value does not depend on fuzzy-match tie-breaking.
    const directResolution = resolveKyrgyzstanLocality(currentReply);
    if (!currentReply || isVehicleRestrictionStatement(currentReply) || directResolution?.match === "exact") return parsed;
    const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
    // A locality can be corrected after any stage. Keep the source boundary
    // strict: it must either answer the registration question or explicitly
    // state/correct the client's own residence in this turn. A locality
    // mentioned merely while talking about an office, trip, or another person
    // must not rewrite eligibility.
    if (!isResidenceUpdateTurn(currentReply, lastAssistant, input.facts)
      || isResidenceClarificationQuestion(lastAssistant)) return parsed;
    const modelCandidate = parsed.leadCardPatch.residenceText;
    const modelRecognizedLocality = typeof modelCandidate === "string" && modelCandidate.trim() && modelCandidate !== input.facts.residenceText;
    // An explicit correction may contain a typo that the general model did
    // not put into its JSON at all. The locality normalizer still receives
    // the original client wording and is the only component allowed to map
    // it to a SOATE locality.
    try {
      const response = await this.client.createChatCompletion({
        model: this.config.routerAiTextModel ?? "routerai-text-model-not-configured",
        temperature: 0,
        max_tokens: 40,
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Нормализуй только название населённого пункта Кыргызстана из ответа клиента. Верни строго JSON {\"locality\": string|null}. Если узнаваемо, дай одно каноническое русское название города, села или области; если нет — null. Не определяй область, не указывай категорию займа и не придумывай населённый пункт." },
          { role: "user", content: JSON.stringify({ lastAssistantQuestion: lastAssistant, clientReply: currentReply, mainModelCandidate: modelRecognizedLocality ? modelCandidate : undefined }) }
        ]
      }, { operation: "residence_locality_normalization", timeoutMs: this.auxiliaryModelTimeoutMs, signal: input.signal });
      const locality = parseAgentJson(response.choices?.[0]?.message?.content).locality;
      if (typeof locality !== "string") return parsed;
      const resolved = resolveKyrgyzstanLocality(locality);
      return resolved
        ? { ...parsed, leadCardPatch: { ...parsed.leadCardPatch, residenceText: resolved.locality } }
        : parsed;
    } catch (error) {
      if (input.signal?.aborted) throw error;
      this.logger.warn(`Residence-locality normalizer unavailable: ${formatError(error)}`);
      return parsed;
    }
  }

  private async resolveResidenceClarification(parsed: AgentTurnResult, input: AgentTurnInput): Promise<AgentTurnResult> {
    const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
    if (!isResidenceClarificationQuestion(lastAssistant) || !hasPendingResidenceClarification(input.facts)) return parsed;
    const currentReply = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
    if (!currentReply) return parsed;
    // Registration is eligibility data. It can only change from a direct
    // answer to this exact server question or from a catalogue-resolved
    // locality; a secondary model must never infer OTHER_KG from an unrelated
    // condition such as «в кредите» or «в аресте».
    const locality = resolveKyrgyzstanLocality(currentReply);
    if (locality) return { ...parsed, leadCardPatch: { ...parsed.leadCardPatch, residenceText: locality.locality, residenceRegion: locality.residenceRegion, residenceCategory: locality.category, residenceNeedsClarification: false } };
    const decision = residenceClarificationDecision(currentReply);
    if (decision === "accept") return { ...parsed, leadCardPatch: { ...parsed.leadCardPatch, residenceRegion: "Чуйская область", residenceCategory: "BISHKEK_CHUY", residenceNeedsClarification: false } };
    if (decision === "reject") return { ...parsed, leadCardPatch: { ...parsed.leadCardPatch, residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", residenceNeedsClarification: false } };
    return {
      ...parsed,
      leadCardPatch: {
        ...parsed.leadCardPatch,
        residenceText: input.facts.residenceText,
        residenceRegion: undefined,
        residenceCategory: undefined,
        residenceNeedsClarification: true
      }
    };
  }

  private async resolveGuarantorDecision(parsed: AgentTurnResult, input: AgentTurnInput): Promise<AgentTurnResult> {
    const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
    const parkingAlternative = isActiveGuarantorParkingAlternative(lastAssistant, input.facts);
    const guarantorQuestion = isGuarantorQuestion(lastAssistant);
    if (!parkingAlternative && !guarantorQuestion) return parsed;
    // A programme correction is resolved before this method. Never treat the
    // same message as an answer about a guarantor after it selected parking.
    const effectiveProgram = parsed.leadCardPatch.requestedProgram ?? input.facts.requestedProgram;
    if (effectiveProgram === "parking") return parsed;
    const currentReply = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
    if (!currentReply) return parsed;
    // The dedicated classifier, rather than the prose-producing model, owns
    // the answer to an active yes/no stage. Preserve every unrelated patch,
    // but reset this stage until the classifier (or its outage fallback)
    // resolves it.
    const classifierBase = parkingAlternative
      ? { ...parsed, activeWorkflowClarification: undefined, leadCardPatch: { ...parsed.leadCardPatch, requestedProgram: input.facts.requestedProgram, guarantorAlternativeDeclined: input.facts.guarantorAlternativeDeclined } }
      : { ...parsed, activeWorkflowClarification: undefined, leadCardPatch: { ...parsed.leadCardPatch, guarantorAvailable: input.facts.guarantorAvailable, guarantorAlternativeDeclined: input.facts.guarantorAlternativeDeclined } };
    const activeQuestion = parkingAlternative ? GUARANTOR_PARKING_ALTERNATIVE : GUARANTOR_REQUIREMENTS;
    const applyDecision = (decision: "accept" | "reject" | "has_guarantor"): AgentTurnResult => parkingAlternative
      ? decision === "accept"
        ? { ...classifierBase, leadCardPatch: { ...classifierBase.leadCardPatch, requestedProgram: "parking", guarantorAlternativeDeclined: false } }
        : decision === "has_guarantor"
          ? { ...classifierBase, leadCardPatch: { ...classifierBase.leadCardPatch, requestedProgram: input.facts.requestedProgram, guarantorAvailable: true, guarantorAlternativeDeclined: false } }
          : { ...classifierBase, leadCardPatch: { ...classifierBase.leadCardPatch, requestedProgram: input.facts.requestedProgram, guarantorAlternativeDeclined: true } }
      : decision === "accept"
        ? { ...classifierBase, leadCardPatch: { ...classifierBase.leadCardPatch, guarantorAvailable: true, guarantorAlternativeDeclined: false } }
        : { ...classifierBase, leadCardPatch: { ...classifierBase.leadCardPatch, guarantorAvailable: false, guarantorAlternativeDeclined: false } };
    // Once the server has established that a guarantor is mandatory, a bare
    // yes/no is a deterministic answer to this exact question. Do not let an
    // undecided prose model reopen the same requirement.
    if (clearAffirmation(currentReply)) return applyDecision("accept");
    if (clearNegation(currentReply)) return applyDecision("reject");
    try {
      const response = await this.client.createChatCompletion({
        model: this.config.routerAiTextModel ?? "routerai-text-model-not-configured",
        temperature: 0,
        max_tokens: 20,
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system", content: parkingAlternative
              ? "Определи смысл ответа клиента относительно текущего вопроса AI, который передан отдельным полем activeQuestion. Это предложение перейти на программу со стоянкой вместо поручителя. Верни строго JSON {\"decision\":\"accept\"|\"reject\"|\"has_guarantor\"|\"undecided\",\"question\":string|null}. Явное согласие на стоянку, включая «Понял, стоянка тогда», «тогда на стоянку», «давайте на стоянку», а также уточнение уже выбранной программы «Но у меня стоянка» или короткое «д стоянка же» (опечатка «да»), — accept. Если клиент сообщает, что поручитель у него есть («есть поручитель», «поручитель имеется», «приведу поручителя», «найду поручителя»), — has_guarantor: это не вопрос и не отказ от стоянки; продолжаем по прежней программе без изъятия. Критично: «нет, найду поручителя» означает has_guarantor. Первое «нет» отклоняет только стоянку, а обещание найти поручителя определяет итог; не считай такую реплику вопросом или отказом от поручителя. Определяй ответ на activeQuestion по первой ясной части реплики даже если после неё клиент задал отдельный вопрос: «ок. а сколько денег дадите» — decision=accept. В question верни дословно отдельный вопрос клиента без части согласия; если вопроса нет — null. Нейтральная, несвязанная, оценочная или бессмысленная реплика без ясного согласия или отказа — undecided. Не додумывай согласие или отказ. Не добавляй текст."
              : "Определи смысл ответа клиента относительно текущего вопроса AI, который передан отдельным полем activeQuestion: есть ли у него требуемый поручитель. Верни строго JSON {\"decision\":\"accept\"|\"reject\"|\"clarification\"|\"undecided\"}. Ответы «найду», «поищу», «буду искать», «приведу», «организую», «будет человек», обещание найти или привести поручителя означают accept. Отсутствие поручителя или прямой отказ искать — reject. Если клиент уточняет, о каком поручителе речь, зачем он нужен или какие к нему требования (например, «какой такой?», «что за поручитель?», «зачем он?»), — clarification; это не самостоятельный FAQ-вопрос. Нейтральная, несвязанная, оценочная или бессмысленная реплика без ясного смысла — undecided. Не додумывай согласие или отказ. Не добавляй текст."
          },
          { role: "user", content: JSON.stringify({ activeQuestion, lastAssistantReply: lastAssistant, clientReply: currentReply }) }
        ]
      }, { operation: "guarantor_decision", timeoutMs: this.auxiliaryModelTimeoutMs, signal: input.signal });
      const classifierResult = parseAgentJson(response.choices?.[0]?.message?.content);
      const decision = classifierResult.decision;
      // A compound reply such as «ок, а сколько максимум дадите?» contains
      // both the stage decision and a new question. Preserve the question as
      // turn-local routing data; it is never persisted on the lead card.
      const clientQuestion = parkingAlternative
        ? extractExplicitClientQuestion(classifierResult.question, currentReply)
        : undefined;
      if (decision === "accept" || decision === "reject" || (parkingAlternative && decision === "has_guarantor")) {
        const resolved = applyDecision(decision);
        return clientQuestion ? { ...resolved, clientQuestion } : resolved;
      }
      if (!parkingAlternative && decision === "clarification") {
        return { ...classifierBase, activeWorkflowClarification: "guarantor" };
      }
    } catch (error) {
      if (input.signal?.aborted) throw error;
      this.logger.warn(`Guarantor classifier unavailable: ${formatError(error)}`);
    }
    // The model is the primary decision maker. This narrow fallback only
    // covers an explicit named programme, so an outage or an undecided model
    // cannot repeat an offer after the client clearly selected parking.
    if (parkingAlternative && explicitlyAcceptsParkingAlternative(currentReply)) return applyDecision("accept");
    if (parkingAlternative && explicitlyStatesGuarantorAvailable(currentReply)) return applyDecision("has_guarantor");
    if (!parkingAlternative && expressesGuarantorSearchIntent(currentReply)) return applyDecision("accept");
    if (!parkingAlternative && isGuarantorContextClarification(currentReply)) {
      return { ...classifierBase, activeWorkflowClarification: "guarantor" };
    }
    return classifierBase;
  }

  private async resolveOfficeConsent(parsed: AgentTurnResult, input: AgentTurnInput): Promise<AgentTurnResult> {
    const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
    const familyStatus = parsed.leadCardPatch.familyStatus ?? input.facts.familyStatus;
    if (familyStatus !== "married" || parsed.leadCardPatch.spouseConsentAtOffice !== undefined || !isOfficeConsentQuestion(lastAssistant)) return parsed;

    const currentReply = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
    if (!currentReply) return parsed;
    try {
      const response = await this.client.createChatCompletion({
        model: this.config.routerAiTextModel ?? "routerai-text-model-not-configured",
        temperature: 0,
        max_tokens: 20,
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Определи смысл ответа клиента только относительно последнего вопроса AI. Вопрос — согласен ли клиент оформить нотариальное согласие супруга/супруги при визите в офис. Верни строго JSON {\"decision\":\"accept\"|\"reject\"|\"undecided\"}. Разговорное одобрение, похвала варианта или обещание выбрать его означают accept; желание оформить самостоятельно или отказ — reject. Нейтральная, несвязанная, оценочная или бессмысленная реплика без ясного смысла — undecided. Не додумывай согласие или отказ. Не добавляй текст." },
          { role: "user", content: JSON.stringify({ lastAssistantQuestion: lastAssistant, clientReply: currentReply }) }
        ]
      }, { operation: "office_consent", timeoutMs: this.auxiliaryModelTimeoutMs, signal: input.signal });
      const decision = parseAgentJson(response.choices?.[0]?.message?.content).decision;
      if (decision !== "accept" && decision !== "reject") return parsed;
      return { ...parsed, leadCardPatch: { ...parsed.leadCardPatch, spouseConsentAtOffice: decision === "accept" } };
    } catch (error) {
      if (input.signal?.aborted) throw error;
      this.logger.warn(`Office-consent classifier unavailable: ${formatError(error)}`);
      return parsed;
    }
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
      }, { operation: "response_normalization", timeoutMs: this.auxiliaryModelTimeoutMs, signal: input.signal });
      const content = response.choices?.[0]?.message?.content;
      const payload = normalizeAgentPayload(parseAgentJson(typeof content === "string" ? content : undefined), input.attachments);
      const parsed = agentTurnResultSchema.safeParse(payload);
      if (!parsed.success) {
        await this.logs?.warn("dialogue.response-normalizer", "Response normalizer output failed schema validation", {
          conversationId: input.conversationId,
          metadata: { model: response.model ?? model, normalizerInput, sourceResponse: rawResponse, rawModelResponse: content, decodedResponse: payload, schemaIssues: parsed.error.issues }
        });
        return undefined;
      }
      const result = finalizeAgentPayload(await this.resolveSemanticClarifications(parsed.data, input), input);
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
  // A question after a price ("машина стоит 3 млн, сколько максимум
  // дадите?") is a second intent, not evidence that the preceding price is
  // the desired loan amount. Prefer the local predicate attached to the only
  // numeric mention over broad words elsewhere in the sentence.
  if (/(?:стоит|стоимость|цена|оцен[а-яё]*)[^.!?]{0,24}\d[\d\s.,]*(?:\s*(?:млн|миллион[а-яё]*|тыс[а-яё]*|тыщ|[кk]))?/iu.test(source)) return "vehicleValue";
  if (/(?:нуж\p{L}*|надо|хочу|получить|требуется|потребуется|дайте|выдайте)[^.!?]{0,24}\d[\d\s.,]*(?:\s*(?:млн|миллион[а-яё]*|тыс[а-яё]*|тыщ|[кk]))?/iu.test(source)) return "requestedAmount";
  const requested = /(?:нуж\p{L}*|надо|сумм(?:а)?\s+займ|займ|получить|хочу|хотел(?:ось)?|надобно|требуется|потреб(?:уется|овалось|ую)|дайте|выдайте|дадите)/iu.test(source);
  const vehicle = /(?:стоит|стоимость|цена|оцен|машина|авто|автомобил|рыночн)/iu.test(source);
  if (requested === vehicle) return undefined;
  return requested ? "requestedAmount" : "vehicleValue";
}

function explicitlyMentionsCurrency(text: string | undefined, currency: Exclude<NormalizedMoneyValue["currency"], "KGS">): boolean {
  const source = text ?? "";
  const patterns = {
    USD: /(?:\busd\b|\$|dollars?|bucks?|дол+ар|дол(?!\p{L})|бакс)/iu,
    EUR: /(?:\beur(?:o)?s?\b|€|евр)/iu,
    KZT: /(?:\bkzt\b|₸|тенг)/iu,
    RUB: /(?:\brub(?:les?)?\b|₽|руб)/iu
  };
  return patterns[currency].test(source);
}

function pendingMoneyFieldFromHistory(messages: Stage1Message[]): "vehicleValue" | "requestedAmount" | undefined {
  const lastAssistantIndex = [...messages].map((message) => message.author).lastIndexOf("ai");
  if (lastAssistantIndex < 0) return undefined;
  const message = messages[lastAssistantIndex];
  if (/(?:какая\s+)?сумм\p{L}*\s+займ/iu.test(message.body)) return "requestedAmount";
  if (/(?:ориентировочн\p{L}*\s+)?стоимост\p{L}*\s+автомобил/iu.test(message.body)) return "vehicleValue";
  return undefined;
}

function hasPendingMoneyCurrencyClarification(reply: string): boolean {
  const amount = "\\d[\\d\\s.,]*(?:тыс\\p{L}*|млн\\p{L}*)?\\s*(?:сом\\p{L}*|доллар\\p{L}*|евро|тенге|руб\\p{L}*)";
  const confirmation = "(?:верно|правильно|имели\\s+в\\s+виду|это\\s+сумм\\p{L}*)";
  return new RegExp(`(?:${amount}[^?]{0,80}${confirmation}|${confirmation}[^?]{0,80}${amount})\\s*\\?`, "iu").test(reply);
}

/** A server-safe recognition for a bare negative reply to an amount/currency
 * confirmation. Exported for the orchestrator so KB cannot run before the
 * money classifier's fallback reaches the turn processor. */
export function isClearMoneyConfirmationRejection(lastAssistantReply: string, clientReply: string): boolean {
  return hasPendingMoneyCurrencyClarification(lastAssistantReply) && clearNegation(clientReply.trim());
}

function pendingBelowMinimumAmount(reply: string, minimumLoan: number): number | undefined {
  return resolveMoneyFacts({ text: reply, currentFacts: {} }).mentions
    .map((mention) => mention.normalizedAmount)
    .find((value) => value > 0 && value < minimumLoan);
}

function moneyRoleClarificationReply(modelReply: string, input: Pick<AgentTurnInput, "text" | "currentTurnMessages">): string | undefined {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
  if (/(?:желаем\p{L}*|нужн\p{L}*)\s+сумм\p{L}*(?:\s+займ\p{L}*)?|сумм\p{L}*\s+займ\p{L}*/iu.test(text) && !/\d/u.test(text)) {
    return "Какая сумма займа Вам необходима?";
  }
  return /это\s+(?:ориентировочн\p{L}*\s+)?стоимост\p{L}*\s+автомобил\p{L}*\s+или\s+желаем\p{L}*\s+сумм\p{L}*\s+займ/iu.test(modelReply)
    ? "Подскажите, это ориентировочная стоимость автомобиля или желаемая сумма займа?"
    : undefined;
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
  // A recognition outage must never strand the client at document upload or
  // promise a later re-check. Files are already retained by the orchestrator,
  // so complete this optional handoff and continue with the next server stage.
  const lastAssistantReply = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  const recoveredFacts = isCarPhotoStagePrompt(lastAssistantReply)
    ? { ...input.facts, documents: { ...(input.facts.documents ?? {}), car_photo: "received" as const } }
    : { ...input.facts, documentsProvided: true };
  const reply = [isCarPhotoStagePrompt(lastAssistantReply) ? "Фотографии автомобиля получены." : "Спасибо, документы получены.", nextRequiredStageQuestion(recoveredFacts, deriveStageCompletion(recoveredFacts))]
    .filter(Boolean)
    .join("\n\n");
  return {
    reply,
    currentStageClarification: false,
    currentStageResponse: "unknown",
    hasMoney: false,
    needsKnowledgeLookup: false,
    language: input.facts.language ?? "ru",
    intent: "attachments_received_pending_recognition",
    loanQuestionKind: "none",
    leadCardPatch: recoveredFacts,
    cardSummary: "Вложения получены, автоматическое распознавание временно недоступно.",
    preliminaryLimit: null,
    dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "continue_application" },
    targetEvent: "documents",
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
  const {
    knowledgeRequest: _modelKnowledgeRequest,
    // This is server-owned state. A maximum question only becomes an amount
    // preference when it answers the canonical amount-stage question.
    ...leadCardFacts
  } = parsed.leadCardPatch;
  // `clientQuestion` is an optional extraction from a secondary branch
  // classifier. It can be incomplete or incorrect, so it must never replace
  // the actual client turn for server-owned limit/rate classification.
  const semanticText = input.currentTurnMessages?.map((message) => message.text).join(" ") || input.text;
  const existingContractServiceRequest = isExistingContractServiceRequest(semanticText ?? "");
  const clientQuestion = extractExplicitClientQuestion(parsed.clientQuestion, semanticText ?? "");
  // The model is the primary semantic classifier for money questions. Text
  // patterns below are deliberately only an outage/legacy fallback.
  const loanQuestionKind = resolveLoanQuestionKind(parsed.loanQuestionKind, semanticText);
  // The deterministic FAQ matcher catches general maximum-limit wording.
  // A concrete requested amount has already been excluded from that route by
  // the shared money predicate above.
  const maximumLoanQuestion = isMaximumLoanKnowledgeQuestion(semanticText ?? "")
    || loanQuestionKind === "maximum_limit"
    || loanQuestionKind === "maximum_limit_and_rate";
  const semanticInput = clientQuestion
    ? { ...input, text: clientQuestion, currentTurnMessages: [{ index: 1, text: clientQuestion }] }
    : input;
  // Residence affects eligibility and cannot be inferred from free-form
  // model prose. The deterministic locality boundary below is its sole
  // writer; retain the model candidate only as a lookup hint there.
  const {
    residenceText: _modelResidenceText,
    residenceRegion: _modelResidenceRegion,
    residenceCategory: _modelResidenceCategory,
    residenceNeedsClarification: _modelResidenceNeedsClarification,
    // Vehicle type is an eligibility stop factor. It must come only from an
    // explicit client text statement below, never from OCR or an image seen
    // by the multimodal dialogue model.
    vehicleType: _modelVehicleType,
    // A general vision pass may see unrelated numbers on an ID (issuing
    // authority, personal number, dates). It is never a source for the
    // vehicle-registration region, especially the terminal region-10 flag.
    vehicleRegistrationRegion: _modelVehicleRegistrationRegion,
    // A visit slot is a server-owned pair. The model may understand a date
    // or time, but it must never create either one—or complete a date-only
    // reply with a guessed time.
    visitRequested: _modelVisitRequested,
    visitDate: _modelVisitDate,
    visitTime: _modelVisitTime,
    visitConfirmationPending: _modelVisitConfirmationPending,
    ...modelFactsWithoutResidence
  } = leadCardFacts;
  // The dedicated knowledge model is always used for a factual question,
  // including a deterministic FAQ match: it adapts the approved answer to
  // the client's wording. A later fallback protects that match if the model
  // itself returns a false negative.
  // A short reply to the last workflow question is stage input, not a new
  // factual question. The workflow model must not route it to knowledge just
  // because it could not extract a value from it.
  const lastAssistantReply = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  const activeWorkflowClarification = parsed.activeWorkflowClarification === "guarantor"
    && requiresGuarantorForFacts(input.facts)
    && input.facts.guarantorAvailable === undefined
    && !explicitChuyResidenceCategory(semanticText);
  // The model is the primary classifier for natural phrasings such as
  // «а зачем эта информация». Honor its signal only for a pure clarification:
  // it must not hide a fact correction, a money question, or a new FAQ.
  const modelCurrentStageClarification = parsed.currentStageClarification === true
    && !parsed.clientQuestion
    && !parsed.residenceStatement
    && !parsed.programStatement
    && !parsed.hasMoney
    && parsed.loanQuestionKind === "none"
    && !leadPatchChangesFacts(leadCardFacts, input.facts);
  const inactiveGuarantorClarification = input.inactiveGuarantorClarification === true;
  const parkingAlternativeGuarantorAnswer = isActiveGuarantorParkingAlternative(lastAssistantReply, input.facts)
    && parsed.leadCardPatch.guarantorAvailable === true;
  const workflowWhyQuestion = workflowWhyReply(input);
  const workflowStageClarification = modelCurrentStageClarification
    ? workflowStageExplanation(input) ?? "Уточняем эти данные для предварительного рассмотрения заявки."
    : workflowWhyQuestion;
  // Identity is an approved FAQ topic as well. It must take the knowledge
  // route even when it arrives while a workflow question is pending.
  const identityQuestion = isIdentityQuestion(input);
  const relationshipEligibilityQuestion = isRelationshipEligibilityQuestion(semanticText ?? "");
  // Questions about facts previously saved in this client's application are
  // answered by the knowledge model from the server-provided lead card. They
  // must not be consumed as answers to whichever collection stage is active.
  const leadCardQuestion = isLeadCardQuestion(semanticText ?? "");
  const approvedKnowledgeTopic = relationshipEligibilityQuestion || leadCardQuestion || identityQuestion || hasApprovedKnowledgeMatch(semanticText ?? "");
  const modelMarksCurrentStageUnrelated = parsed.currentStageResponse === "unrelated";
  const stageResponse = !approvedKnowledgeTopic && !modelMarksCurrentStageUnrelated && (Boolean(workflowStageClarification) || modelCurrentStageClarification || activeWorkflowClarification || inactiveGuarantorClarification || parkingAlternativeGuarantorAnswer || isResponseToLastWorkflowQuestion(input));
  // The main model semantically detects natural-language questions which do
  // not have a question mark (for example «А кофе есть»). Pattern matching
  // remains only the fallback inside requiresKnowledgeAnswer.
  const explicitProgramSelection = (parsed.programStatement === true
    && (parsed.leadCardPatch.requestedProgram === "without_storage" || parsed.leadCardPatch.requestedProgram === "parking"))
    || hasExplicitProgramSelection(input);
  const programSelectionOnly = explicitProgramSelection
    && !maximumLoanQuestion
    && loanQuestionKind === "none"
    && !asksProgrammeDetails(semanticText ?? "");
  const mayNeedKnowledge = !programSelectionOnly && (
    relationshipEligibilityQuestion
    || leadCardQuestion
    || approvedKnowledgeTopic
    || maximumLoanQuestion
    || requiresKnowledgeAnswer(semanticInput, leadCardFacts, loanQuestionKind)
    || isVehicleRegistrationOwnershipQuestion(semanticText ?? "")
    || identityQuestion
  );
  const ownershipRegistrationQuestion = isVehicleRegistrationOwnershipQuestion(semanticText ?? "");
  const independentOfficeQuestion = hasSeveralClientQuestions(semanticText ?? "") && isOfficeLocationQuestion(semanticText);
  // A knowledge lookup needs an actual new client question. A bare workflow
  // answer such as «нету» cannot be upgraded into a question by any model
  // field or by a generic fallback.
  const bareNonQuestion = !/[?？]/u.test(semanticText ?? "") && wordCount(semanticText ?? "") < 2;
  // A terse «максимальная» is a valid answer to the amount-stage prompt,
  // but semantically it is also a request for the approved maximum-range
  // FAQ.  Do not let the generic one-word guard discard it before retrieval.
  const knowledgeRequest = (!approvedKnowledgeTopic && ((bareNonQuestion && !maximumLoanQuestion) || (!maximumLoanQuestion && stageResponse))) || !mayNeedKnowledge
    ? undefined
    : (relationshipEligibilityQuestion || maximumLoanQuestion || leadCardQuestion || approvedKnowledgeTopic || ownershipRegistrationQuestion || independentOfficeQuestion || isExplicitQuestionText(semanticText ?? "")
      ? { required: true as const, reason: "missing_approved_answer" as const }
      : isLikelyKnowledgeQuestion(semanticText ?? "")
        ? { required: true as const, reason: "missing_approved_answer" as const }
        : undefined);
  const limitChoiceFacts = limitChoicePatch(parsed.limitChoice, input, input.facts);
  // A number in an active scheduling reply is a day or time, never a new
  // vehicle value or requested amount.  This also prevents a model that
  // labels «6 октября в 5» as money from replacing the car value with 0
  // after monetary rounding.
  const schedulingVisitReply = isVisitSchedulingReply(input, input.facts);
  let rawModelPatch = {
    ...(schedulingVisitReply ? {} : modelMoneyPatchForTurn(modelFactsWithoutResidence, input, parsed.hasMoney, loanQuestionKind)),
    // A refusal is about the current vehicle/client, not a permanent
    // conversation lock. Any new client turn starts a fresh eligibility
    // check; explicit facts from this turn below can set a new refusal again.
    ...refusalResetForNewClientTurn(input.facts, semanticText),
    ...residencePatchFromExplicitClientText(input, leadCardFacts, input.facts, parsed.residenceStatement === true),
    ...requestedAmountResetPatch(input),
    ...repeatedRequestedAmountPatch(input, input.facts),
    ...guarantorPatchFromClearReply(input, input.facts, leadCardFacts),
    ...limitChoiceFacts,
    ...familyPatchFromClearReply(input, input.facts, leadCardFacts),
    ...finalQuestionsPatchFromClearReply(input, input.facts, leadCardFacts),
    ...visitPatchFromClearReply(input, input.facts),
    // A country of registration is an eligibility fact. It must win over a
    // model's generic UNA/owner-registration interpretation of the same
    // sentence.
    ...foreignVehicleRegistrationPatch(semanticText),
    ...specialEquipmentVehicleTypePatch(semanticText),
    ...foreignCitizenshipPatch(semanticText),
    ...region10RegistrationPatch(semanticText),
    // A year supplied in response to the exact future-year correction is a
    // factual correction, not an interpretation left to the general model.
    // In particular, do not retain the previously rejected year when the
    // model omits a terse reply such as «2020» from its patch.
    ...vehicleYearCorrectionPatch(lastAssistantReply, semanticText),
    // The year is a small but critical numeric fact. When the client answers
    // the dedicated year prompt with just four digits, do not depend on the
    // broad extractor to repeat that obvious association: reconciliation
    // will turn a future value into the required correction message.
    ...vehicleYearAnswerPatch(lastAssistantReply, semanticText),
    // A client may resume a completed conversation to correct data or ask a
    // new question. The closing acknowledgement is one-shot; every later
    // inbound reopens the final-question state before workflow recalculation.
    ...(input.facts.clientClosed && Boolean(semanticText?.trim()) ? { clientClosed: false } : {}),
    ...accidentNotDrivablePatch(semanticText, input.messages),
    ...(isClearDocumentsRefusal(input) ? { declinedDocuments: true } : {}),
    ...(isClearCarPhotoRefusal(input) ? { declinedCarPhoto: true } : {})
  };
  // A vehicle belonging to a relative or another person can be discussed in
  // the same chat, but it is not an update to this applicant's application.
  // This runs after every extractor has contributed its patch and before any
  // fact can affect pricing, stage completion, or persistence.
  if (referencesOtherPersonsVehicle(semanticText)) {
    rawModelPatch = removeOtherPersonsVehicleFacts(rawModelPatch);
  }
  // The prompt sees compact history to interpret short answers. Do not let a
  // model copy a closed vehicle fact from that history into the current turn:
  // a closed fact may change only when its replacement is explicit in the
  // current client text.
  rawModelPatch = removeUncorroboratedClosedVehicleChanges(rawModelPatch, input);
  // A guarantor decision has meaning only as an answer to its own active
  // question. A question about another vehicle must not let the broad model
  // erase a confirmed guarantor and send the customer backwards in the flow.
  if (!isGuarantorQuestion(lastAssistantReply) && !isActiveGuarantorParkingAlternative(lastAssistantReply, input.facts)) {
    delete rawModelPatch.guarantorAvailable;
    delete rawModelPatch.guarantorAlternativeDeclined;
  }
  // Office-consent can only be inferred from a reply to its own question. A
  // family-status reply such as «в браке» must not skip the separate consent
  // stage merely because the model over-eagerly emitted this field.
  if (!isOfficeConsentQuestion(lastAssistantReply)) delete rawModelPatch.spouseConsentAtOffice;
  const minimumLoan = input.pricing?.minimumLoan ?? 50_000;
  const currentRequestedAmount = typeof rawModelPatch.requestedAmount === "number"
    ? rawModelPatch.requestedAmount
    : input.minimumRequestedAmountCandidate ?? input.facts.requestedAmount;
  const isPendingMoneyClarification = hasPendingMoneyCurrencyClarification(lastAssistantReply);
  const hasBelowMinimumRequestedAmount = typeof currentRequestedAmount === "number" && currentRequestedAmount < minimumLoan;
  const confirmedBelowMinimumAmount = hasBelowMinimumRequestedAmount
    && isPendingMoneyClarification
    && input.moneyClarificationDecision === "accept";
  const requiresBelowMinimumConfirmation = hasBelowMinimumRequestedAmount && !isPendingMoneyClarification;
  if (requiresBelowMinimumConfirmation || confirmedBelowMinimumAmount) {
    // Never persist or use an amount below the product minimum. It is held
    // only long enough to ask for confirmation, then discarded even after a
    // client confirms that the low som amount was intentional.
    delete rawModelPatch.requestedAmount;
    if (requiresBelowMinimumConfirmation) delete rawModelPatch.requestedProgram;
  }
  // The main model can identify an explicit postponement, but it cannot make
  // a durable pause decision from a vague acknowledgement such as «поищу».
  // Keep pause persistence behind a narrow server-owned allow-list; otherwise
  // an unresolved guarantor answer silently stops the whole application.
  if (rawModelPatch.clientPaused === true && !isExplicitPauseRequest(input)) rawModelPatch.clientPaused = false;
  const acceptedGuarantorParkingAlternative = isActiveGuarantorParkingAlternative(lastAssistantReply, input.facts)
    && rawModelPatch.requestedProgram === "parking";
  const explicitlyInvalidatesProgramme = Object.prototype.hasOwnProperty.call(rawModelPatch, "requestedProgram") && rawModelPatch.requestedProgram === undefined;
  if (!hasExplicitProgramSelection(input) && parsed.programStatement !== true && !acceptedGuarantorParkingAlternative && limitChoiceFacts.requestedProgram !== "parking" && !explicitlyInvalidatesProgramme) delete rawModelPatch.requestedProgram;
  const region10PolicyQuestion = isRegion10PolicyQuestion(input);
  const candidateModelPatch = region10PolicyQuestion
    ? Object.fromEntries(Object.entries(rawModelPatch).filter(([key]) => key !== "vehicleRegistrationRegion")) as Partial<ApplicationFacts>
    : rawModelPatch;
  // A guarantor answer belongs to one particular programme branch. Switching
  // back to without-storage starts that branch afresh: an earlier refusal or
  // acceptance while another programme was active must never skip the new
  // guarantor question or reopen the parking alternative immediately.
  const guarantorReset = guarantorResetForProgramChange(input.facts, candidateModelPatch);
  // An upload is sufficient to close the optional document-handoff stage.
  // Recognition remains best-effort: classifications and FIO may be missing,
  // but the client must never be asked to send the same files again.
  const attachmentFacts = attachmentFactsForCurrentStage({
    previous: input.facts,
    attachments: parsed.attachments,
    inboundAttachmentCount: input.attachments.length,
    lastAssistantReply
  });
  // A file uploaded immediately after the dedicated car-photo request is a
  // car-photo handoff even if the generic dialogue model classified it as
  // unknown. This is a workflow acknowledgement, not an image-quality claim:
  // never make the client repeat the same optional step.
  const factsWithoutBelowMinimumAmount = requiresBelowMinimumConfirmation || confirmedBelowMinimumAmount
    ? { ...input.facts, requestedAmount: undefined, requestedAmountSourceCurrency: undefined }
    : input.facts;
  const preliminaryFacts = effectiveFactsForTurn({
    previous: factsWithoutBelowMinimumAmount,
    modelPatch: { ...candidateModelPatch, ...guarantorReset },
    explicitFacts: {},
    currencyFacts: {},
    attachmentFacts
  });
  // Eligibility is derived again after every programme or residence change.
  // Entering the other-region/no-storage branch starts a fresh guarantor
  // decision; a stale answer from an earlier branch must not skip it.
  const guarantorEligibilityReset = guarantorResetForEligibilityChange(input.facts, preliminaryFacts);
  const candidatePatch = { ...candidateModelPatch, ...guarantorReset, ...guarantorEligibilityReset };
  const candidateFacts = Object.keys(guarantorEligibilityReset).length > 0
    ? effectiveFactsForTurn({ previous: factsWithoutBelowMinimumAmount, modelPatch: candidatePatch, explicitFacts: {}, currencyFacts: {}, attachmentFacts })
    : preliminaryFacts;
  // A model may understand a time expression perfectly, but it may not create
  // or confirm a visit until the application itself has reached that stage.
  // Keep the language model free to interpret intent; the server owns this
  // workflow boundary.
  const candidateCompletion = deriveStageCompletion(candidateFacts, input.settings as LoanPricingSettings);
  const modelPatch = candidateCompletion.readyForVisit
    ? candidatePatch
    : omitVisitFacts(candidatePatch);
  const effectiveFacts = modelPatch === candidatePatch
    ? candidateFacts
    : effectiveFactsForTurn({ previous: factsWithoutBelowMinimumAmount, modelPatch, explicitFacts: {}, currencyFacts: {}, attachmentFacts });
  const stageCompletion = deriveStageCompletion(effectiveFacts, input.settings as LoanPricingSettings);
  // Limits are always calculated from the current server facts. A retrieved
  // article about rates must never overwrite a client question such as
  // «сколько денег дадите», even when it follows a consent in the same turn.
  // While the server is resolving the only residence clarification, a KB
  // match must not invent an eligibility refusal.  "Not in Chuy" means
  // OTHER_KG, not that the application cannot be made.
  const resolvingResidenceClarification = isResidenceClarificationQuestion(lastAssistantReply)
    && hasUnresolvedResidence(input.facts);
  const documentAvailabilityAnswer = documentAvailabilityAnswerFor(semanticText ?? "");
  const mandatoryKnowledgeAnswer = documentAvailabilityAnswer ?? (
    maximumLoanQuestion || isLoanRateQuestion(loanQuestionKind) || resolvingResidenceClarification
      ? undefined
      : selectRelevantDocumentation({
        facts: input.facts,
        currentMessage: input.text,
        messages: input.messages,
        includeCrossStageMatches: input.knowledgeLookup
      }).mandatoryAnswer
  );
  const normalizedModelReply = normalizeTechnicalReply(parsed.reply);
  // «Нужно уточнение» is a model fallback, not customer-facing content. If
  // this turn did yield any new server-owned fact, the canonical next step is
  // already known and the fallback must not contradict that recognition.
  const internalReply = isGenericClarificationReply(normalizedModelReply)
    && hasRecognizedFactsForTurn(input.facts, effectiveFacts)
    ? ""
    : normalizedModelReply;
  const guardedModelReply = removeUnpromptedLoanExplanation(stripClientFactRestatement(removeDuplicateCurrencyConversion(removeUnaskedCurrencyProse(removeUnaskedLimitProse(enforceOptionalStageRefusalMessage(enforceGuarantorQuestionRequirements(removeUnpromptedExistingContractRedirect(
    guardWorkflowStageOrder(replacePrematureVisitQuestion(deduplicateRepeatedGuarantorBlock(internalReply), effectiveFacts, stageCompletion), effectiveFacts, stageCompletion),
    input
  ), effectiveFacts), input), input), input), input), input), input);
  // `input.pricing` was calculated before this turn. Recalculate it whenever
  // the client has just changed a fact that affects a limit; otherwise a
  // residence correction (for example Cholpon-Ata -> Tokmok) would still use
  // the old region's limits in this same reply.
  const pricing = pricingForEffectiveFacts(input, effectiveFacts);
  const requestedAmountLimit = requestedAmountLimitReply(pricing, effectiveFacts);
  const selectedLimitNotice = selectedProgramLimitNotice(input.facts, effectiveFacts, pricing);
  const residenceLimitNotice = residenceLimitNoticeForTurn(input.facts, effectiveFacts, pricing);
  const guarantorTransitionNotice = guarantorTransitionNoticeForTurn(input.facts, effectiveFacts);
  const programmeChangeGuarantorNotice = !requiresGuarantorForFacts(input.facts)
    && requiresGuarantorForFacts(effectiveFacts)
    && selectedLimitNotice
    ? `${selectedLimitNotice}\n\n${GUARANTOR_REQUIREMENTS_AFTER_CONTEXT}`
    : guarantorTransitionNotice;
  const workflowSelectedLimitNotice = residenceLimitNotice ? undefined : selectedLimitNotice;
  const unknownVehicleValueNotice = unknownVehicleValueReply(input, effectiveFacts);
  const waitingForVehicleValueNotice = waitingForVehicleValueReply(input, effectiveFacts);
  const vehicleNeedClarification = ambiguousVehicleNeedReply(input, effectiveFacts);
  const familyNotice = familyTransitionNotice(input, input.facts, effectiveFacts);
  const visitNotice = visitConfirmationNotice(input, input.facts, effectiveFacts);
  const visitTimeRecorded = visitTimeRecordedReply(input, input.facts, effectiveFacts);
  const visitProgress = visitProgressReply(input.facts, effectiveFacts);
  const visitTimeUnavailable = visitTimeUnavailableReply(parsed.visitTimeAvailability, effectiveFacts);
  const visitTimeClarification = visitTimeClarificationReply(input, effectiveFacts);
  const visitNonWorkingDay = visitNonWorkingDayReply(input, effectiveFacts);
  const attachmentAcceptanceNotice = input.attachments.length > 0 ? "Фотографии получены." : undefined;
  const acceptedLimitNotice = acceptedLimitChoiceNotice(input.facts, effectiveFacts);
  const olderVehicleNotice = olderVehicleProgramNotice(input, effectiveFacts);
  const region10Answer = isRegion10PolicyQuestion(input) ? "Автомобили с регионом 10 у нас не принимаются в залог по правилам компании." : undefined;
  // The model interprets the client, but it never owns the application
  // workflow. It may answer a direct question (or ask for KB routing); this
  // boundary supplies the one and only next application question.
  const lastMoneyClarificationQuestion = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  const rejectedMoneyClarification = input.moneyClarificationDecision === "reject" && hasPendingMoneyCurrencyClarification(lastMoneyClarificationQuestion);
  const rejectedBelowMinimumAmount = rejectedMoneyClarification
    && pendingBelowMinimumAmount(lastMoneyClarificationQuestion, minimumLoan) !== undefined;
  const belowMinimumReply = requiresBelowMinimumConfirmation
    ? `${formatSomMoney(currentRequestedAmount!)} сом, верно?`
    : confirmedBelowMinimumAmount || rejectedBelowMinimumAmount
      ? `Минимальная сумма займа — ${formatSomMoney(minimumLoan)} сом. Назовите, пожалуйста, сумму не меньше ${formatSomMoney(minimumLoan)} сом.`
      : undefined;
  const moneyRoleReply = moneyRoleClarificationReply(internalReply, input);
  const repeatedStageReply = repeatedResidenceStageExplanation(input, effectiveFacts, stageCompletion);
  const accidentNotDrivableNotice = !input.facts.accidentNotDrivable && effectiveFacts.accidentNotDrivable
    ? "Автомобиль после серьёзного ДТП и не на ходу не принимается как подходящий залог."
    : undefined;
  const vehicleValueBelowMinimumNotice = typeof effectiveFacts.vehicleValue === "number"
    && effectiveFacts.vehicleValue < MINIMUM_VEHICLE_VALUE
    ? "К сожалению, мы не можем принять данный автомобиль в залог, так как его рыночная стоимость должна составлять не менее 300 000 сом."
    : undefined;
  const foreignVehicleRegistrationNotice = isForeignVehicleRegistration(effectiveFacts)
    ? "К сожалению, нет. Мы принимаем в залог только автомобили, зарегистрированные в Кыргызской Республике."
    : undefined;
  const unsupportedVehicleTypeNotice = isUnsupportedVehicleType(effectiveFacts)
    ? "К сожалению, спецтехнику мы не принимаем в залог."
    : undefined;
  const foreignCitizenNotice = isForeignCitizen(effectiveFacts)
    ? "К сожалению, займ оформляется только гражданам Кыргызской Республики."
    : undefined;
  const region10RefusalNotice = effectiveFacts.vehicleRegistrationRegion === "10"
    ? "К сожалению, автомобили с регионом 10 мы не принимаем в залог."
    : undefined;
  const completionNotice = stageCompletion.visit && effectiveFacts.clientClosed
    ? "Спасибо за обращение. Ожидайте звонка менеджера, он подтвердит время визита."
    : undefined;
  // A pause is a durable client preference, not an unfinished application
  // step. Its acknowledgement and lack of a follow-up are server-owned so a
  // model cannot append the question it was waiting for before the pause.
  const pauseNotice = effectiveFacts.clientPaused
    ? "Хорошо! Когда будете готовы, можно продолжить с этого места."
    : undefined;
  // A direct question about the loan amount outranks a pending family or
  // visit branch. The calculation itself is server-owned; after answering,
  // the normal workflow appender returns to the outstanding action.
  const optionalStageDeclineNotice = optionalStageDeclineNoticeForTurn(input.facts, effectiveFacts);
  const directAnswerWithoutRepeatedStage = vehicleValueBelowMinimumNotice ?? unsupportedVehicleTypeNotice ?? region10RefusalNotice ?? foreignVehicleRegistrationNotice ?? foreignCitizenNotice ?? workflowStageClarification ?? accidentNotDrivableNotice ?? visitNotice ?? completionNotice ?? attachmentAcceptanceNotice ?? optionalStageDeclineNotice ?? visitNonWorkingDay ?? visitTimeRecorded ?? visitProgress ?? visitTimeUnavailable ?? visitTimeClarification ?? residenceLimitNotice ?? programmeChangeGuarantorNotice ?? acceptedLimitNotice ?? (region10Answer ? [region10Answer, olderVehicleNotice].filter(Boolean).join("\n\n") : undefined) ?? olderVehicleNotice ?? familyNotice ?? unknownVehicleValueNotice ?? waitingForVehicleValueNotice;
  const terminalRefusalAnswer = vehicleValueBelowMinimumNotice ?? unsupportedVehicleTypeNotice ?? region10RefusalNotice ?? foreignVehicleRegistrationNotice ?? foreignCitizenNotice ?? accidentNotDrivableNotice;
  const directAnswer = directAnswerWithoutRepeatedStage ?? repeatedStageReply;
  // A direct approved FAQ outranks all free-form model prose. This prevents
  // plausible but unsupported claims such as a parking location or credit
  // eligibility from reaching the client. The final output renderer receives
  // this guarded plan and has an additional fail-closed boundary.
  // Rates are supplied exclusively by the knowledge-answer pass. Keeping a
  // server-rendered rate here as well makes a combined "maximum + rate"
  // question duplicate the same approved answer when the orchestrator joins
  // the calculation plan with the knowledge reply.
  const workflowClarificationAnswer = activeWorkflowClarification
    ? GUARANTOR_CONTEXT_CLARIFICATION
    : inactiveGuarantorClarification
      ? "При Вашей прописке в Бишкеке или Чуйской области поручитель не требуется."
      : undefined;
  // This is intentionally the last prose fallback. It is valid only when the
  // current message changed no fact and every server-owned answer path (rule,
  // calculation, active-stage answer and knowledge lookup) is absent.
  const contextualAcknowledgement = !knowledgeRequest
    && !stageResponse
    && !leadPatchChangesFacts(leadCardFacts, input.facts)
    && input.attachments.length === 0
    && !mandatoryKnowledgeAnswer
    && !directAnswerWithoutRepeatedStage
    && loanQuestionKind === "none"
    ? parsed.contextualAcknowledgement
    : undefined;
  const workflowFollowUp = pauseNotice || vehicleValueBelowMinimumNotice || unsupportedVehicleTypeNotice || region10RefusalNotice || foreignVehicleRegistrationNotice || foreignCitizenNotice || accidentNotDrivableNotice || rejectedMoneyClarification || belowMinimumReply || visitTimeRecorded || visitProgress || visitTimeUnavailable || visitTimeClarification || visitNonWorkingDay || hasPendingMoneyCurrencyClarification(internalReply)
    ? undefined
    : serverWorkflowFollowUp(loanQuestionKind, effectiveFacts, stageCompletion, requestedAmountLimit, workflowSelectedLimitNotice);
  const answerBeforeWorkflow = isLoanRateQuestion(loanQuestionKind)
    ? ""
    : pauseNotice ?? workflowStageClarification ?? workflowClarificationAnswer ?? directAnswer ?? mandatoryKnowledgeAnswer ?? contextualAcknowledgement?.text ?? removeIncorrectResidenceClarificationProse(
      removeForbiddenMetaPhrases(dropUnsupportedFallbackForNonQuestion(replaceUnsupportedFallbackWithApprovedAnswer(guardedModelReply, mandatoryKnowledgeAnswer, input), semanticText)),
      input,
      effectiveFacts
    );
  // Limits and eligibility are calculated by the server. If an amount is
  // over the selected programme's limit, preserve a normal acknowledgement or
  // FAQ answer but remove the model's competing explanation before adding the
  // one canonical calculation below.
  const serverSafeAnswer = requestedAmountLimit ? removeModelLimitClaim(answerBeforeWorkflow) : answerBeforeWorkflow;
  // A contextual "why" must survive all later stage-specific normalizers
  // (notably the Chuy and guarantor resolvers). Otherwise they can replace
  // the explanation with the same question the client just queried.
  const responsePlan = terminalRefusalAnswer
    ? terminalRefusalAnswer
    : workflowStageClarification
      ? appendRequiredWorkflowFollowUp(workflowStageClarification, workflowFollowUp)
      : appendRequiredWorkflowFollowUp(
          (contextualAcknowledgement ? undefined : repeatedStageReply) ?? appendContinuationAfterRegion10PolicyQuestion(
            removeModelWorkflowQuestion(removeQuestionsForKnownLeadFacts(removeUnaskedProgramDetails(removeRepeatedProgramExplanation(enforceFirstContactGreeting(serverSafeAnswer, input), effectiveFacts, input), input, programSelectionOnly), effectiveFacts, input.facts)),
            input,
            effectiveFacts
          ),
          identityQuestion ? undefined : workflowFollowUp
        );
  return {
    ...parsed,
    clientQuestion,
    loanQuestionKind,
    // The separate knowledge router is the sole authority for lookup. Keep
    // compatibility fields out of every new main-agent result.
    needsKnowledgeLookup: false,
    leadCardPatch: effectiveFacts,
    dialogueState: effectiveFacts.clientPaused
      ? { stage: "PAUSED", status: "target_reached", nextAction: "pause" }
      : existingContractServiceRequest
        ? { stage: "EXISTING_CONTRACT_REDIRECT", status: "redirect_existing_contract", nextAction: "redirect_existing_contract" }
        : vehicleValueBelowMinimumNotice || accidentNotDrivableNotice
          ? { stage: "REFUSED", status: "refuse", nextAction: "none" }
          : unsupportedVehicleTypeNotice || region10RefusalNotice || foreignCitizenNotice
            ? { stage: "REFUSED", status: "refuse", nextAction: "none" }
            : foreignVehicleRegistrationNotice
              ? { stage: "REFUSED", status: "refuse", nextAction: "none" }
              : region10PolicyQuestion && !input.facts.vehicleRegistrationRegion && parsed.dialogueState.stage === "REFUSED"
                ? { stage: "COLLECTING_VEHICLE", status: "need_more_data", nextAction: "continue_application" }
                : parsed.dialogueState,
    // Reconciliation belongs to the orchestrator's persistence boundary.
    // The model is the sole owner of conversational meaning and client prose.
    // A limit warning answers a client-provided amount, but must never erase
    // an unrelated FAQ answer from the same turn.
    reply: stripMechanicalAcknowledgement(normalizeVehicleRegistrationTerminology(belowMinimumReply ?? moneyRoleReply ?? (rejectedMoneyClarification
      ? "Тогда уточните, какую сумму вы имели в виду?"
      : vehicleNeedClarification
        ? enforceFirstContactGreeting(vehicleNeedClarification, input)
        : (modelCurrentStageClarification ? undefined : unresolvedBinaryDecisionReply(input, effectiveFacts, loanQuestionKind)) ?? visitNonWorkingDay ?? visitTimeClarification ?? responsePlan)))
  };
}

/** The customer-facing term is fixed even when a model repeats an old alias. */
/**
 * A model must not copy one recognized number into both money fields. Two
 * values with the same amount/currency are permitted only when the client
 * explicitly attached that value to both roles in this very message.
 */
function reconcileExplicitMoneyRoles(values: NormalizedMoneyValue[], text: string | undefined, facts: ApplicationFacts): NormalizedMoneyValue[] {
  const deterministic = resolveMoneyFacts({ text, currentFacts: facts });
  const vehicleCurrency = deterministic.vehicleValueCurrency ?? "KGS";
  const requestedCurrency = deterministic.requestedAmountCurrency ?? "KGS";
  const roles = new Map(values.map((value) => [value.field, value]));
  const vehicle = roles.get("vehicleValue");
  const requested = roles.get("requestedAmount");
  if (!vehicle && !requested) return values;

  const reconciled = deterministic.vehicleValue !== undefined && deterministic.requestedAmount !== undefined
    ? [
      ...(vehicle ? [{ field: "vehicleValue" as const, amount: deterministic.vehicleValue, currency: vehicleCurrency, confidence: Math.max(vehicle.confidence, deterministic.vehicleValueConfidence) }] : []),
      ...(requested ? [{ field: "requestedAmount" as const, amount: deterministic.requestedAmount, currency: requestedCurrency, confidence: Math.max(requested.confidence, deterministic.requestedAmountConfidence) }] : [])
    ]
    : values;

  const reconciledVehicle = reconciled.find((value) => value.field === "vehicleValue");
  const reconciledRequested = reconciled.find((value) => value.field === "requestedAmount");
  if (!reconciledVehicle || !reconciledRequested || reconciledVehicle.amount !== reconciledRequested.amount || reconciledVehicle.currency !== reconciledRequested.currency) {
    return reconciled;
  }
  if (clientExplicitlyStatedEqualMoneyRoles(text)) return reconciled;

  const mentions = detectMoneyMentions(text ?? "");
  const hasVehicleRole = mentions.some((mention) => mention.roleCandidate === "vehicleValue");
  const hasRequestedRole = mentions.some((mention) => mention.roleCandidate === "requestedAmount");
  if (hasVehicleRole && !hasRequestedRole) return reconciled.filter((value) => value.field === "vehicleValue");
  if (hasRequestedRole && !hasVehicleRole) return reconciled.filter((value) => value.field === "requestedAmount");
  // With no unambiguous client role, dropping both is safer than writing an
  // invented duplicate to the lead card.
  return [];
}

function clientExplicitlyStatedEqualMoneyRoles(text: string | undefined): boolean {
  const mentions = detectMoneyMentions(text ?? "");
  const vehicleValues = mentions.filter((mention) => mention.roleCandidate === "vehicleValue");
  const requestedValues = mentions.filter((mention) => mention.roleCandidate === "requestedAmount");
  return vehicleValues.some((vehicle) => requestedValues.some((requested) =>
    vehicle.normalizedAmount === requested.normalizedAmount && vehicle.currency === requested.currency
  ));
}

function normalizeVehicleRegistrationTerminology(reply: string): string {
  return reply.replace(/тех\.?\s*паспорт(?:а|у|ом|е)?(?:\s+автомобил(?:я|ю|ем))?/giu, (match) => {
    const normalized = match.toLocaleLowerCase("ru-RU");
    const term = normalized.includes("паспорта")
      ? "свидетельства о регистрации ТС"
      : normalized.includes("паспорту")
        ? "свидетельству о регистрации ТС"
        : normalized.includes("паспортом")
          ? "свидетельством о регистрации ТС"
          : normalized.includes("паспорте")
            ? "свидетельстве о регистрации ТС"
            : "свидетельство о регистрации ТС";
    return /^т/iu.test(match) && match[0] === match[0].toLocaleUpperCase("ru-RU")
      ? `${term[0].toLocaleUpperCase("ru-RU")}${term.slice(1)}`
      : term;
  });
}

/** Convert the interpreter's two allowed markers into a server-owned plan fragment. */
function normalizeTechnicalReply(reply: string): string {
  if (/^распознано[.!\s]*$/iu.test(reply)) return "";
  if (/^нужно\s+уточнение[.!\s]*$/iu.test(reply)) return "Напишите, пожалуйста, подробнее.";
  return reply;
}

/** A single turn can contain several factual questions; exact-FAQ shortcut
 * must not replace the knowledge model's combined evidence-based answer. */
export function hasSeveralClientQuestions(text: string): boolean {
  const explicitQuestionCount = (text.match(/[?？]/gu) ?? []).length;
  if (explicitQuestionCount >= 2) return true;
  const questionSignals = [
    // JavaScript's \b is ASCII-only, so it does not recognise Russian word
    // boundaries. These are deliberately broad question stems instead.
    /где/iu, /сколько/iu, /какой|какая|какие/iu,
    /платн\p{L}*/iu, /нужн\p{L}*\s+ли/iu, /можно/iu, /надо/iu
  ].filter((pattern) => pattern.test(text)).length;
  return questionSignals >= 2;
}

/** Delivery by tow truck after an accident is an unambiguous statement that
 * the vehicle is not drivable. This eligibility rule cannot depend on the
 * current document/photo stage or on a model extracting the boolean field. */
function accidentNotDrivablePatch(text: string | undefined, messages: Stage1Message[]): Partial<ApplicationFacts> {
  const normalized = text?.toLocaleLowerCase("ru-RU") ?? "";
  const recentContext = messages.slice(-2).map((message) => message.body).join(" ").toLocaleLowerCase("ru-RU");
  const mentionsAccident = /(?:дтп|авари(?:я|и|ю|ей|ями)?|после\s+удара)/iu.test(`${normalized} ${recentContext}`);
  const confirmsNotDrivable = /(?:эвакуатор(?:е|ом|а|ы)?|не\s*на\s*ходу|не\s+едет|не\s+заводит(?:ся)?)/iu.test(normalized);
  return mentionsAccident && confirmsNotDrivable ? { accidentNotDrivable: true } : {};
}

function foreignVehicleRegistrationPatch(text: string | undefined): Partial<ApplicationFacts> {
  const normalized = text?.toLocaleLowerCase("ru-RU") ?? "";
  const mentionsVehicle = /(?:авто|автомобил\p{L}*|машин\p{L}*)/iu.test(normalized);
  const mentionsRegistration = /(?:зарег\p{L}*|(?:на|по)\s+уч[её]т\p{L}*|номерах?)/iu.test(normalized);
  if (!mentionsVehicle || !mentionsRegistration) return {};
  if (/(?:^|[^\p{L}])рф(?:$|[^\p{L}])|росси\p{L}*|русск\p{L}*/iu.test(normalized)) return { vehicleRegistrationCountry: "RU" };
  if (/(?:казахстан|\bкз\b)/iu.test(normalized)) return { vehicleRegistrationCountry: "KZ" };
  if (/(?:не\s+(?:в\s+)?кыргызстан\p{L}*|не\s+(?:в\s+)?киргиз\p{L}*|иностранн\p{L}*\s+(?:регистрац|номер))/iu.test(normalized)) return { vehicleRegistrationCountry: "FOREIGN" };
  return {};
}

function isForeignVehicleRegistration(facts: ApplicationFacts): boolean {
  const country = facts.vehicleRegistrationCountry?.trim().toLocaleLowerCase("ru-RU");
  return Boolean(country && !["kg", "кр", "кыргызстан", "кыргызская республика"].includes(country));
}

/** Vehicle type is intentionally derived only from client text. In
 * particular, do not infer it from STS/ID OCR or vehicle photographs. */
function specialEquipmentVehicleTypePatch(text: string | undefined): Partial<ApplicationFacts> {
  const normalized = text?.toLocaleLowerCase("ru-RU") ?? "";
  return /(?:спец(?:иальн\p{L}*\s*)?техник\p{L}*|трактор\p{L}*|экскаватор\p{L}*|бульдозер\p{L}*|погрузчик\p{L}*|автокран\p{L}*|комбайн\p{L}*|грейдер\p{L}*|асфальтоукладчик\p{L}*)/iu.test(normalized)
    ? { vehicleType: "special_equipment" }
    : {};
}

function isUnsupportedVehicleType(facts: ApplicationFacts): boolean {
  const type = facts.vehicleType?.trim().toLocaleLowerCase("ru-RU");
  return Boolean(type && ["special_equipment", "спецтехника", "трактор", "экскаватор", "бульдозер", "погрузчик", "автокран", "комбайн", "грейдер", "асфальтоукладчик"].includes(type));
}

function foreignCitizenshipPatch(text: string | undefined): Partial<ApplicationFacts> {
  const normalized = text?.toLocaleLowerCase("ru-RU") ?? "";
  if (!/(?:я\s+)?(?:гражданин|гражданка|гражданство)/iu.test(normalized)) return {};
  if (/(?:\bрф\b|росси\p{L}*|казахстан|\bкз\b|иностран\p{L}*)/iu.test(normalized)) return { citizenship: "FOREIGN" };
  return {};
}

function isForeignCitizen(facts: ApplicationFacts): boolean {
  const citizenship = facts.citizenship?.trim().toLocaleLowerCase("ru-RU");
  return Boolean(citizenship && !["kg", "кр", "кыргызстан", "кыргызская республика"].includes(citizenship));
}

function region10RegistrationPatch(text: string | undefined): Partial<ApplicationFacts> {
  const normalized = text?.toLocaleLowerCase("ru-RU") ?? "";
  return /(?:авто|автомобил\p{L}*|машин\p{L}*|номер\p{L}*|регион).{0,50}\b10\s*(?:регион|номер)|\b10\s*(?:регион|номер).{0,50}(?:авто|автомобил\p{L}*|машин\p{L}*)/iu.test(normalized)
    ? { vehicleRegistrationRegion: "10" }
    : {};
}

function refusalResetForNewClientTurn(previous: ApplicationFacts, text: string | undefined): Partial<ApplicationFacts> {
  if (!text?.trim()) return {};
  const reset: Partial<ApplicationFacts> = {};
  if (isUnsupportedVehicleType(previous)) reset.vehicleType = undefined;
  if (isForeignVehicleRegistration(previous)) reset.vehicleRegistrationCountry = undefined;
  if (previous.vehicleRegistrationRegion === "10") reset.vehicleRegistrationRegion = undefined;
  if (isForeignCitizen(previous)) reset.citizenship = undefined;
  return reset;
}

function isGenericClarificationReply(reply: string): boolean {
  return /^не\s+смогла\s+понять\.\s*напишите,?\s+пожалуйста,?\s+подробнее\.?$/iu.test(reply.trim());
}

/** A recognised fact always takes precedence over the model's generic fallback. */
function hasRecognizedFactsForTurn(previous: ApplicationFacts, current: ApplicationFacts): boolean {
  const ignored = new Set(["language", "stageCompletion", "knowledgeRequest", "reportedInvalidVehicleYear"]);
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...keys].some((key) => {
    if (ignored.has(key)) return false;
    return JSON.stringify((previous as Record<string, unknown>)[key]) !== JSON.stringify((current as Record<string, unknown>)[key]);
  });
}

/** The normalizer carries existing facts through the model patch. Only a
 * changed durable value means the client supplied/corrected stage data. */
function leadPatchChangesFacts(patch: Partial<ApplicationFacts>, current: ApplicationFacts): boolean {
  const transient = new Set(["language", "stageCompletion", "knowledgeRequest"]);
  return Object.entries(patch).some(([key, value]) => !transient.has(key)
    && JSON.stringify((current as Record<string, unknown>)[key]) !== JSON.stringify(value));
}

/** Mechanical acknowledgements add no customer-facing value. */
function stripMechanicalAcknowledgement(reply: string): string {
  return reply
    .replace(/^\s*(?:поняла|понял|хорошо,?\s*(?:поняла|понял)|записала)[,.!…\s]*/iu, "")
    .replace(/(?:^|\n)\s*(?:поняла|понял|хорошо,?\s*(?:поняла|понял)|записала)[.!…\s]*(?=\n|$)/giu, "$1")
    .replace(/^\s*ваша\s+прописка\s*[—:-]\s*(?:бишкек|чуйская\s+область|за\s+пределами\s+чуйской\s+области)[.!\s]*/iu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function omitVisitFacts(patch: Partial<ApplicationFacts>): Partial<ApplicationFacts> {
  const { visitRequested: _visitRequested, visitDate: _visitDate, visitTime: _visitTime, visitConfirmationPending: _visitConfirmationPending, ...safePatch } = patch;
  return safePatch;
}

function visitPatchFromClearReply(input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages" | "settings">, facts: ApplicationFacts): Partial<ApplicationFacts> {
  if (!deriveStageCompletion(facts).readyForVisit) return {};
  const lastAssistant = lastActiveAssistantMessage(input.messages);
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim().toLocaleLowerCase("ru-RU");
  const correctingBookedVisit = Boolean(facts.visitDate && facts.visitTime && isExplicitVisitSlotChange(text));
  if (!isVisitSchedulingQuestion(lastAssistant) && !correctingBookedVisit) return {};
  const settings = input.settings as Record<string, unknown>;
  const timezone = typeof settings.timezone === "string" ? settings.timezone : "Asia/Bishkek";
  const visitDate = visitDateFromReply(text, timezone);
  // Preserve neither date nor time for weekends: the reply renderer below
  // explains the concrete day and asks for another working day instead.
  if (visitDate && !isWorkingVisitDate(visitDate)) return {};
  // The time must be tied to «в» (or an explicit hour suffix), otherwise the
  // date day in «6 октября» is incorrectly treated as 18:00.
  const timeMatches = [...text.matchAll(/(?:(?:^|[\s,])(?:в|после|около)\s+(\d{1,2})(?::(\d{2}))?|(?:^|[\s,])(\d{1,2})(?::(\d{2}))?\s*(?:час(?:а|ов)?|ч))\s*(утра|дня|вечера)?(?!\p{L})/giu)];
  // In a correction such as «в 3 неудобно, давайте в 6» the final time is
  // the replacement; never keep the now explicitly rejected first time.
  const timeMatch = timeMatches.at(-1);
  if (!timeMatch) {
    return visitDate
      ? {
        visitRequested: true,
        visitDate,
        ...(correctingBookedVisit ? { visitTime: facts.visitTime } : {})
      }
      : {};
  }
  let hour = Number(timeMatch[1] ?? timeMatch[3]);
  const minute = Number(timeMatch[2] ?? timeMatch[4] ?? "0");
  const dayPart = timeMatch[5] ?? "";
  // During the working-day visit window, colloquial «в 5» means 17:00.
  if (/(?:дня|вечера)/iu.test(dayPart) && hour < 12) hour += 12;
  else if (hour >= 1 && hour <= 8) hour += 12;
  if (hour < 11 || hour > 18 || minute > 59) return {};
  return {
    visitRequested: true,
    ...(visitDate ? { visitDate } : correctingBookedVisit ? { visitDate: facts.visitDate } : {}),
    visitTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
  };
}

function isExplicitVisitSlotChange(text: string): boolean {
  return /(?:неудобн|не\s+подходит|давайте|лучше|перенес|вс[её]-?таки|изменил(?:ись|ся)?\s+план|планы\s+измен|приед(?:у|ем|ет))/iu.test(text);
}

function isVisitSchedulingQuestion(text: string): boolean {
  return /(?:на\s+какой(?:\s+(?:другой|рабочий)){0,2}\s+день|день\s+и\s+время|когда\s+вам\s+удобно|в\s+какое\s+время).{0,100}(?:подъехать|приехать)/iu.test(text);
}

/** A pause acknowledgement is operational metadata, not the latest workflow
 * question. When the client resumes, retain the question it interrupted. */
function lastActiveAssistantMessage(messages: Stage1Message[]): string {
  return [...messages].reverse().find((message) => message.author === "ai"
    && !/когда\s+будете\s+готовы,?\s+можно\s+продолжить\s+с\s+этого\s+места/iu.test(message.body))?.body ?? "";
}

function isVisitSchedulingReply(input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages">, facts: ApplicationFacts): boolean {
  if (!deriveStageCompletion(facts).readyForVisit) return false;
  const lastAssistant = lastActiveAssistantMessage(input.messages);
  if (!isVisitSchedulingQuestion(lastAssistant)) return false;
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
  return /(?:сегодня|послезавтра|завтра|(?:^|[^\p{L}\d])\d{1,2}\s+(?:январ\p{L}*|феврал\p{L}*|март\p{L}*|апрел\p{L}*|мая|июн\p{L}*|июл\p{L}*|август\p{L}*|сентябр\p{L}*|(?:октябр|котябр)\p{L}*|ноябр\p{L}*|декабр\p{L}*)(?!\p{L}))/iu.test(text);
}

/** A relative day is useful context, but «утром» is not a schedulable time.
 * Answer it once at the server boundary instead of allowing a model prompt
 * plus the generic visit follow-up to produce two copies of office hours. */
function visitTimeClarificationReply(input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages" | "settings">, facts: ApplicationFacts): string | undefined {
  if (!deriveStageCompletion(facts).readyForVisit) return undefined;
  const lastAssistant = lastActiveAssistantMessage(input.messages);
  if (!isVisitSchedulingQuestion(lastAssistant)) return undefined;
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim().toLocaleLowerCase("ru-RU");
  const timezone = typeof (input.settings as Record<string, unknown>).timezone === "string"
    ? (input.settings as Record<string, unknown>).timezone as string
    : "Asia/Bishkek";
  if (!visitDateFromReply(text, timezone)) return undefined;
  // The deterministic workflow now records a date-only reply and asks the
  // next missing value itself. Do not replace that precise question with a
  // generic clarification (and do not call every explicit date «tomorrow»).
  if (facts.visitDate) return undefined;
  const hasExactTime = /(?:(?:^|[\s,])в\s+\d{1,2}(?::\d{2})?|(?:^|[\s,])\d{1,2}(?::\d{2})?\s*(?:час(?:а|ов)?|ч))(?!\p{L})/iu.test(text);
  if (hasExactTime) return undefined;
  return "Завтра подойдёт. Во сколько Вам удобно подъехать? Офис работает с понедельника по пятницу с 11:00 до 19:00, для оформления нужно приехать не позднее 18:00.";
}

function visitTimeUnavailableFallback(text: string): boolean {
  return /(?:по\s+времени\s+)?пока\s+не\s+(?:знаю|известно)|(?:как\s+только|когда)\s+(?:смогу|будет\s+известно|получится).{0,50}(?:сообщ|напиш|скажу)|не\s+могу\s+(?:пока\s+)?сказать\s+(?:время|когда)/iu.test(text);
}

function visitTimeUnavailableReply(availability: AgentTurnResult["visitTimeAvailability"], facts: ApplicationFacts): string | undefined {
  if (availability !== "unknown" || facts.visitTime) return undefined;
  return "Хорошо, сообщите, пожалуйста, когда время будет известно — тогда согласуем визит.";
}

function visitNonWorkingDayReply(input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages" | "settings">, _facts: ApplicationFacts): string | undefined {
  const lastAssistant = lastActiveAssistantMessage(input.messages);
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim().toLocaleLowerCase("ru-RU");
  // A direct availability question such as «завтра можно?» must be checked
  // against the real calendar even before the application is ready to book.
  // Otherwise a generic KB answer about arriving later today can incorrectly
  // promise a Saturday or Sunday visit.
  if (!isVisitSchedulingQuestion(lastAssistant) && !isVisitAvailabilityQuestion(text)) return undefined;
  const timezone = typeof (input.settings as Record<string, unknown>).timezone === "string"
    ? (input.settings as Record<string, unknown>).timezone as string
    : "Asia/Bishkek";
  const date = visitDateFromReply(text, timezone);
  if (!date || isWorkingVisitDate(date)) return undefined;
  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  const displayDate = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  return `${displayDate} — ${weekday}. Офис работает только по будням, с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой другой рабочий день и время Вам удобно подъехать?`;
}

function isVisitAvailabilityQuestion(text: string): boolean {
  return /(?:сегодня|послезавтра|завтра|понедель|вторник|сред|четверг|пятниц|суббот|воскрес).{0,80}(?:можно|получится|подъех|приех)|(?:можно|получится).{0,80}(?:сегодня|послезавтра|завтра|понедель|вторник|сред|четверг|пятниц|суббот|воскрес)/iu.test(text);
}

function visitDateFromReply(text: string, timezone: string): string | undefined {
  const relative = relativeVisitDate(text, timezone);
  if (relative) return relative;

  const weekday = weekdayVisitDate(text, timezone);
  if (weekday) return weekday;

  const monthMatch = text.match(/(?:^|[^\p{L}\d])(\d{1,2})\s+(январ\p{L}*|феврал\p{L}*|март\p{L}*|апрел\p{L}*|мая|июн\p{L}*|июл\p{L}*|август\p{L}*|сентябр\p{L}*|(?:октябр|котябр)\p{L}*|ноябр\p{L}*|декабр\p{L}*)(?!\p{L})/iu);
  if (!monthMatch) return undefined;
  const monthToken = monthMatch[2].toLocaleLowerCase("ru-RU");
  const month = russianMonthIndex(monthToken);
  if (month === undefined) return undefined;

  const day = Number(monthMatch[1]);
  const today = currentDateTime(timezone).slice(0, 10);
  let year = Number(today.slice(0, 4));
  let date = validUtcDate(year, month, day);
  if (!date) return undefined;
  if (date.toISOString().slice(0, 10) < today) {
    year += 1;
    date = validUtcDate(year, month, day);
  }
  return date?.toISOString().slice(0, 10);
}

function russianMonthIndex(value: string): number | undefined {
  if (/^январ/iu.test(value)) return 0;
  if (/^феврал/iu.test(value)) return 1;
  if (/^март/iu.test(value)) return 2;
  if (/^апрел/iu.test(value)) return 3;
  if (/^мая$/iu.test(value)) return 4;
  if (/^июн/iu.test(value)) return 5;
  if (/^июл/iu.test(value)) return 6;
  if (/^август/iu.test(value)) return 7;
  if (/^сентябр/iu.test(value)) return 8;
  if (/^(?:октябр|котябр)/iu.test(value)) return 9;
  if (/^ноябр/iu.test(value)) return 10;
  if (/^декабр/iu.test(value)) return 11;
  return undefined;
}

function validUtcDate(year: number, month: number, day: number): Date | undefined {
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? date : undefined;
}

function relativeVisitDate(text: string, timezone: string): string | undefined {
  // «послезавтра» contains «завтра», so the more specific word is checked first.
  const offset = /сегодня/iu.test(text) ? 0 : /послезавтра/iu.test(text) ? 2 : /завтра/iu.test(text) ? 1 : undefined;
  if (offset === undefined) return undefined;
  const date = new Date(`${currentDateTime(timezone).slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function weekdayVisitDate(text: string, timezone: string): string | undefined {
  const match = text.match(/(?:в\s+)?(понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресень[ея])/iu);
  if (!match) return undefined;
  const weekday = new Map<string, number>([
    ["понедельник", 1], ["вторник", 2], ["среда", 3], ["среду", 3], ["четверг", 4],
    ["пятница", 5], ["пятницу", 5], ["суббота", 6], ["субботу", 6], ["воскресенье", 0], ["воскресенья", 0]
  ]).get(match[1]!.toLocaleLowerCase("ru-RU"));
  if (weekday === undefined) return undefined;
  const date = new Date(`${currentDateTime(timezone).slice(0, 10)}T00:00:00Z`);
  const distance = (weekday - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + distance);
  return date.toISOString().slice(0, 10);
}

function isWorkingVisitDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return date.getUTCDay() !== 0 && date.getUTCDay() !== 6;
}

function limitChoicePatch(choice: AgentTurnResult["limitChoice"], input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages" | "pricing">, facts: ApplicationFacts): Partial<ApplicationFacts> {
  if (!facts.requestedProgram || facts.requestedAmount === undefined) return {};
  const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  const singleProgrammeOffer = isSingleProgrammeLimitOffer(lastAssistant);
  const dualProgrammeOffer = /могу\s+продолжить\s+либо[\s\S]{0,500}(?:перейти|стоянк)/iu.test(lastAssistant);
  if (!singleProgrammeOffer && !dualProgrammeOffer) return {};
  const withoutLimit = input.pricing?.withoutStorage.publicMax;
  const parkingLimit = input.pricing?.parking.publicMax;
  if (singleProgrammeOffer && choice === "keep_car") {
    const selectedLimit = facts.requestedProgram === "parking" ? parkingLimit : withoutLimit;
    return typeof selectedLimit === "number" ? { requestedAmount: selectedLimit } : {};
  }
  if (!dualProgrammeOffer || facts.requestedProgram !== "without_storage") return {};
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

function isAmountLimitChoiceQuestion(text: string): boolean {
  return /могу\s+продолжить\s+либо[\s\S]{0,500}(?:сумм\p{L}*\s+до|перейти)[\s\S]{0,500}(?:без\s+изъяти|стоянк|парковк)/iu.test(text)
    || isSingleProgrammeLimitOffer(text);
}

function isSingleProgrammeLimitOffer(text: string): boolean {
  return /сумм\p{L}*\s+\d[\s\S]{0,180}не\s+проходит\.?(?:\s|\n)*могу\s+продолжить\s+на\s+сумм\p{L}*\s+до\s+\d/iu.test(text);
}

/** Outage-only protection for unequivocal one-word answers. Rich wording is
 * deliberately left to the JSON normalizer above. */
function limitChoiceFromClearReply(text: string): Exclude<AgentTurnResult["limitChoice"], undefined> {
  const normalized = text.trim().toLocaleLowerCase("ru-RU");
  if (/^(?:стоянк\p{L}*|парковк\p{L}*|на\s+стоянк\p{L}*|на\s+парковк\p{L}*)[.!\s]*$/u.test(normalized)) return "parking";
  if (/^(?:без\s+изъяти\p{L}*|уменьш\p{L}*\s+сумм\p{L}*|да|ага|ок(?:ей)?|хорошо|нет|неа|не\s+хочу|не\s+подходит)[.!\s]*$/u.test(normalized)) return "keep_car";
  return "undecided";
}

function singleProgrammeLimitChoiceFromClearReply(text: string): Exclude<AgentTurnResult["limitChoice"], undefined> {
  const normalized = text.trim().toLocaleLowerCase("ru-RU");
  if (/^(?:да|ага|угу|ок(?:ей)?|хорошо|подходит|соглас(?:ен|на))[.!\s]*$/u.test(normalized)) return "keep_car";
  return "undecided";
}

function isBareRefusal(input: Pick<AgentTurnInput, "text" | "currentTurnMessages">): boolean {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
  return /^(?:нет|неа|не\s+хочу|не\s+буду|отказываюсь|не\s+подходит)[.!\s]*$/iu.test(text);
}

function acceptedLimitChoiceNotice(previous: ApplicationFacts, current: ApplicationFacts): string | undefined {
  if (previous.requestedAmount === current.requestedAmount || current.requestedAmount === undefined || !current.requestedProgram) return undefined;
  const program = current.requestedProgram === "parking" ? "со стоянкой" : "без изъятия";
  return `Продолжим по программе ${program} на сумму ${formatSomMoney(current.requestedAmount)} сом.`;
}

function removeUnaskedLimitProse(reply: string, _input: Pick<AgentTurnInput, "text" | "currentTurnMessages">): string {
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

/** The server already owns the NBKR block; do not let the input model restate it. */
function removeDuplicateCurrencyConversion(reply: string, input: Pick<AgentTurnInput, "currencyConversions">): string {
  if (!input.currencyConversions?.length) return reply;
  return reply
    .split(/(?<=[.!?])\s+/u)
    .filter((sentence) => !/(?:доллар|евро|тенге|руб).{0,100}(?:около|примерно|ориентировочно).{0,100}сом|(?:около|примерно|ориентировочно).{0,100}сом.{0,100}(?:доллар|евро|тенге|руб)/iu.test(sentence))
    .join(" ")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

/** Remove a standalone restatement of vehicle/amount facts just supplied by the client. */
function stripClientFactRestatement(reply: string, input: Pick<AgentTurnInput, "text" | "currentTurnMessages">): string {
  const clientText = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").toLocaleLowerCase("ru-RU");
  const ignored = new Set(["авто", "автомобиль", "года", "год", "стоит", "нужно", "надо", "тысяч", "тысяча", "тыс", "сом", "сома", "сумма"]);
  const clientTokens = new Set((clientText.match(/[\p{L}\d]+/gu) ?? []).filter((token) => token.length > 1 && !ignored.has(token)));
  if (clientTokens.size < 2) return reply;
  return reply
    .split(/(?<=[.!?])\s+/u)
    .filter((sentence) => {
      if (/[?？]/u.test(sentence)) return true;
      const matchingTokens = new Set((sentence.toLocaleLowerCase("ru-RU").match(/[\p{L}\d]+/gu) ?? []).filter((token) => clientTokens.has(token)));
      return matchingTokens.size < 3;
    })
    .join(" ")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

/** A bare negative is only stage input; it must not trigger an invented loan explanation. */
function removeUnpromptedLoanExplanation(reply: string, input: Pick<AgentTurnInput, "messages" | "text" | "currentTurnMessages">): string {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
  const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  if (!/^(?:нет|неа|не|нету|не хочу)[.!\s]*$/iu.test(text) || /(?:вы\s+хотите|нужен\s+займ).{0,80}(?:авто|автомобил)/iu.test(lastAssistant)) return reply;
  return reply.replace(/(?:нет|неа),?\s*это\s+займ\s+под\s+залог\s+автомобил[яе][.!]?\s*/iu, "").trim();
}

function olderVehicleProgramNotice(input: Pick<AgentTurnInput, "messages" | "settings">, facts: ApplicationFacts): string | undefined {
  if (!facts.vehicleYear || new Date().getFullYear() - facts.vehicleYear <= 15) return undefined;
  const alreadyExplained = input.messages.some((message) => message.author === "ai" && message.body.includes(OLDER_VEHICLE_PROGRAM_NOTICE));
  return alreadyExplained ? undefined : OLDER_VEHICLE_PROGRAM_NOTICE;
}

function visitConfirmationNotice(input: Pick<AgentTurnInput, "settings">, previous: ApplicationFacts, current: ApplicationFacts): string | undefined {
  if (!current.visitDate || !current.visitTime || (previous.visitDate === current.visitDate && previous.visitTime === current.visitTime)) return undefined;
  const settings = input.settings as Record<string, unknown>;
  const timezone = typeof settings.timezone === "string" ? settings.timezone : "Asia/Bishkek";
  const date = new Date(`${current.visitDate}T00:00:00Z`);
  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long", timeZone: "UTC" }).format(date);
  const displayDate = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(date);
  const address = approvedOfficeAddress(settings.address);
  const twoGis = approvedOfficeUrl(settings.twoGisUrl, DEFAULT_TWO_GIS_URL);
  const googleMaps = approvedOfficeUrl(settings.googleMapsUrl, DEFAULT_GOOGLE_MAPS_URL);
  void timezone;
  return [
    `Записываю Вас на ${weekday}, ${displayDate}, в ${current.visitTime}.`,
    `Адрес: ${address}`,
    `2ГИС: ${twoGis}`,
    `Google Maps: ${googleMaps}`,
    visitRequirementsReminder(current),
    "\nЗапись предварительная, её подтвердит менеджер.",
  ].filter(Boolean).join("\n");
}

/** Mandatory visit conditions are derived from the final lead facts, never
 * delegated to the prose model. Keeping them in one sentence makes the
 * confirmation readable when both conditions apply. */
function visitRequirementsReminder(facts: ApplicationFacts): string | undefined {
  const requirements: string[] = [];
  if (facts.familyStatus === "married") {
    requirements.push("нужно согласие супруга(и)");
  }
  if (requiresGuarantorForFacts(facts)) requirements.push("требуется поручитель при визите");
  return requirements.length > 0
    ? `Напоминаем Вам, что для оформления займа ${requirements.join(" и ")}.`
    : undefined;
}

/** Once a client has supplied exactly one half of a visit slot, the server
 * owns the next prompt. This prevents a model acknowledgement plus a generic
 * date-and-time question from reaching the client as two competing prompts. */
function visitProgressReply(previous: ApplicationFacts, current: ApplicationFacts): string | undefined {
  const dateChanged = previous.visitDate !== current.visitDate;
  const timeChanged = previous.visitTime !== current.visitTime;
  if (!dateChanged && !timeChanged) return undefined;
  if (current.visitDate && current.visitTime) return undefined;
  return nextRequiredStageQuestion(current);
}

/** Once the server recorded a time, the next server message must never ask
 * for that time again. A date still missing is the only remaining slot part. */
function visitTimeRecordedReply(
  input: Pick<AgentTurnInput, "messages">,
  previous: ApplicationFacts,
  current: ApplicationFacts
): string | undefined {
  if (previous.visitTime === current.visitTime || !current.visitTime) return undefined;
  const lastAssistant = lastActiveAssistantMessage(input.messages);
  if (!isVisitSchedulingQuestion(lastAssistant)) return undefined;
  if (current.visitDate) return undefined; // visitConfirmationNotice owns a complete slot.
  return `Время ${current.visitTime} отмечено. Офис работает с понедельника по пятницу. На какой день Вам удобно подъехать?`;
}

function approvedOfficeAddress(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /(?:подтвердить|настройк)/iu.test(value)) return DEFAULT_OFFICE_ADDRESS;
  return value.trim();
}

function approvedOfficeUrl(value: unknown, fallback: string): string {
  return typeof value === "string" && /^https:\/\//iu.test(value.trim()) ? value.trim() : fallback;
}

function officeLocationReply(settingsValue: object): string {
  const settings = settingsValue as Record<string, unknown>;
  const address = approvedOfficeAddress(settings.address);
  const displayAddress = address === DEFAULT_OFFICE_ADDRESS
    ? "бульваре Молодой Гвардии, 22, в Бишкеке"
    : address;
  const twoGis = approvedOfficeUrl(settings.twoGisUrl, DEFAULT_TWO_GIS_URL);
  const googleMaps = approvedOfficeUrl(settings.googleMapsUrl, DEFAULT_GOOGLE_MAPS_URL);
  return `Наш офис находится на ${displayAddress}. Мы работаем с понедельника по пятницу с 11:00 до 19:00. Вы можете приехать в любое удобное время в рамках рабочего графика.\n${twoGis}\n${googleMaps}`;
}

function isOfficeLocationQuestion(text: string | undefined): boolean {
  return /(?:куда\s+(?:ехать|приезжать|подъехать)|где\s+(?:вы|офис|находит)|адрес|как\s+доехать)/iu.test(text ?? "");
}

/** A non-owner disclosure is a colloquial form of the approved UNA-registration FAQ. */
function isVehicleRegistrationOwnershipQuestion(text: string): boolean {
  return /(?:оформлен|зарегистрирован)\p{L}*.{0,60}\s+не\s*на\s*(?:меня|мне|я)(?:\s|$)|(?:автомобил|машин|мошин|авто)\p{L}*.{0,80}(?:не\s*мо[яйеи]|чуж\p{L}*|друг(?:ого|ая|ой)\s+(?:человек|лиц))/iu.test(text);
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
  // A guarantor is meaningful only after server-owned residence resolution.
  // Remove model prose that assumes an unverified OTHER_KG category, not only
  // its follow-up question, before we append the actual residence stage.
  const replyWithoutPrematureGuarantor = !completion.residence
    ? reply.replace(/\s*[^.!?\n]{0,220}поручител[^.!?\n]*[.!?]?/giu, "").replace(/[ \t]{2,}/gu, " ").trim()
    : reply;
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
  if (!prematureQuestion || !prematureQuestion.test(replyWithoutPrematureGuarantor)) return replyWithoutPrematureGuarantor;
  const withoutPrematureQuestion = replyWithoutPrematureGuarantor.replace(prematureQuestion, "").replace(/[ \t]{2,}/gu, " ").trim();
  return withoutPrematureQuestion || nextQuestion;
}

export function nextRequiredStageQuestion(facts: ApplicationFacts, completion = deriveStageCompletion(facts)): string | undefined {
  if (!completion?.vehicle) {
    if (typeof facts.reportedInvalidVehicleYear === "number" && facts.reportedInvalidVehicleYear > new Date().getFullYear()) {
      return `${facts.reportedInvalidVehicleYear} год ещё не наступил. Уточните, пожалуйста, верный год выпуска автомобиля.`;
    }
    const missing = [
      facts.vehicleValue === undefined ? "ориентировочную стоимость автомобиля" : undefined,
      missingVehicleDetails(facts)
    ].filter((value): value is string => Boolean(value));
    return `Подскажите, пожалуйста, ${missing.join(" , ")}.`;
  }
  // An amount can be present but rejected by the selected programme limit.
  // In that case the server must render the canonical limit alternative,
  // never reopen collection with the misleading generic amount question.
  // An entered amount can still be invalid for the selected programme. This
  // gate precedes guarantor collection: a guarantor cannot make an over-limit
  // or otherwise ineligible amount valid.
  if (!completion.requestedAmount) {
    if (facts.requestedAmount === undefined) return "Какая сумма займа Вам необходима?";
    return requestedAmountLimitReply(calculateLoanPricing(facts), facts) ?? "Какая сумма займа Вам необходима?";
  }
  if (!completion.program) return "Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?";
  // Region and category are written only by the server locality resolver.
  // Once both exist, a stale `residenceNeedsClarification` flag must never
  // reopen the residence branch while the dialogue is already at guarantor
  // (or any later) stage.
  const residenceResolved = Boolean(facts.residenceRegion && facts.residenceCategory);
  if (!completion.residence && !residenceResolved) return hasUnresolvedResidence(facts)
    ? "Подскажите, пожалуйста, это в Чуйской области?"
    : "Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.";
  if (!completion.guarantor) {
    return facts.guarantorAvailable === false && !facts.guarantorAlternativeDeclined
      ? GUARANTOR_PARKING_ALTERNATIVE
      : GUARANTOR_REQUIREMENTS;
  }
  if (!completion.documents) return documentCollectionQuestion(facts);
  if (!completion.carPhoto) return "Пожалуйста, отправьте 2–3 фотографии автомобиля.";
  if (!completion.family) return nextFamilyStageQuestion(facts);
  if (completion.readyForVisit && !completion.visit) {
    if (facts.visitDate && !facts.visitTime) {
      return "Офис работает с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. В какое время Вам удобно подъехать?";
    }
    if (facts.visitTime && !facts.visitDate) {
      return "Офис работает с понедельника по пятницу. На какой день Вам удобно подъехать?";
    }
    return "Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?";
  }
  return undefined;
}

function missingVehicleDetails(facts: ApplicationFacts): string | undefined {
  if (!facts.vehicleModel && !facts.vehicleYear) return "модель и год выпуска автомобиля";
  if (!facts.vehicleModel) return "модель автомобиля";
  if (!facts.vehicleYear) return "год выпуска автомобиля";
  return undefined;
}

function documentCollectionQuestion(facts: ApplicationFacts): string {
  const documents = facts.documents ?? {};
  const idComplete = documents.id_front === "received" && documents.id_back === "received";
  const stsComplete = documents.vehicle_registration_front === "received" && documents.vehicle_registration_back === "received";
  if (idComplete && !stsComplete) {
    return "Пожалуйста, отправьте свидетельство о регистрации автомобиля с обеих сторон.";
  }
  if (!idComplete && stsComplete) {
    return "Пожалуйста, отправьте фото ID с обеих сторон.";
  }
  return "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.";
}

/**
 * A client may believe they already gave a required detail. This is not an
 * FAQ and not a request to guess from history: explain the active new-loan
 * stage and repeat its full canonical collection prompt.
 */
function repeatedResidenceStageExplanation(input: Pick<AgentTurnInput, "text" | "currentTurnMessages">, facts: ApplicationFacts, completion: StageCompletion): string | undefined {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
  const saysAlreadyProvided = /^(?:(?:я|вы)\s+)?(?:уже|же)\s*(?:говорил(?:а)?|сказал(?:а)?|писал(?:а)?|указывал(?:а)?|сообщал(?:а)?)(?:\s+(?:это|вам))?[.!\s]*$/iu.test(text)
    || /^(?:я\s+)?(?:это\s+)?(?:уже\s+)?(?:говорил(?:а)?|сказал(?:а)?|писал(?:а)?|указывал(?:а)?)[.!\s]*$/iu.test(text);
  const residenceResolved = Boolean(facts.residenceRegion && facts.residenceCategory);
  if (!saysAlreadyProvided || completion.residence || residenceResolved) return undefined;
  return "Понимаю. Мы оформляем новую заявку, и сейчас уточняем Вашу прописку для предварительного расчёта.\n\nПодскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.";
}

function nextFamilyStageQuestion(facts: ApplicationFacts): string {
  if (!facts.familyStatus || facts.familyStatus === "unknown") return "Подскажите, пожалуйста, Ваше семейное положение — Вы в браке, в разводе или не в браке.";
  if (facts.familyStatus === "divorced" && facts.vehicleBoughtDuringMarriage === undefined) {
    return "Подскажите, пожалуйста, автомобиль был приобретён до брака, во время брака или после развода?";
  }
  if (facts.familyStatus === "married" && facts.spouseAway) {
    if (facts.visitDate || facts.visitTime) return "Супруг или супруга может оформить нотариальное согласие у любого нотариуса по месту нахождения и отправить Вам оригинал. Вам удобнее отменить визит или перенести его на другую дату?";
    return "Супруг или супруга может оформить нотариальное согласие у любого нотариуса по месту нахождения и отправить Вам оригинал. Напишите, пожалуйста, когда согласие будет у Вас — после этого продолжим оформление.";
  }
  if (facts.familyStatus === "married") return "Для оформления потребуется нотариальное согласие супруга или супруги. Его можно оформить у любого нотариуса или у нотариуса в нашем здании; ориентировочная стоимость — 1500 сом. Вам удобно оформить согласие при визите в офис?";
  return "Подскажите, пожалуйста, Ваше семейное положение — Вы в браке, в разводе или не в браке.";
}

type LoanQuestionKind = NonNullable<AgentTurnResult["loanQuestionKind"]>;

function resolveLoanQuestionKind(modelKind: LoanQuestionKind, text: string | undefined): LoanQuestionKind {
  // The main prompt makes the model the primary semantic classifier. An
  // explicit current-turn maximum/limit request is nevertheless authoritative
  // over an erroneous `loan_rate` / knowledge classification: otherwise
  // «А максимум сколько денег дадите?» can receive a FAQ about interest.
  const normalized = text?.toLocaleLowerCase("ru-RU") ?? "";
  const asksRate = /(?:ставк\p{L}*|процент\p{L}*|сколько\s*%)/iu.test(normalized);
  // An explicitly stated requested amount is not a maximum-limit question.
  // Preserve a simultaneous rate question, but keep the amount on the money
  // pipeline instead of sending it to the MAX_LIMIT FAQ.
  if (hasExplicitRequestedAmountMention(normalized)) return asksRate ? "loan_rate" : "none";
  const asksLimit = isMaximumLoanKnowledgeQuestion(normalized) || /(?:дадите|(?:скольк|сколк)\p{L}*[^?!]{0,40}(?:денег|деньг|баб|лав[еэ]|сом|дад\p{L}*|получ\p{L}*)|(?:лимит|максимум|макс|потолок)\p{L}*|(?:денег|деньг|баб|лав[еэ])[^?!]{0,40}(?:(?:скольк|сколк)\p{L}*|дад\p{L}*|может\p{L}*\s+дат\p{L}*|можно|получ\p{L}*)|от\s+(?:скольк|сколк)\p{L}*|до\s+(?:скольк|сколк)\p{L}*(?:\s+дад\p{L}*)?)/iu.test(normalized);
  if (asksLimit) return asksRate ? "maximum_limit_and_rate" : "maximum_limit";
  if (asksRate) return "loan_rate";
  // A rate answer is unsafe unless the client explicitly asked about a
  // percentage in this turn. Never let stale dialogue context or a model
  // hallucination turn a generic money question into a rate explanation.
  if (!asksRate && (modelKind === "loan_rate" || modelKind === "maximum_limit_and_rate")) return "none";
  return "none";
}

function isLoanRateQuestion(kind: LoanQuestionKind): boolean {
  return kind === "loan_rate" || kind === "maximum_limit_and_rate";
}

/** A general rate question must describe both approved programmes, even if the knowledge model omitted one. */
function ensureGeneralRateCoverage(reply: string, text: string | undefined): string {
  const question = text?.toLocaleLowerCase("ru-RU") ?? "";
  const asksRate = /(?:процент|ставк|сколько\s*%)/iu.test(question);
  const namesProgramme = /(?:без\s+изъят|стоянк|парковк)/iu.test(question);
  if (!asksRate || namesProgramme) return reply;
  const hasWithoutStorage = /(?:без\s+изъят|ставк\p{L}*\s+определя\p{L}*\s+индивидуальн|индивидуальн[^.!?]{0,80}(?:осмотр|провер))/iu.test(reply);
  const hasParking = /(?:со\s+стоянк|парковк|2[,.]4\s*%)/iu.test(reply);
  const additions = [
    hasWithoutStorage ? undefined : "По программе без изъятия ставка определяется индивидуально после осмотра автомобиля и проверки документов.",
    hasParking ? undefined : "По программе со стоянкой ставка составляет 2,4% в месяц, парковка — 130 сом в сутки."
  ].filter((value): value is string => Boolean(value));
  return additions.length > 0 ? [reply.trim(), ...additions].filter(Boolean).join(" ") : reply;
}

/** Replaces only the maximum-range portion of a multi-topic KB reply. */
function mergeMaximumLoanTemplateWithOtherAnswers(template: string, modelReply: string): string {
  const canonical = template.trim();
  // The knowledge prompt asks for this exact template as a paragraph. Strip
  // it before putting the server-owned variant first. The line fallback also
  // covers a model that copied the placeholders with different whitespace.
  // A model can reproduce a complete range on one line (usually using the
  // general 2 000 000 som ceiling from the documentation) instead of the
  // placeholders. That ceiling is not client-facing: the actual ceiling is
  // calculated from the lead card below. Remove the *whole pair* regardless
  // of whitespace before retaining independent answers from a multi-topic
  // message.
  const maximumRangePair = /(?:Для\s+вас\s+доступно:\s*)?(?:[-•]\s*)?Без\s+изъятия\s*:\s*от\s*50\s*000\s*сом\s*до\s*(?:MAX_LIMIT_WITHOUT|\d[\d\s]*)\s*сом[.!?]?\s*(?:\n|\s)+(?:[-•]\s*)?Со\s+стоянкой\s*:\s*от\s*50\s*000\s*сом\s*до\s*(?:MAX_LIMIT_PARK|\d[\d\s]*)\s*сом[.!?]?/giu;
  const remaining = modelReply
    .trim()
    .replace(canonical, "")
    .replace(maximumRangePair, "")
    .replace(/(?:^|\n)\s*(?:[-•]\s*)?без\s+изъятия\s*:\s*от\s*50\s*000\s*сом\s*до\s*(?:MAX_LIMIT_WITHOUT|\d[\d\s]*)\s*сом\s*(?=\n|$)/giu, "\n")
    .replace(/(?:^|\n)\s*(?:[-•]\s*)?со\s+стоянкой\s*:\s*от\s*50\s*000\s*сом\s*до\s*(?:MAX_LIMIT_PARK|\d[\d\s]*)\s*сом\s*(?=\n|$)/giu, "\n")
    // A non-canonical maximum claim is never client-facing. It is removed
    // instead of competing with the server-calculated template above.
    .split(/\n{2,}|(?<=[.!?])\s+/u)
    .filter((part) => !/(?:максимальн\p{L}*|максимум|предельн\p{L}*|\bлимит\p{L}*)/iu.test(part))
    // A maximum-range request is not a request to collect the desired loan
    // amount. The amount is selected only after the client chooses a
    // programme. Do not retain an invented model follow-up that combines it
    // with the one server-owned missing prerequisite (for example residence).
    .filter((part) => !/(?:нужн\p{L}*|необходим\p{L}*|укаж(?:ите|ите))[^.!?]{0,80}сумм\p{L}*\s+займ\p{L}*|сумм\p{L}*\s+займ\p{L}*[^.!?]{0,80}(?:нужн\p{L}*|необходим\p{L}*|укаж(?:ите|ите))/iu.test(part))
    .join("\n\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return [canonical, remaining].filter(Boolean).join("\n\n");
}

/** The KB model may see a broad FAQ packet, but a credit refusal is valid
 * only when the current client turn actually concerns credit/pledge status. */
function isUngroundedVehicleCreditAnswer(reply: string, clientText: string): boolean {
  if (!/кредит\p{L}*/iu.test(reply)) return false;
  return !/(?:кредит\p{L}*|авто\p{L}*\s+в\s+залоге|машин\p{L}*\s+в\s+залоге)/iu.test(clientText);
}

/** Region 10 is a registration fact, never an inference from the vehicle's
 * make, model, year, price or any arbitrary number in the message. */
function hasExplicitRegion10Mention(text: string): boolean {
  const regionMarker = "(?:рег\\p{L}*|реон\\p{L}*)";
  return new RegExp(`(?:^|[\\s,.;:!?])(?:10\\s*(?:-?\\s*)?${regionMarker}|${regionMarker}\\s*(?:№|#)?\\s*10)(?=$|[\\s,.;:!?])`, "iu").test(text);
}

/** Knowledge chunks may describe server implementation, but that prose is never client-facing. */
function removeInternalPricingInstruction(reply: string): string {
  return reply
    .split(/(?<=[.!?])\s+/u)
    .filter((sentence) => !/(?:`?publicmax`?|общие\s+потолки|внутренн\p{L}*\s+пол|расч[её]тн\p{L}*\s+инструкц|переданн\p{L}*\s+сервер)/iu.test(sentence))
    .join(" ")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

/** A request to replace the amount without naming a replacement must reopen
 * the amount branch. Keeping the previous amount would leave stageCompletion
 * true and could incorrectly continue at documents or visit. */
function requestedAmountResetPatch(input: Pick<AgentTurnInput, "text" | "currentTurnMessages">): Partial<ApplicationFacts> {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
  if (/\d/u.test(text)) return {};
  return /(?:друг(?:ая|ую|ой)|ин(?:ая|ую|ой)|нов(?:ая|ую|ой)|изменить|поменять)[^.!?]{0,30}сумм\p{L}*(?:\s+займ\p{L}*)?|сумм\p{L}*[^.!?]{0,30}(?:друг(?:ая|ую|ой)|ин(?:ая|ую|ой)|нов(?:ая|ую|ой)|изменить|поменять)/iu.test(text)
    ? { requestedAmount: undefined, requestedProgram: undefined }
    : {};
}

/**
 * A terse «я уже говорил/писал» is a reference to the immediately preceding
 * amount question, not a request for a vague clarification. Recover only an
 * earlier client amount that the deterministic parser identifies as a loan
 * request; vehicle prices and arbitrary historic numbers remain excluded.
 */
function repeatedRequestedAmountPatch(input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages">, facts: ApplicationFacts): Partial<ApplicationFacts> {
  if (facts.requestedAmount !== undefined || !isAlreadyProvidedReply(input)) return {};
  const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  if (!/(?:какая|какую)\s+сумм\p{L}*\s+займ/iu.test(lastAssistant)) return {};
  for (const message of [...input.messages].reverse()) {
    if (message.author !== "client") continue;
    const resolved = resolveMoneyFacts({ text: message.body, currentFacts: facts, pendingFacts: ["requestedAmount"] });
    if (typeof resolved.requestedAmount === "number" && (resolved.requestedAmountCurrency === "KGS" || /\bсом\p{L}*/iu.test(message.body))) {
      return { requestedAmount: resolved.requestedAmount, requestedAmountSourceCurrency: "KGS" };
    }
  }
  return {};
}

function isAlreadyProvidedReply(input: Pick<AgentTurnInput, "text" | "currentTurnMessages">): boolean {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
  return /^(?:(?:я|вы)\s+)?(?:уже|же)\s*(?:говорил(?:а)?|сказал(?:а)?|писал(?:а)?|написал(?:а)?|указывал(?:а)?|сообщал(?:а)?)(?:\s+(?:это|вам))?[.!\s]*$/iu.test(text)
    || /^(?:я\s+)?(?:это\s+)?(?:уже\s+)?(?:говорил(?:а)?|сказал(?:а)?|писал(?:а)?|написал(?:а)?|указывал(?:а)?)[.!\s]*$/iu.test(text);
}

/** A concise "I already told you" is meaningful only after an unfinished
 * server-owned application prompt.  It must not route general conversation
 * or a genuine existing-contract request away from the knowledge model. */
export function isAlreadyProvidedWorkflowReply(input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages">): boolean {
  if (!isAlreadyProvidedReply(input)) return false;
  const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  return isWorkflowPrompt(lastAssistant);
}

function requestedAmountLimitReply(pricing: LoanPricing | undefined, facts: ApplicationFacts): string | undefined {
  if (facts.requestedAmount === undefined || !facts.requestedProgram) return undefined;
  const selectedPricing = facts.requestedProgram === "without_storage" ? pricing?.withoutStorage : pricing?.parking;
  if (!selectedPricing?.available || typeof selectedPricing.publicMax !== "number") {
    const parkingMaximum = pricing?.parking.available && typeof pricing.parking.publicMax === "number"
      ? pricing.parking.publicMax
      : undefined;
    if (facts.requestedProgram === "without_storage" && parkingMaximum !== undefined) {
      return `По программе без изъятия по текущим параметрам заявку продолжить нельзя. Со стоянкой при текущей стоимости автомобиля доступно до ${formatSomMoney(parkingMaximum)} сом. Могу продолжить по программе со стоянкой.`;
    }
    return undefined;
  }
  if (facts.requestedAmount <= selectedPricing.publicMax) return undefined;
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
      // A limit choice must be resolved before the next guarantor stage. The
      // model sometimes emits the whole guarantor block ahead of the server
      // calculation in the same reply; drop it atomically.
      if (/поручител/iu.test(sentence)) return false;
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
    || facts.residenceCategory !== input.facts.residenceCategory
    // A pricing response contains both programme limits, but recomputing on
    // an amount/programme correction makes the invariant explicit: every
    // changed limit input is validated before a later workflow stage.
    || facts.requestedAmount !== input.facts.requestedAmount
    || facts.requestedProgram !== input.facts.requestedProgram;
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

function residenceLimitNoticeForTurn(previous: ApplicationFacts, current: ApplicationFacts, pricing: LoanPricing): string | undefined {
  const residenceChanged = previous.residenceRegion !== current.residenceRegion || previous.residenceCategory !== current.residenceCategory;
  if (!residenceChanged || !current.requestedProgram || !current.residenceRegion || !current.residenceCategory) return undefined;
  const selectedPricing = current.requestedProgram === "without_storage" ? pricing.withoutStorage : pricing.parking;
  if (!selectedPricing.available || typeof selectedPricing.publicMax !== "number") return undefined;
  const limit = formatSomMoney(selectedPricing.publicMax);
  const program = current.requestedProgram === "without_storage" ? "без изъятия" : "со стоянкой";
  const prefix = `По программе ${program} Вам доступно до ${limit} сом.`;
  // The amount stage precedes the guarantor gate. A residence correction can
  // establish that a guarantor will be needed later, but it must not append
  // that question while the server still needs the requested loan amount.
  // Otherwise one reply contains both the guarantor question and the next
  // canonical amount question.
  return requiresGuarantorForFacts(current) && deriveStageCompletion(current).requestedAmount
    ? `${prefix}\n\n${GUARANTOR_REQUIREMENTS_AFTER_CONTEXT}`
    : prefix;
}

/** The guarantor gate is eligibility, not an LLM-selected dialogue stage. */
function guarantorTransitionNoticeForTurn(previous: ApplicationFacts, current: ApplicationFacts): string | undefined {
  if (!requiresGuarantorForFacts(current)) return undefined;
  if (!requiresGuarantorForFacts(previous)) return GUARANTOR_REQUIREMENTS;
  if (previous.guarantorAvailable !== false && current.guarantorAvailable === false) return GUARANTOR_PARKING_ALTERNATIVE;
  return undefined;
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
  reply = removeIncorrectResidenceClarificationProse(reply, undefined, facts);
  // Guarantor is not a conversational preference: it is a server-owned
  // eligibility gate. Once the selected programme is parking (or residence
  // is not another KG region), no prose from either model may reopen it.
  if (!requiresGuarantorForFacts(facts)) {
    reply = stripInactiveGuarantorWorkflowProse(reply);
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
function serverWorkflowFollowUp(loanQuestionKind: LoanQuestionKind, facts: ApplicationFacts, completion: StageCompletion, amountLimitReply: string | undefined, selectedLimitNotice: string | undefined): string | undefined {
  const nextQuestion = nextRequiredStageQuestion(facts, completion);
  // An invalid corrected amount must interrupt even a completed/visited
  // application. Completion flags for unrelated stages stay intact, so this
  // check has to precede the terminal-question branch.
  if (amountLimitReply) return amountLimitReply;
  if (completion.visit) return facts.clientClosed ? undefined : FINAL_QUESTIONS_PROMPT;
  if (isLoanRateQuestion(loanQuestionKind)) return nextQuestion;
  return [selectedLimitNotice, nextQuestion].filter(Boolean).join("\n\n") || undefined;
}

/** The clarification only distinguishes Chuy from another KG region. It is
 * never an eligibility refusal, and it must disappear once the server has
 * resolved the category. */
function removeIncorrectResidenceClarificationProse(reply: string, input: Pick<AgentTurnInput, "messages"> | undefined, facts: ApplicationFacts): string {
  const lastAssistant = input ? [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "" : "";
  if (input && !isResidenceClarificationQuestion(lastAssistant)) return reply;
  if (!facts.residenceRegion || !facts.residenceCategory) return reply;
  return reply
    .replace(/\s*к\s+сожалению,?\s+мы\s+не\s+сможем\s+оформить\s+займ[^.!?]*(?:за\s+пределами\s+чуйской\s+области|чуйской\s+области)[^.!?]*[.!?]/giu, "")
    .replace(/\s*подскажите,?\s+пожалуйста,?\s+правильно\s+ли\s+я\s+понимаю,?\s+что[^?!\n]*(?:чуйской\s+области|за\s+пределами)[^?!\n]*\?/giu, "")
    .replace(/\s*подскажите,?\s+пожалуйста,?\s+это\s+в\s+чуйской\s+области\?/giu, "")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function removeModelWorkflowQuestion(reply: string): string {
  // The divorce transition is a single canonical server response: its first
  // sentence explains the rule and its second sentence asks the purchase
  // timing. It must remain atomic so the workflow appender does not preserve
  // the explanation and append the same full prompt a second time.
  if (/Нотариальное\s+согласие\s+бывшего\s+супруга\s+или\s+супруги\s+не\s+требуется/iu.test(reply) && /автомобиль\s+был\s+приобрет\p{L}*\s+(?:до\s+брака,?\s+)?во\s+время\s+брака\s+или\s+после\s+развода/iu.test(reply)) {
    return reply.trim();
  }
  // This is a complete server-owned continuation after a newly recorded
  // visit time. The remaining question is about the date, not a model retry
  // of the time prompt, so it must survive the generic model-question scrub.
  if (/Время\s+\d{2}:\d{2}\s+отмечено/iu.test(reply) && /на\s+какой\s+день[^?!.]*(?:подъехать|приехать)/iu.test(reply)) return reply.trim();
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
  const stagePromptStart = /^(?:подскажите|уточните|какая\s+сумма\s+займа|есть\s+ли\s+у\s+вас|вас\s+интересует|пожалуйста,?\s*(?:отправьте|пришлите)|на\s+какой\s+день|когда\s+вам\s+удобно|во\s+сколько|можно\s+рассмотреть)/iu;
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
      facts.vehicleValue === undefined ? "ориентировочную стоимость автомобиля" : undefined,
      missingVehicleDetails(facts)
    ].filter((item): item is string => Boolean(item));
    return `Подскажите, пожалуйста, ${missing.join(" , ")}.`;
  }
  if (facts.requestedAmount === undefined) return "Какая сумма займа Вам необходима?";
  return undefined;
}

export function enforceFirstContactGreeting(reply: string, input: Pick<AgentTurnInput, "messages" | "text" | "currentTurnMessages" | "hadPriorAssistantMessage">): string {
  const officialGreeting = "Здравствуйте! Меня зовут Айлин. Я менеджер по оформлению новых займов автоломбарда «Молодой». Информируем Вас, что мы не выдаем займ под залог автомобиля с регионом 10.";
  const hasPriorAssistantMessage = input.hadPriorAssistantMessage || input.messages.some((message) => message.author === "ai");
  // First contact is a compliance requirement, so do not rely on the model
  // remembering it. On later turns, remove any greeting the model supplied.
  // An identity reply is authored by the knowledge route and must not be
  // polluted by the first-contact greeting.
  if (isIdentityQuestion(input)) return reply;
  const rest = reply
    .replace(/^\s*здравствуйте[!,.]?\s*(?:(?:меня\s+зовут|я)\s+Айлин[^.!?]*[.!?]\s*)?(?:я\s+менеджер\s+по\s+оформлению\s+новых\s+займов\s+автоломбарда\s+«Молодой»[.!?]\s*)?(?:информируем\s+Вас,?\s+что\s+мы\s+не\s+выдаем[^.!?]*[.!?]\s*)*/iu, "")
    .replace(/^(?:я\s+менеджер\s+по\s+оформлению\s+новых\s+займов\s+автоломбарда\s+«Молодой»[.!?]\s*)+/iu, "")
    .trim();
  if (hasPriorAssistantMessage) return rest || reply;
  // A bare greeting is not a request for free-form assistance. Keep first
  // contact fully server-owned so the model cannot add «Как я могу помочь?»
  // or another unasked offer before the required vehicle question.
  if (isGreetingOnly(input)) return [officialGreeting, nextRequiredStageQuestion({})].join("\n\n");
  return [officialGreeting, rest].filter(Boolean).join("\n\n");
}

function isGreetingOnly(input: Pick<AgentTurnInput, "text" | "currentTurnMessages">): boolean {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
  return /^(?:привет|хай|здравствуйте|добрый\s+(?:день|вечер)|салам(?:атсызбы)?|hello|hi)[!,.\s]*$/iu.test(text);
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

function isRelationshipEligibilityQuestion(text: string): boolean {
  const mentionsRelationship = /(?:^|[^\p{L}])(?:жен(?:а|у|ы|е|ой|ою)?|муж(?:а|у|ем|ья)?|супруг\p{L}*|поручител\p{L}*)(?=$|[^\p{L}])/iu.test(text);
  if (!mentionsRelationship) return false;
  if (/(?:нуж\p{L}*|надо|брать|привез|приех|нужен|нужна|есть\s+ли|какой|какая|требован|услови)/iu.test(text)) return true;
  // «А поручителя?» is a natural short continuation of an attendance
  // question. Treat it as a question even though its verb was omitted.
  return /^\s*(?:а\s+)?поручител\p{L}*\s*[?!.…]*\s*$/iu.test(text);
}

function isIdentityQuestion(input: Pick<AgentTurnInput, "text" | "currentTurnMessages">): boolean {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").toLocaleLowerCase("ru-RU");
  return /(?:кто\s+(?:ты|вы)(?:\s+(?:такой|такая))?|чем\s+(?:(?:ты|вы)\s+)?занима(?:ешься|етесь)|зачем\s+(?:ты|вы)|(?:ты|вы)\s+(?:бот|робот|ии)|(?:это|ты|вы)\s+(?:ai|ии)|жив(?:ой|ая)|настоящ(?:ий|ая))/iu.test(text);
}

/**
 * Detect a request to recall this client's saved application details. This is
 * deliberately separate from company FAQ routing: the answer comes from the
 * server-owned `leadCard`, including when the requested fact is still absent.
 */
function isLeadCardQuestion(text: string): boolean {
  const normalized = text.trim().toLocaleLowerCase("ru-RU");
  if (!normalized) return false;
  const asksToRecall = /(?:напомн\p{L}*|(?:какой|какая|какого|сколько|где|когда)[^?!]{0,30}(?:у\s+меня|я\s+(?:указал|выбрал|сообщил|назвал))|(?:у\s+меня|я\s+(?:указал|выбрал|сообщил|назвал))[^?!]{0,30}(?:какой|какая|какого|сколько|где|когда)|(?:моя|мой|моё|мое)[^?!]{0,30}(?:какой|какая|какого|сколько|где|когда))/iu.test(normalized);
  const mentionsLeadFact = /(?:моя|моей|мою|моём|моем|у\s+меня|я\s+(?:указал|выбрал|сообщил|назвал)|авто(?:мобил\p{L}*)?|машин\p{L}*|марка|модель|год(?:а|у)?|стоимост\p{L}*|сумм\p{L}*\s+займ\p{L}*|пропис\p{L}*|место\s+жительств\p{L}*|программ\p{L}*|семейн\p{L}*\s+положен\p{L}*|документ\p{L}*|дата|время\s+(?:визит|запис)|визит)/iu.test(normalized);
  return mentionsLeadFact && (asksToRecall || /[?？]/u.test(normalized));
}

/** The source FAQ contains two adjacent document cases. Select the one the
 * client actually named before generic retrieval can blend them together. */
function documentAvailabilityAnswerFor(text: string): string | undefined {
  const normalized = text.toLocaleLowerCase("ru-RU");
  const missing = "(?:нет|без|потерял(?:а)?|утерял(?:а)?|утрачен(?:а|о)?)";
  if (new RegExp(`${missing}.{0,40}(?:\\bid\\b|паспорт\\p{L}*)|(?:\\bid\\b|паспорт\\p{L}*).{0,40}${missing}`, "iu").test(normalized)) {
    return "Вы можете использовать приложение Tunduk для идентификации личности.";
  }
  if (new RegExp(`${missing}.{0,50}(?:свидетельств\\p{L}*.{0,25}регистрац\\p{L}*|регистрационн\\p{L}*\\s+свидетельств\\p{L}*)|(?:свидетельств\\p{L}*.{0,25}регистрац\\p{L}*|регистрационн\\p{L}*\\s+свидетельств\\p{L}*).{0,50}${missing}`, "iu").test(normalized)) {
    return "К сожалению, мы не сможем Вам выдать займ без оригинала свидетельства о регистрации транспортного средства.";
  }
  return undefined;
}

/** Existing-loan support text is valid only for an explicit current-turn servicing request. */
function removeUnpromptedExistingContractRedirect(reply: string, input: Pick<AgentTurnInput, "text" | "currentTurnMessages">): string {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
  if (isExistingContractServiceRequest(text)) return reply;
  return reply
    // Remove the complete redirect even when the model copied only its
    // contact sentence and omitted the usual closing phrase.
    .replace(/(?:я\s+айлин\s*[—-]\s*виртуальн\p{L}*\s+помощник\s+по\s+вопросам\s+оформления\s+новых\s+займов\.?\s*)?если\s+у\s+вас\s+уже\s+оформлен\s+займ,?\s+пожалуйста,?\s+(?:позвоните|напишите)[\s\S]{0,300}?(?:whatsapp\s*\+?\d[\d\s-]*|\+?\d[\d\s-]{6,})\.?\s*/giu, "")
    .replace(/(?:я\s+айлин\s*[—-]\s*виртуальн\p{L}*\s+помощник\s+по\s+вопросам\s+оформления\s+новых\s+займов\.?\s*)?если\s+у\s+вас\s+уже\s+оформлен\s+займ,?\s+пожалуйста,?\s+позвоните[\s\S]{0,500}?(?:решить\s+ваш\s+вопрос|помогут\s+решить\s+ваш\s+вопрос)\.?/giu, "")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

function residencePatchFromExplicitClientText(input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages">, patch: Partial<ApplicationFacts>, previousFacts: ApplicationFacts, _modelAssertedResidence: boolean): Partial<ApplicationFacts> {
  const text = input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text;
  const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  const explicitChuyCategory = explicitChuyResidenceCategory(text);
  // A direct correction «это не в Чуйской» must win over the broad Chuy
  // locality matcher below, which otherwise sees only the word «Чуйской».
  // The exact other locality can remain unknown; the eligibility category is
  // nevertheless explicit and must be corrected immediately.
  if (explicitChuyCategory === "OTHER_KG") return {
    // Clear the former Chuy/Bishkek locality: preserving it would let the
    // catalogue re-derive the old BISHKEK_CHUY category in reconciliation.
    residenceText: undefined,
    residenceRegion: "Другой регион Кыргызстана",
    residenceCategory: "OTHER_KG",
    residenceNeedsClarification: false
  };
  if (explicitChuyCategory === "BISHKEK_CHUY") {
    const locality = resolveKyrgyzstanLocality(text);
    return {
      residenceText: locality?.locality ?? "Чуйская область",
      residenceRegion: "Чуйская область",
      residenceCategory: "BISHKEK_CHUY",
      residenceNeedsClarification: false
    };
  }
  if (isResidenceClarificationQuestion(lastAssistant)) {
    if (!hasPendingResidenceClarification(previousFacts)) return {};
    // These fields can only arrive here from the dedicated clarification
    // normalizer above; preserve its server-validated decision instead of
    // reopening the same Chuy question in the final reconciliation.
    if (patch.residenceRegion && patch.residenceCategory && patch.residenceNeedsClarification === false) return {
      residenceText: patch.residenceText ?? previousFacts.residenceText,
      residenceRegion: patch.residenceRegion,
      residenceCategory: patch.residenceCategory,
      residenceNeedsClarification: false
    };
    return {
      residenceText: previousFacts.residenceText ?? text?.trim(),
      residenceRegion: undefined,
      residenceCategory: undefined,
      residenceNeedsClarification: true
    };
  }
  if (isVehicleRestrictionStatement(text ?? "")) return {};
  // A guarantor prompt can mention residence requirements, but a plain answer
  // to it is never a new registration answer. Still allow an explicit city or
  // registration correction here: residence can change at every stage.
  const localityInGuarantorReply = residenceLocalityFromClientText(text);
  const explicitlyMentionsResidence = /(?:пропис\p{L}*|зарегистрир\p{L}*|регистрац\p{L}*|место\s+жительств\p{L}*)/iu.test(text ?? "");
  if ((isGuarantorQuestion(lastAssistant) || isGuarantorParkingAlternativeQuestion(lastAssistant)) && !localityInGuarantorReply && !explicitlyMentionsResidence) return {};
  const isResidenceCollectionStage = isResidenceCollectionQuestion(lastAssistant);
  // A model marker is not evidence of a correction. A saved locality may be
  // changed only when the current client text itself is a residence update;
  // otherwise a stale or hallucinated `residenceStatement` could overwrite
  // a correctly recorded place on a later workflow or summary refresh.
  const isResidenceUpdate = isResidenceUpdateTurn(text ?? "", lastAssistant, previousFacts);
  const clientLocality = localityInGuarantorReply ?? residenceLocalityFromClientText(text);
  // The main model can provide a spelling hint only after an explicit
  // residence statement/correction in this turn. It cannot turn an unrelated
  // message such as «давай 200» into a locality it remembered or guessed
  // from history.
  const normalizedModelLocality = isResidenceUpdate && patch.residenceText !== previousFacts.residenceText
    ? resolveKyrgyzstanLocality(patch.residenceText)
    : undefined;
  const locality = clientLocality ?? normalizedModelLocality;
  const shortLocalityCorrection = Boolean(locality && (clientLocality || isResidenceCollectionStage) && (text?.trim().split(/\s+/u).length ?? 0) <= 3);
  // A bare locality after any earlier answer is a client correction, not a
  // reference to the old residence. Its canonical category must supersede a
  // stale OTHER_KG value before the guarantor gate is evaluated.
  if (shortLocalityCorrection) {
    return {
      residenceText: locality!.locality,
      residenceRegion: locality!.residenceRegion,
      residenceCategory: locality!.category,
      residenceNeedsClarification: false
    };
  }
  // Outside an explicit residence statement, only an actual locality in the
  // client message can change residence. Do not store a vague phrase as an
  // unresolved residence: the server will ask its clear stage question.
  if (!isResidenceUpdate && !clientLocality) return {};
  if (!locality && !isPlausibleResidenceStatement(text ?? "", isResidenceCollectionStage)) return {};
  if (!locality) return {
    residenceText: text?.trim(),
    residenceRegion: undefined,
    residenceCategory: undefined,
    residenceNeedsClarification: true
  };
  return {
    // Store the server-canonical SOATE/alias name. The original inbound
    // message remains in conversation history; eligibility must use the
    // normalized locality rather than a spelling such as «чалупон ата».
    residenceText: locality.locality,
    residenceRegion: locality.residenceRegion,
    residenceCategory: locality.category,
    residenceNeedsClarification: false
  };
}

/** Extract an explicit first-person locality from a mixed stage answer before
 * resolving it against SOATE. The resolver deliberately rejects long whole
 * sentences, so «без изъятия, я из Токмока» needs this narrow boundary. */
function residenceLocalityFromClientText(text: string | undefined) {
  const direct = resolveKyrgyzstanLocality(text);
  if (direct || !text) return direct;
  const match = text.match(/(?:^|[,.!;]\s*|\s)я\s+(?:из|в)\s+(?:г\.?(?:\s*)?)?([\p{L}-]+(?:\s+[\p{L}-]+){0,2})(?=$|[,.!?;])/iu);
  return match?.[1] ? resolveKyrgyzstanLocality(match[1]) : undefined;
}

function isResidenceClarificationQuestion(text: string): boolean {
  return /это\s+в\s+чуйской\s+области/iu.test(text);
}

function hasUnresolvedResidence(facts: ApplicationFacts): boolean {
  return facts.residenceNeedsClarification === true && !facts.residenceRegion && !facts.residenceCategory;
}

/** A server-generated Chuy question remains pending until a category is set.
 * Older cards may lack `residenceNeedsClarification`, so that flag must not
 * make a clear yes/no answer impossible to apply. */
function hasPendingResidenceClarification(facts: ApplicationFacts): boolean {
  return !facts.residenceRegion && !facts.residenceCategory;
}

function residenceClarificationDecision(text: string): "accept" | "reject" | undefined {
  const normalized = text.trim();
  if (clearAffirmation(normalized) || /(?:да|верно|именно)[^.!?]{0,40}чуйск|чуйск[^.!?]{0,40}(?:да|верно|именно)/iu.test(normalized)) return "accept";
  if (clearNegation(normalized) || /(?:не\s+в\s+чуйск|за\s+пределами\s+чуйск|друг(?:ой|ая)\s+регион|не\s+чуйск)/iu.test(normalized)) return "reject";
  return undefined;
}

/** Car restrictions are never an address, even if they start with «в». */
function isVehicleRestrictionStatement(text: string): boolean {
  return /(?:арест\p{L}*|кредит\p{L}*|залоге|ограничени\p{L}*)/iu.test(text);
}

function isPlausibleResidenceStatement(text: string, isResidenceCollectionStage: boolean): boolean {
  if (isVehicleRestrictionStatement(text)) return false;
  if (/(?:пропис\p{L}*|зарегистрир\p{L}*|регистрац\p{L}*|место\s+жительств\p{L}*)/iu.test(text)) return true;
  // A client question is never an unnamed settlement. Without this guard a
  // reply like «сколько дадите» to the residence prompt was persisted as a
  // locality and immediately converted into the spurious Chuy yes/no branch.
  if (/[?？]/u.test(text) || /(?:скольк\p{L}*|дад\p{L}*|получ\p{L}*|деньг\p{L}*|сумм\p{L}*|займ\p{L}*)/iu.test(text)) return false;
  // A bare city/locality can be a valid answer to the canonical collection
  // question, but a multiword car-status phrase cannot be stored as one.
  return isResidenceCollectionStage && /^[\p{L}-]+(?:\s+[\p{L}-]+){0,2}[.!?\s]*$/u.test(text.trim());
}

function isResidenceCollectionQuestion(text: string): boolean {
  return /(?:пропис|зарегистрирован|место\s+жительств)/iu.test(text);
}

/** A plain registration statement supplies the active workflow field. Even
 * if the KB model hallucinates a related FAQ answer, it must not surface it
 * as an unsolicited offer about guarantors or any other condition. */
function isResidenceWorkflowFactResponse(text: string, lastAssistant: string, workflowFollowUp: string): boolean {
  const normalized = text.trim();
  if (!normalized || /[?？]/u.test(normalized)) return false;
  const asksResidence = isResidenceCollectionQuestion(`${lastAssistant} ${workflowFollowUp}`);
  if (!asksResidence) return false;
  return Boolean(residenceLocalityFromClientText(normalized))
    || /(?:я\s+в|я\s+из|пропис\p{L}*\s*(?:в|на)|зарегистрир\p{L}*\s*(?:в|на))/iu.test(normalized);
}

/**
 * The workflow stage is not a permission boundary for corrections. This gate
 * admits only a direct statement about the client's own registration/location
 * and is deliberately narrower than a bare city mention: office addresses,
 * travel plans and a spouse's city must leave the lead card untouched.
 */
function isResidenceUpdateTurn(text: string, lastAssistant: string, previousFacts: ApplicationFacts): boolean {
  // «В гражданском» is a family-status correction, not a locality.
  if (looksLikeUnofficialMarriageStatement(text)) return false;
  if (isResidenceCollectionQuestion(lastAssistant)) return true;
  if (/(?:пропис\p{L}*|зарегистрир\p{L}*|регистрац\p{L}*|место\s+жительств\p{L}*)/iu.test(text)) return true;
  if (explicitChuyResidenceCategory(text)) return true;
  if (!previousFacts.residenceRegion && !previousFacts.residenceText) return false;
  return /^(?:я\s+)?(?:вообще(?:-?то)?\s+)?(?:живу|нахожусь|в|из)\s+(?:г\.?\s*)?[\p{L}-]+(?:\s+[\p{L}-]+){0,3}[.!?\s]*$/iu.test(text.trim());
}

/** Explicit client statements about Chuy override a stale residence category. */
function explicitChuyResidenceCategory(text: string | undefined): "BISHKEK_CHUY" | "OTHER_KG" | undefined {
  const normalized = text?.toLocaleLowerCase("ru-RU") ?? "";
  if (!normalized) return undefined;
  if (/(?:^|\s)(?:это\s+)?(?:точно\s+)?не\s+(?:в\s+)?чу[йи](?:ской|ская)?(?:\s+област\p{L}*)?(?:$|[\s.!?,])/iu.test(normalized)) return "OTHER_KG";
  if (/(?:жив[уе]\p{L}*|пропис\p{L}*|зарегистрир\p{L}*|это)\s+(?:в\s+)?чу[йи](?:ской|ская)?(?:\s+област\p{L}*)?(?:$|[\s.!?,])/iu.test(normalized)) return "BISHKEK_CHUY";
  return undefined;
}

function looksLikeUnofficialMarriageStatement(text: string): boolean {
  return /(?:гражданск\p{L}*\s+брак|брак\p{L}*\s+гражданск\p{L}*|в\s+гражданск\p{L}*|официально\s+(?:не\s+)?распис|брак\s+не\s+регистрир|не\s+регистрир\p{L}*\s+брак|не\s+расписан)/iu.test(text);
}

function unofficialMarriageStatusFallback(text: string): "single" | undefined {
  return looksLikeUnofficialMarriageStatement(text) ? "single" : undefined;
}

function isFamilyStatusQuestion(text: string): boolean {
  return /семейн\p{L}*\s+положен\p{L}*[^?!\n]*(?:в\s+браке|в\s+разводе|не\s+в\s+браке)/iu.test(text);
}

function isPastMarriageStatusReply(text: string): boolean {
  const normalized = text.trim().toLocaleLowerCase("ru-RU");
  if (currentMarriageStatusCorrection(normalized)) return false;
  return /(?:в\s+браке\s+был(?:а)?|был(?:а)?\s+(?:женат|замужем)|раньше\s+(?:был(?:а)?\s+)?(?:в\s+браке|женат|замужем)|брак\s+(?:был|законч)|состоял(?:а)?\s+в\s+браке)/iu.test(normalized);
}

function familyPatchFromClearReply(input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages">, facts: ApplicationFacts, modelPatch: Partial<ApplicationFacts>): Partial<ApplicationFacts> {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim().toLocaleLowerCase("ru-RU");
  const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  const patch: Partial<ApplicationFacts> = {};
  // A present-tense correction takes precedence over an earlier divorce in
  // the same message and over the previous divorce-purchase question.
  if (currentMarriageStatusCorrection(text)) return { familyStatus: "married" };
  if (isFamilyStatusQuestion(lastAssistant) && isPastMarriageStatusReply(text)) return { familyStatus: "divorced" };
  // Once the client is already recorded as divorced, the question about when
  // the car was bought has a different meaning from the family-status
  // question. A short answer such as «в браке» describes the purchase, not a
  // change back to married. Do not let a model patch erase that distinction.
  if (facts.familyStatus === "divorced" && isDivorcePurchaseTimingQuestion(lastAssistant)) {
    patch.familyStatus = "divorced";
    if (isBoughtDuringMarriageReply(text)) {
      patch.vehicleBoughtDuringMarriage = true;
      patch.vehiclePurchasedDuringMarriage = true;
    } else if (isBoughtOutsideMarriageReply(text)) {
      patch.vehicleBoughtDuringMarriage = false;
      patch.vehiclePurchasedDuringMarriage = false;
    }
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
    if (isBoughtDuringMarriageReply(text)) {
      patch.vehicleBoughtDuringMarriage = true;
      patch.vehiclePurchasedDuringMarriage = true;
    } else if (isBoughtOutsideMarriageReply(text)) {
      patch.vehicleBoughtDuringMarriage = false;
      patch.vehiclePurchasedDuringMarriage = false;
    }
  }
  if (familyStatus === "married") {
    if (/(?:супруг[аи]?.{0,50}(?:не\s+в\s+бишкек|в\s+отъезд|за\s+границ)|(?:не\s+в\s+бишкек|в\s+отъезд|за\s+границ).{0,50}супруг[аи]?)/iu.test(text)) patch.spouseAway = true;
    const officeConsentQuestion = isOfficeConsentQuestion(lastAssistant);
    // The model interprets the whole answer in the context of the preceding
    // question. Regexes below are only a fallback for terse replies it left
    // undecided; they must never overwrite a semantic model decision.
    if (officeConsentQuestion && modelPatch.spouseConsentAtOffice === undefined && clearAffirmation(text)) patch.spouseConsentAtOffice = true;
    if (officeConsentQuestion && modelPatch.spouseConsentAtOffice === undefined && clearNegation(text)) patch.spouseConsentAtOffice = false;
    if (/(?:согласие|нотариальн).{0,40}(?:готов|есть\s+на\s+руках|оформил[а-яё]*)/iu.test(text)) patch.spouseConsentReady = true;
  }
  return patch;
}

/** Detects an explicit statement that the client is married now, rather than
 * a historical mention of marriage or divorce. */
function currentMarriageStatusCorrection(text: string): boolean {
  return /(?:сейчас|текущ\p{L}*|опять|снова).{0,35}(?:жен\p{L}*|замуж\p{L}*|(?:в\s+)?браке)|(?:жен\p{L}*|замуж\p{L}*).{0,35}(?:сейчас|текущ\p{L}*|опять|снова)/iu.test(text);
}

function isOfficeConsentQuestion(text: string): boolean {
  return /(?:согласие|нотариальн).{0,100}(?:офис|здани)/iu.test(text);
}

function familyTransitionNotice(input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages">, previous: ApplicationFacts, current: ApplicationFacts): string | undefined {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").toLocaleLowerCase("ru-RU");
  const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  // The model may reliably resolve a terse contextual reply (for example
  // «в» after «Вы в браке?») even though local text regexes cannot. Once a
  // valid status changed, server-owned next-stage prose replaces any model
  // technical fallback such as «Нужно уточнение».
  if (previous.familyStatus !== current.familyStatus && current.familyStatus === "married") {
    return nextFamilyStageQuestion(current);
  }
  if (previous.familyStatus !== current.familyStatus && current.familyStatus === "divorced") {
    // Return the complete server-owned follow-up. This replaces, rather than
    // prefixes, a model acknowledgement and avoids saying the same consent
    // rule twice in one reply.
    return nextFamilyStageQuestion(current);
  }
  if (previous.familyStatus !== current.familyStatus && current.familyStatus === "single") {
    return "Нотариальное согласие супруга или супруги в таком случае не требуется.";
  }
  if (previous.vehicleBoughtDuringMarriage !== current.vehicleBoughtDuringMarriage && current.familyStatus === "divorced" && (isDivorcePurchaseTimingQuestion(lastAssistant) || isBoughtDuringMarriageReply(text) || isBoughtOutsideMarriageReply(text))) {
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
  return /(?:автомобил|авто).{0,80}(?:приобрет|куп).{0,80}(?:до\s+брака|во\s+время\s+брака|после\s+развода)/iu.test(text);
}

function isBoughtDuringMarriageReply(text: string): boolean {
  return divorcePurchaseTimingFallback(text) === true
    || /^(?:в(?:о)?\s+)?браке[.!]?$/iu.test(text.trim())
    || /(?:куп(?:ил|ила|лен|лена)|приобр[её]л[а-яё]*).{0,40}(?:в(?:о)?\s+)?браке|(?:в(?:о)?\s+)?браке.{0,40}(?:куп(?:ил|ила|лен|лена)|приобр[её]л[а-яё]*)/iu.test(text);
}

function isBoughtOutsideMarriageReply(text: string): boolean {
  return divorcePurchaseTimingFallback(text) === false
    || /(?:после\s+развод|до\s+(?:брака|свадьбы)|раньше\s+(?:брака|свадьбы)|до\s+того\s+как\s+(?:пожен|распис)|наверное\s+до\b|(?:куп(?:ил|ила|лен|лена)|приобр[её]л[а-яё]*).{0,40}(?:развод|до\s+брака)|(?:развод|до\s+брака).{0,40}(?:куп(?:ил|ила|лен|лена)|приобр[её]л[а-яё]*))/iu.test(text);
}

/** Outage fallback for short contextual answers to the exact divorce question. */
function divorcePurchaseTimingFallback(text: string): boolean | undefined {
  const normalized = text.trim().toLocaleLowerCase("ru-RU").replace(/[.!?]+$/u, "").trim();
  if (/^(?:в|во|время|во\s+время|в\s+браке|во\s+время\s+брака|в\s+период\s+брака)$/u.test(normalized)) return true;
  if (/^(?:после|после\s+развода|не\s+в|не\s+в\s+браке|вне|вне\s+брака|до|до\s+брака|до\s+свадьбы|раньше|раньше\s+брака|наверное\s+до(?:\s+ещ[её])?)$/u.test(normalized)) return false;
  return undefined;
}

function requiresGuarantorForFacts(facts: ApplicationFacts): boolean {
  return facts.requestedProgram === "without_storage" && facts.residenceCategory === "OTHER_KG";
}

function normalizeConciseEligibilityReply(
  reply: string,
  facts: ApplicationFacts,
  questionText: string,
  sourceKeys?: string[]
): string {
  const text = questionText.toLocaleLowerCase("ru-RU");
  const mentionsGuarantor = /поручител\p{L}*/iu.test(text);
  const guarantorSource = sourceKeys?.some((key) => /guarantor|поручител/iu.test(key)) === true;
  if (mentionsGuarantor && guarantorSource && facts.requestedProgram && facts.residenceCategory) {
    return requiresGuarantorForFacts(facts)
      ? "Да, в Вашем случае потребуется поручитель."
      : "Нет, в Вашем случае поручитель не требуется.";
  }

  if (/(?:супруг|супруги|супругу|жен[ау]|муж)/iu.test(text)) {
    if (facts.familyStatus === "married" && facts.spouseConsentReady !== true) {
      return "Да, потребуется нотариальное согласие супруга или супруги.";
    }
    if (facts.familyStatus === "single" || facts.familyStatus === "divorced") {
      return "Нет, в Вашем случае супруга или супруг не требуется.";
    }
    if (facts.spouseConsentReady === true) {
      return "Нет, присутствие супруга или супруги не требуется.";
    }
  }
  return reply;
}

function guarantorResetForProgramChange(previous: ApplicationFacts, patch: Partial<ApplicationFacts>): Partial<ApplicationFacts> {
  const nextProgram = patch.requestedProgram;
  if (!nextProgram || nextProgram === previous.requestedProgram) return {};
  return { guarantorAvailable: undefined, guarantorAlternativeDeclined: undefined };
}

function guarantorResetForEligibilityChange(previous: ApplicationFacts, current: ApplicationFacts): Partial<ApplicationFacts> {
  if (!requiresGuarantorForFacts(previous) && requiresGuarantorForFacts(current)) {
    return { guarantorAvailable: undefined, guarantorAlternativeDeclined: undefined };
  }
  return {};
}

/** Server-side context gate used before any AI call. It prevents an obsolete
 * guarantor action from becoming the apparent current stage after programme
 * or residence has already changed in the persisted lead card. */
export function suppressInactiveGuarantorPrompts(messages: Stage1Message[], facts: ApplicationFacts): Stage1Message[] {
  if (requiresGuarantorForFacts(facts)) return messages;
  return messages
    .map((message) => message.author === "ai" ? { ...message, body: stripInactiveGuarantorWorkflowProse(message.body) } : message)
    .filter((message) => message.author !== "ai" || Boolean(message.body.trim()));
}

function stripInactiveGuarantorWorkflowProse(reply: string): string {
  return reply
    .split(GUARANTOR_PARKING_ALTERNATIVE).join("")
    .split(GUARANTOR_REQUIREMENTS).join("")
    .replace(/\s*(?:и\s+вам\s+)?потребуется\s+поручител\s*:\s*(?:-\s*[^\n]+\s*){1,4}у\s+вас\s+есть\s+(?:такой\s+)?поручител\s*\?/giu, "")
    .replace(/\s*поручител\s+обязателен[^.!?\n]{0,180}(?:можем|можно|давайте)[^?!\n]{0,180}(?:стоянк|постановк)[^?!\n]*\?/giu, "")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function isGuarantorQuestion(text: string): boolean {
  return /(?:есть\s+ли\s+у\s+вас\s+(?:такой\s+)?поручител|у\s+вас\s+есть\s+(?:такой\s+)?поручител)/iu.test(text);
}

/** Outage fallback after the context classifier receives the active prompt. */
function isGuarantorContextClarification(text: string): boolean {
  const normalized = text.trim().toLocaleLowerCase("ru-RU");
  return /^(?:(?:а|и|ну)\s+)?(?:какой(?:\s+(?:такой|именно|поручител\p{L}*))?|что\s+(?:за|такое)\s+(?:поручител\p{L}*|это)|кто\s+(?:такой|это)\s+(?:поручител\p{L}*|он)|зачем(?:\s+(?:он|нужен))?|почему(?:\s+(?:он|нужен))?|какие\s+(?:у\s+него\s+)?требовани\p{L}*)[?!…\s.]*$/iu.test(normalized);
}

function isGuarantorParkingAlternativeQuestion(text: string): boolean {
  const question = lastAssistantQuestion(text) ?? text;
  return /(?:можем|можно|давайте|готовы|предлагаем).{0,80}(?:рассмотреть|перейти|выбрать|оформить).{0,160}(?:стоянк|постановк\p{L}*\s+автомобил)/iu.test(question);
}

function isActiveGuarantorParkingAlternative(text: string, facts: ApplicationFacts): boolean {
  return requiresGuarantorForFacts(facts)
    && facts.guarantorAvailable === false
    && !facts.guarantorAlternativeDeclined
    && isGuarantorParkingAlternativeQuestion(text);
}

function clearAffirmation(text: string): boolean {
  return /^(?:да|ага|угу|ок(?:ей)?|okay|ok|хорошо|ладно|конечно|подходит|устраивает|соглас(?:ен|на)|давайте|будет|будут|есть|имеется|yes|oui|ооба|оа|бар)[.!]?$/iu.test(text.trim());
}

function clearNegation(text: string): boolean {
  return /^(?:нет|неа|нету|не\s+будет|не\s+имеется|no|жок)$/iu.test(text);
}

function vehicleYearCorrectionPatch(lastAssistantReply: string, text: string | undefined): Partial<ApplicationFacts> {
  if (!/\d{4}\s+год\s+ещ[её]\s+не\s+наступил[\s\S]{0,120}верн(?:ый|ого)\s+год\s+выпуска/iu.test(lastAssistantReply)) return {};
  const reply = text?.trim() ?? "";
  const fullYear = reply.match(/(?<!\d)((?:19|20)\d{2})(?!\d)/u)?.[1];
  const shortYear = reply.match(/(?<!\d)(\d{2})\s*(?:г(?:од(?:а)?)?\.?)(?!\p{L})/iu)?.[1];
  const vehicleYear = fullYear ? Number(fullYear) : shortYear ? 2000 + Number(shortYear) : undefined;
  return vehicleYear === undefined ? {} : { vehicleYear, reportedInvalidVehicleYear: null };
}

/** Extract a full or short year only while the immediately preceding server
 * question explicitly asks for the vehicle's year of manufacture. */
function vehicleYearAnswerPatch(lastAssistantReply: string, text: string | undefined): Partial<ApplicationFacts> {
  if (!/(?:год\s+выпуска|какого\s+года\s+(?:ваш(?:а|его)?\s*)?(?:автомобил|машин|авто))/iu.test(lastAssistantReply)) return {};
  const reply = text?.trim() ?? "";
  const fullYear = reply.match(/^(?:год(?:а)?\s*)?((?:19|20)\d{2})(?:\s*(?:г(?:од(?:а)?)?\.?)?)?[.!]?$/iu)?.[1];
  const shortYear = reply.match(/^(?:год(?:а)?\s*)?(\d{2})(?:\s*(?:г(?:од(?:а)?)?\.?)?)?[.!]?$/iu)?.[1];
  const vehicleYear = fullYear ? Number(fullYear) : shortYear ? 2000 + Number(shortYear) : undefined;
  return vehicleYear !== undefined ? { vehicleYear, reportedInvalidVehicleYear: null } : {};
}

/** A deterministic safety net for the named alternative after its semantic
 * classifier has run but could not make a decision. Generic "да" deliberately
 * stays model-owned; this accepts only a direct choice of parking. */
function explicitlyAcceptsParkingAlternative(text: string): boolean {
  return /(?:\b(?:понял(?:а)?|тогда|давайте|хорошо|ладно|ок(?:ей)?)\b.{0,40}(?:стоянк|парковк)|(?:стоянк|парковк).{0,40}\b(?:тогда|давайте|подходит)\b|\bу\s+меня\b.{0,30}(?:стоянк|парковк)|(?:^|\s)д\s+(?:стоянк|парковк))/iu.test(text);
}

/** Regex fallback for a direct fact after the semantic parking classifier is unavailable or undecided. */
function explicitlyStatesGuarantorAvailable(text: string): boolean {
  return /(?:^|\s)(?:у\s+меня\s+)?(?:есть|имеется|будет|найду|приведу)\s+(?:такой\s+)?поручител\p{L}*(?:[.!]?\s*)$/iu.test(text.trim());
}

/** Regex fallback after the semantic guarantor classifier. This deliberately
 * covers a standalone promise («поищу») whose omitted noun is supplied by the
 * active guarantor question. */
function expressesGuarantorSearchIntent(text: string): boolean {
  return /^(?:(?:я\s+)?(?:поищу|найду|постараюсь\s+найти|буду\s+искать|организую|приведу)|(?:поищу|найду|буду\s+искать)\s+поручител\p{L}*)[.!\s]*$/iu.test(text.trim());
}

/** A pause is allowed only for an explicit request to defer the dialogue.
 * This is a persistence guard for the model's semantic decision, not a
 * replacement for it. */
function isExplicitPauseRequest(input: Pick<AgentTurnInput, "text" | "currentTurnMessages">): boolean {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
  return /^(?:потом\s+(?:напиш\p{L}*|отвеч\p{L}*|продолж\p{L}*)|вернусь\s+позже|давайте\s+(?:продолжим\s+)?потом|сейчас\s+(?:некогда|не\s+могу|занят(?:а)?|занят)|подумаю\s+и\s+напишу|пока\s+не\s+решил(?:а)?)[.!\s]*$/iu.test(text);
}

function guarantorPatchFromClearReply(
  input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages">,
  facts: ApplicationFacts,
  modelPatch: Partial<ApplicationFacts>
): Partial<ApplicationFacts> {
  if (!requiresGuarantorForFacts(facts)) return {};
  const lastAssistantReply = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim().toLocaleLowerCase("ru-RU");
  if (isActiveGuarantorParkingAlternative(lastAssistantReply, facts)) {
    // The semantic classifier (or the main model) has already interpreted
    // this exact reply. Regexes are intentionally only the outage/undecided
    // fallback and cannot replace that decision.
    if (modelPatch.requestedProgram !== facts.requestedProgram || modelPatch.guarantorAlternativeDeclined !== facts.guarantorAlternativeDeclined) return {};
    if (clearAffirmation(text)) return { requestedProgram: "parking", guarantorAlternativeDeclined: false };
    if (clearNegation(text)) return { guarantorAlternativeDeclined: true };
    return {};
  }
  if (!isGuarantorQuestion(lastAssistantReply)) return {};
  if (modelPatch.guarantorAvailable !== facts.guarantorAvailable) return {};
  if (clearAffirmation(text)) return { guarantorAvailable: true, guarantorAlternativeDeclined: false };
  if (clearNegation(text)) return { guarantorAvailable: false, guarantorAlternativeDeclined: false };
  return {};
}

const GUARANTOR_REQUIREMENTS = "Вам потребуется поручитель:\n- возраст от 25 лет\n- проживает в г. Бишкек или Чуйской области\n- должен лично присутствовать при выдаче займа и иметь с собой ID (паспорт)\nУ Вас есть такой поручитель?";
const GUARANTOR_REQUIREMENTS_AFTER_CONTEXT = `И ${GUARANTOR_REQUIREMENTS}`;
const GUARANTOR_CONTEXT_CLARIFICATION = "Поручитель нужен только по программе без изъятия автомобиля, если прописка клиента находится за пределами Бишкека и Чуйской области. По программе со стоянкой поручитель не требуется. Поручителю должно быть не менее 25 лет; он должен проживать в Бишкеке или Чуйской области, лично присутствовать при выдаче займа и иметь с собой ID (паспорт).";
const GUARANTOR_PARKING_ALTERNATIVE = "Поручитель обязателен для программы без изъятия в Вашем регионе. Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?";
const FINAL_QUESTIONS_PROMPT = "Есть ли у Вас ещё вопросы?";

function isFinalQuestionsPrompt(text: string): boolean {
  return /есть\s+ли\s+у\s+вас\s+(?:ещ[её]\s+)?вопрос/iu.test(text);
}

/** Regex is only the fallback when semantic final-answer recognition failed. */
function finalQuestionsPatchFromClearReply(
  input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages">,
  facts: ApplicationFacts,
  modelPatch: Partial<ApplicationFacts>
): Partial<ApplicationFacts> {
  const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  if (!isFinalQuestionsPrompt(lastAssistant) || modelPatch.clientClosed !== facts.clientClosed) return {};
  const reply = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
  return /^(?:нет|неа|нету|вс[её]\s+понятно|ничего\s+больше\s+не\s+нужно)(?:[,.!\s]|вс[её]\s+понятно)*$/iu.test(reply)
    ? { clientClosed: true }
    : {};
}

function lastAssistantQuestion(text: string): string | undefined {
  const sentences = text.replace(/\s+/gu, " ").match(/(?:^|[.!]\s+)([^?.]{1,500}\?)/gu);
  return sentences?.at(-1)?.replace(/^[.!]\s*/u, "").trim();
}

function clarificationOf(question: string): string {
  const normalized = question.replace(/^подскажите,?\s*пожалуйста\s*[:,]?\s*/iu, "").trim();
  return `Уточните, пожалуйста: ${normalized || question}`;
}

/**
 * Do not acknowledge a binary answer until server state confirms its meaning.
 * A new client question is deliberately left to the knowledge/workflow path:
 * it is not an answer to the preceding binary question.
 */
function unresolvedBinaryDecisionReply(
  input: Pick<AgentTurnInput, "facts" | "messages" | "text" | "currentTurnMessages">,
  facts: ApplicationFacts,
  loanQuestionKind: LoanQuestionKind,
): string | undefined {
  const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  const clientReply = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
  // A limit/rate question can be phrased without a question mark ("а денег
  // сколько"). It is a new request, never an ambiguous answer to the
  // preceding binary stage.
  // A short factual question such as «какой поручитель» often arrives without
  // a question mark. It must reach the approved-knowledge path, rather than
  // being misread as an unclear yes/no answer to the preceding stage.
  if (!clientReply || workflowWhyReply(input) || isLikelyKnowledgeQuestion(clientReply) || detectMoneyMentions(clientReply).length > 0 || isMaximumLoanKnowledgeQuestion(clientReply) || isLoanRateQuestion(loanQuestionKind)) return undefined;
  const repeatQuestion = (): string | undefined => {
    const question = lastAssistantQuestion(lastAssistant);
    return question ? clarificationOf(question) : undefined;
  };
  if (isResidenceClarificationQuestion(lastAssistant) && hasPendingResidenceClarification(facts)) {
    return repeatQuestion() ?? "Уточните, пожалуйста: это в Чуйской области?";
  }
  if (isActiveGuarantorParkingAlternative(lastAssistant, facts)) {
    return repeatQuestion() ?? clarificationOf(GUARANTOR_PARKING_ALTERNATIVE);
  }
  if (isGuarantorQuestion(lastAssistant) && requiresGuarantorForFacts(facts) && facts.guarantorAvailable === undefined) {
    // The guarantor prompt is a multi-line requirements block. Extracting
    // its last sentence can accidentally splice a bullet ending into a
    // question (for example «Бишкек или Чуйской области — должен...»).
    // Repeat the one grammatically complete server-owned clarification.
    return "Уточните, пожалуйста, есть ли у Вас такой поручитель?";
  }
  if (isOfficeConsentQuestion(lastAssistant) && facts.familyStatus === "married" && facts.spouseConsentAtOffice === undefined) {
    return repeatQuestion() ?? "Уточните, пожалуйста: Вам удобно оформить согласие при визите в офис?";
  }
  // A correction after the terminal question (amount, vehicle, programme,
  // locality, etc.) is new lead data, not an unclear answer to «Есть ли ещё
  // вопросы?». Let the recalculated workflow/limit response take priority.
  if (isFinalQuestionsPrompt(lastAssistant) && !facts.clientClosed && !hasMaterialLeadFactChange(input.facts, facts)) return repeatQuestion() ?? clarificationOf(FINAL_QUESTIONS_PROMPT);
  return undefined;
}

function hasMaterialLeadFactChange(previous: ApplicationFacts, current: ApplicationFacts): boolean {
  const keys: Array<keyof ApplicationFacts> = [
    "vehicleMake", "vehicleModel", "vehicleYear", "vehicleValue", "vehicleValueSourceCurrency",
    "requestedAmount", "requestedAmountSourceCurrency", "requestedProgram",
    "residenceText", "residenceRegion", "residenceCategory",
    "familyStatus", "vehicleBoughtDuringMarriage", "guarantorAvailable",
    "visitRequested", "visitDate", "visitTime"
  ];
  return keys.some((key) => previous[key] !== current[key]);
}

function removeForbiddenMetaPhrases(reply: string): string {
  return reply
    .replace(/(?:если\s+хотите,?\s+)?могу\s+помочь\s+дальше\s+по\s+оформлению[.!]?/giu, "")
    .replace(/продолжаем\s+оформление[.!]?/giu, "")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

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

/** Route factual/FAQ turns to the dedicated knowledge model. It decides
 * semantic relevance over the approved corpus; the workflow model may not
 * invent a company fact while waiting for that result. */
function requiresKnowledgeAnswer(input: Pick<AgentTurnInput, "text" | "currentTurnMessages">, patch: Partial<ApplicationFacts>, loanQuestionKind: LoanQuestionKind): boolean {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
  if (!text) return false;
  // Limits are a current server calculation. Rates, however, are approved
  // knowledge and must never be repeated from a hard-coded server string.
  if (loanQuestionKind === "maximum_limit" && !hasSeveralClientQuestions(text)) return false;
  if (loanQuestionKind === "loan_rate" || loanQuestionKind === "maximum_limit_and_rate") return true;
  return isIdentityQuestion(input)
    || isLikelyKnowledgeQuestion(text)
    || isOfficeLocationQuestion(text)
    || /(?:датчик|gps|гпс|трекер|стоянк|парковк|вещ|багаж|в\s+кредит|в\s+залоге|арест|ограничени|после\s+ремонт|не\s+езд(?:ит|иет)|не\s+едет|не\s*на\s*ходу)/iu.test(text)
    || patch.vehicleInCredit === true
    || patch.vehiclePledged === true
    || patch.vehicleArrested === true
    || patch.registrationRestricted === true;
}

function isLikelyKnowledgeQuestion(text: string): boolean {
  if (/[?？]/u.test(text)) return true;
  if (wordCount(text) < 2) return false;
  if (/(?:братишк|с\s+брат|сопровождающ|не\s+один|ребён|ребен|с\s+(?:собак|кошк))/iu.test(text.trim())) return true;
  return /(?:^|[.!;]\s*|\s+(?:а|и|ну)\s+)(?:(?:(?:а|и|ну)\s+)?(?:есть|можно|сколько|какой|какая|какие|где|когда|как|работает|ставите|нужн(?:о|а|ы)?|дадите|оформить|оформлю|приеду)(?=\s|$)|(?:так\s+)?что\s+делать(?:\s+дальше)?|(?:авто|машин).{0,40}(?:кредит|залоге|арест|ограничен)|(?:датчик|gps|гпс|трекер|парковк|стоянк|вещ|багаж)|(?:(?:а|и|ну|с)\s+)?(?:кофе|чай|wi-?fi|туалет|соб[ао](?:а)?к\p{L}*|животн\p{L}*).{0,60}(?:есть|можно\p{L}*|пуска\p{L}*|разреш\p{L}*))/iu.test(text.trim());
}

/** A policy candidate is deliberately narrow: the model decides whether the
 * new message continues it, while the server decides which prior policies are
 * safe to offer as such context. */
function contextualKnowledgePolicy(messages: Stage1Message[], text: string): ContextualKnowledgePolicy | undefined {
  if (!isContextualKnowledgeFollowUpText(text)) return undefined;
  const lastAssistant = [...messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  if (/(?:автомобил[ья]?\s+с\s+)?регион(?:ом)?\s*10.{0,80}(?:не\s+принимаем|не\s+оформля\p{L}*|не\s+сможем\s+продолжить)/iu.test(lastAssistant)) {
    return {
      key: "region_10_refusal",
      approvedAnswer: "К сожалению, по автомобилю с регионом 10 мы не сможем продолжить оформление. Если у Вас есть другой автомобиль без региона 10, можете сообщить его модель, год выпуска и ориентировочную стоимость."
    };
  }
  if (lastAssistant.trim()) {
    return { key: "previous_assistant_answer", approvedAnswer: lastAssistant };
  }
  return undefined;
}

function unsupportedKnowledgeFallbacks(text: string): string[] {
  const fallbacks: string[] = [];
  if (/(?:номинал\p{L}*|купюр\p{L}*|по\s*\d[\d\s]*\s*сом)/iu.test(text)) {
    fallbacks.push("По номиналу купюр у меня нет достоверной информации. Это можно уточнить у менеджера при визите.");
  }
  if (/(?:водк\p{L}*|алкогол\p{L}*|спиртн\p{L}*)/iu.test(text)) {
    fallbacks.push("По этому вопросу у меня нет достоверной информации. Это можно уточнить у менеджера при визите.");
  }
  return fallbacks;
}

function appendKnowledgeFallbacks(reply: string, fallbacks: string[]): string {
  // The knowledge model can already return an approved no-information
  // fallback in its own concise wording. Do not append a second server
  // fallback just because the wording differs slightly.
  if (/нет\s+достоверн\p{L}*\s+информац/iu.test(reply)) return reply.trim();
  const missing = fallbacks.filter((fallback) => !reply.includes(fallback));
  return [...new Set([reply.trim(), ...missing].filter(Boolean))].join("\n\n");
}

/**
 * Secondary branch classifiers may return a made-up `question` for a plain
 * acknowledgement such as «нету». Keep it only when both the original turn
 * and the extracted fragment actually contain interrogative language.
 */
function extractExplicitClientQuestion(candidate: unknown, clientReply: string): string | undefined {
  if (typeof candidate !== "string" || !candidate.trim()) return undefined;
  const question = candidate.trim();
  return isExplicitQuestionText(clientReply) && isExplicitQuestionText(question)
    ? question
    : undefined;
}

function isExplicitQuestionText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (/[?？]/u.test(normalized)) return true;
  if (wordCount(normalized) < 2) return false;
  return /(?:^|\s)(?:что|сколько|скок(?:а)?|какой|какая|какие|где|когда|как|почему|зачем|можно|нужно\s+ли|дадите|дадут|есть\s+ли|будет\s+ли|ставк\p{L}*|процент\p{L}*)(?:\s|$|[?？.,!])/iu.test(normalized)
    || /^(?:напомни|повтори|подтверж|назови|скажи)\b/iu.test(normalized)
    || /(?:у\s+меня|мо[яйеё])[^.!?]{0,80}(?:авто|автомобил|машин|трекер|gps|гпс|датчик)[^.!?]{0,80}(?:слом|авари|не\s+ед|не\s+работ|отвал|поврежд|эвакуатор)/iu.test(normalized)
    || /(?:слом|авари|не\s+ед|не\s+работ|отвал|поврежд|эвакуатор)[^.!?]{0,80}(?:авто|автомобил|машин|трекер|gps|гпс|датчик)/iu.test(normalized);
}

function wordCount(text: string): number {
  return text.trim().match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
}

/** A bare stage reply is not an unanswered FAQ. Do not let a model's generic
 * knowledge fallback leak to the client before the canonical next stage. */
function dropUnsupportedFallbackForNonQuestion(reply: string, text: string | undefined): string {
  if (isExplicitQuestionText(text ?? "")) return reply;
  return /к\s+сожалению,?\s+у\s+меня\s+нет\s+утвержд[её]нной\s+информации/iu.test(reply) ? "" : reply;
}

/**
 * Facts are persisted on the lead card, so old FAQ pairs do not help the
 * next turn. Keep only the most recent unfinished workflow prompt; otherwise
 * a knowledge model can answer a previously resolved question again.
 */
function activeWorkflowHistory(messages: Stage1Message[]): Array<{ author: string; text: string; createdAt: string }> {
  const lastAssistantMessage = [...messages].reverse().find((message) => message.author === "ai");
  if (!lastAssistantMessage) return [];
  const prompt = lastAssistantMessage.body
    .split(/\n\s*\n/gu)
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  if (!prompt || !isWorkflowPrompt(prompt)) return [];
  return [{ author: "ai", text: prompt, createdAt: lastAssistantMessage.createdAt }];
}

function recentKnowledgeHistory(messages: Stage1Message[]): Array<{ author: string; text: string; createdAt: string }> {
  return messages.slice(-8).map((message) => ({
    author: message.author,
    text: message.body,
    createdAt: message.createdAt
  }));
}

function isWorkflowPrompt(text: string): boolean {
  return /ориентировочн(?:ую|ая)\s+стоимост|какая\s+сумма\s+займа|без\s+изъяти|со\s+стоянк|ваш[ау]\s+пропис|подскажите.{0,80}(?:документ|фото|семейн|поручител|день|время|стоимост)/iu.test(text);
}

function isResponseToLastWorkflowQuestion(input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages">): boolean {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
  if (!text || text.length > 240 || /[?？]/u.test(text)) return false;
  // A short unpunctuated factual question must not be mistaken for a reply to
  // the preceding documents/programme prompt simply because it is concise.
  if (isLikelyKnowledgeQuestion(text)) return false;
  const lastAssistantMessage = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  return /ориентировочн(?:ую|ая)\s+стоимост|какая\s+сумма\s+займа|без\s+изъяти|со\s+стоянк|ваш[ау]\s+пропис|подскажите.{0,80}(?:документ|фото|семейн|поручител|день|время)/iu.test(lastAssistantMessage);
}

/** A short "зачем/почему" is a request to explain the current workflow
 * prompt, not a free-standing FAQ. It must never search the entire knowledge
 * base and accidentally select an unrelated condition such as spouse consent. */
function workflowStageExplanation(input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages">): string | undefined {
  const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  // Check the narrow conditional branches before their broader parent stages:
  // an office-consent prompt is also a family prompt, and a parking offer may
  // also mention the programme. The explanation must describe the exact
  // question the client is looking at.
  if (/год\s+ещ[её]\s+не\s+наступил|верн(?:ый|ую)\s+год\s+выпуска/iu.test(lastAssistant)) {
    return "Год выпуска нужен для проверки, подходит ли автомобиль под условия займа.";
  }
  if (/модель\s+и\s+год[^?]{0,100}(?:стоимост|цен)/iu.test(lastAssistant)) {
    return "Чтобы предварительно оценить автомобиль и рассчитать условия займа, нужны модель, год выпуска и ориентировочная стоимость.";
  }
  if (hasPendingMoneyCurrencyClarification(lastAssistant)) {
    return "Уточняем это, чтобы не ошибиться в сумме и валюте займа.";
  }
  if (/это\s+(?:ориентировочн\p{L}*\s+)?стоимост\p{L}*\s+автомобил\p{L}*\s+или\s+желаем\p{L}*\s+сумм\p{L}*\s+займ/iu.test(lastAssistant)) {
    return "Нужно понять, относится названная сумма к стоимости автомобиля или к желаемой сумме займа — от этого зависит расчёт.";
  }
  if (/какая\s+сумма\s+займа/iu.test(lastAssistant)) {
    return "Сумма нужна, чтобы проверить, подходит ли она под условия займа для Вашего автомобиля.";
  }
  if (isAmountLimitChoiceQuestion(lastAssistant)) {
    return "Нужно выбрать вариант, потому что запрошенная сумма превышает доступный лимит: можно уменьшить сумму или рассмотреть стоянку.";
  }
  if (/(?:можем|можно|давайте|готовы)[\s\S]{0,100}(?:рассмотреть|перейти|выбрать|оформить)[\s\S]{0,180}(?:стоянк|постановк)/iu.test(lastAssistant)) {
    return "Поскольку для программы без изъятия в Вашем регионе нужен поручитель, уточняем, готовы ли Вы рассмотреть вариант со стоянкой.";
  }
  if (isGuarantorQuestion(lastAssistant)) {
    return "Поручитель нужен только для займа без изъятия при прописке за пределами Бишкека и Чуйской области — это условие этой программы.";
  }
  if (/это\s+в\s+чуйской\s+области/iu.test(lastAssistant)) {
    return "Уточняем регион прописки, потому что от него зависят доступная сумма и условия займа.";
  }
  if (isResidenceCollectionQuestion(lastAssistant)) {
    return "Прописка нужна для предварительного расчёта доступной суммы и условий займа.";
  }
  if (isOfficeConsentQuestion(lastAssistant)) {
    return "Это нужно, чтобы заранее понять, как подготовить нотариальное согласие супруга или супруги к оформлению.";
  }
  if (isDivorcePurchaseTimingQuestion(lastAssistant)) {
    return "Это нужно, чтобы определить, потребуется ли свидетельство о расторжении брака.";
  }
  if (/супруг\p{L}*[^?]{0,180}(?:отменить\s+визит|перенести|когда\s+согласие\s+будет)/iu.test(lastAssistant)) {
    return "Это нужно, чтобы согласовать оформление с моментом, когда оригинал нотариального согласия будет у Вас.";
  }
  if (/(?:семейн\p{L}*\s+положени|в\s+браке,?\s+в\s+разводе|не\s+в\s+браке)/iu.test(lastAssistant)) {
    return "Семейное положение нужно, чтобы определить, потребуется ли согласие супруга или супруги и дополнительные документы.";
  }
  if (isDocumentRequest(lastAssistant)) {
    return "Документы нужны для оформления заявки и проверки данных автомобиля.";
  }
  if (isCarPhotoRequest(lastAssistant)) {
    return "Фотографии автомобиля помогут быстрее провести предварительную оценку.";
  }
  if (/(?:без\s+изъяти|со\s+стоянк|охраняемую\s+стоянк)/iu.test(lastAssistant)) {
    return "Выбор программы определяет, останется ли автомобиль у Вас или будет находиться на охраняемой стоянке, а также условия займа.";
  }
  if (/(?:на\s+какой\s+день|в\s+какое\s+время|день\s+и\s+время).{0,160}(?:подъехать|визит)|(?:подъехать|визит).{0,160}(?:на\s+какой\s+день|в\s+какое\s+время)/iu.test(lastAssistant)) {
    return "Дата и время нужны, чтобы менеджер мог предварительно подтвердить Ваш визит в офис.";
  }
  return undefined;
}

/** Regex fallback only for outages or an omitted model signal. The main model
 * recognises broader wording through `currentStageClarification`. */
function workflowWhyReply(input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages">): string | undefined {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
  if (!/^(?:(?:а|и|ну)\s+)?(?:(?:зачем|почему)(?:\s+(?:тебе|вам))?(?:\s+(?:эта|эта\s+самая|такая|данная)?\s*(?:информаци\p{L}*|данн\p{L}*|это|нужн\p{L}*))?|для\s+чего(?:\s+(?:эта|эта\s+самая|такая|данная)?\s*(?:информаци\p{L}*|данн\p{L}*|это|нужн\p{L}*))?|что\s+это\s+да[её]т)(?:(?:\s+вообще)?)[?!.…\s]*$/iu.test(text)) return undefined;
  return workflowStageExplanation(input);
}

function unknownVehicleValueReply(input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages">, facts: ApplicationFacts): string | undefined {
  if (facts.vehicleValue !== undefined) return undefined;
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
  const lastAssistantMessage = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  if (!/^(?:не\s+знаю|неизвестно|не\s+могу\s+(?:сказать|оценить)|без\s+понятия)[.!…]*$/iu.test(text)) return undefined;
  return /ориентировочн(?:ую|ая)\s+стоимост|стоимост[ьи]\s+автомобил|цен[уы]\s+автомобил/iu.test(lastAssistantMessage)
    ? "Для предварительного расчёта нужна хотя бы ориентировочная стоимость автомобиля."
    : undefined;
}

function waitingForVehicleValueReply(input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages">, facts: ApplicationFacts): string | undefined {
  if (facts.vehicleValue !== undefined) return undefined;
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").trim();
  const lastAssistantMessage = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  if (!/ориентировочн(?:ую|ая)\s+стоимост|стоимост[ьи]\s+автомобил|цен[уы]\s+автомобил/iu.test(lastAssistantMessage)) return undefined;
  return /^(?:(?:могу\s+)?прикин(?:у|уть)(?:,?\s*(?:секунд(?:у|очку)?|сейчас))?|секунд(?:у|очку)?|сейчас\s+(?:посмотрю|прикину)|подумаю|посчитаю|уточню)[.!…]*$/iu.test(text)
    ? "Хорошо, подождём."
    : undefined;
}

function appendRequiredWorkflowFollowUp(reply: string, followUp: string | undefined): string {
  if (!followUp) return reply;
  const parts = followUp.split("\n\n").filter(Boolean);
  const finalStagePrompt = parts.at(-1);
  // A model may include the canonical prompt several times in one paragraph,
  // while an earlier server guard can add one more copy. Remove every exact
  // copy before appending the canonical follow-up once, in its proper order.
  const base = finalStagePrompt
    ? reply.split(finalStagePrompt).join("").replace(/[ \t]{2,}/gu, " ").trim()
    : reply.trim();
  const missing = parts.filter((part) => !base.includes(part));
  return [base, ...missing].filter(Boolean).join("\n\n");
}

function isRegion10PolicyQuestion(input: Pick<AgentTurnInput, "text" | "currentTurnMessages">): boolean {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").toLocaleLowerCase("ru-RU");
  return /почему[^.!?]{0,80}(?:под\s*)?(?:10\s*)?регион|(?:10\s*)?регион[^.!?]{0,80}почему/u.test(text);
}

function appendContinuationAfterRegion10PolicyQuestion(reply: string, input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages" | "settings">, facts: ApplicationFacts): string {
  const messages = input.currentTurnMessages ?? (input.text === undefined ? [] : [{ index: 1, text: input.text }]);
  const exactPolicyAnswer = "Автомобили с регионом 10 у нас не принимаются в залог по правилам компании.";
  const officialGreeting = "Здравствуйте! Меня зовут Айлин. Я менеджер по оформлению новых займов автоломбарда «Молодой». Информируем Вас, что мы не выдаем займ под залог автомобиля с регионом 10.";
  const hasGreeting = reply.trimStart().startsWith(officialGreeting);
  const answer = hasGreeting ? reply.trimStart().slice(officialGreeting.length).trim() : reply.trim();
  if (messages.filter((message) => message.text.trim()).length < 2 || !isRegion10PolicyQuestion(input) || answer !== exactPolicyAnswer) return reply;
  if (!facts.vehicleModel || !facts.vehicleYear || !facts.vehicleValue || !facts.requestedAmount || facts.requestedProgram) return reply;
  const continuation = [
    exactPolicyAnswer,
    olderVehicleProgramNotice(input, facts),
    "Подскажите, пожалуйста, Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?"
  ].filter(Boolean).join("\n\n");
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
  return isClearOptionalStageRefusal(input, documentRequestPattern);
}

function isClearCarPhotoRefusal(input: Pick<AgentTurnInput, "text" | "messages" | "attachments">): boolean {
  return isClearOptionalStageRefusal(input, carPhotoRequestPattern);
}

const documentRequestPattern = /(?:отправьте|пришлите).{0,140}(?:(?:фото\s*)?(?:id|паспорт)|свидетельств\p{L}*\s+о\s+регистрац|\bстс\b)/iu;
const carPhotoRequestPattern = /(?:2\s*[–-]\s*3|несколько)\s+фотограф(?:и|ий).{0,80}автомоб|фотограф(?:и|ий).{0,80}автомоб/iu;

function isDocumentRequest(text: string): boolean {
  return documentRequestPattern.test(text);
}

function isCarPhotoRequest(text: string): boolean {
  return carPhotoRequestPattern.test(text);
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
  // A short non-question is not automatically a refusal: corrections such
  // as «я вообще-то из Балыкчы» must be able to change an earlier stage.
  // Optional stages close only on an unambiguous negative/deferral.
  if (/^(?:фото\s+нет|фотограф(?:и|ий)\s+нет)[.!?\s]*$/u.test(text)) return true;
  return /^(?:нет|неа|нету|их\s+нет|нет\s+с\s+собой|не\s+буду|не\s+хочу|не\s+могу|не\s+получится|не\s+получится\s+сейчас|не\s+найд(?:у|ется)|не\s+смогу\s+найти|позже|потом|отправлю\s+позже|пришлю\s+позже)(?:\s+(?:фото|фотографии|документ\p{L}*))?[.!\s]*$/u.test(text);
}

function optionalStageDeclineNoticeForTurn(previous: ApplicationFacts, current: ApplicationFacts): string | undefined {
  if (!previous.declinedDocuments && current.declinedDocuments) return "Хорошо, документы можно отправить позже.";
  if (!previous.declinedCarPhoto && current.declinedCarPhoto) return "Хорошо, фотографии автомобиля можно отправить позже.";
  return undefined;
}

function enforceOptionalStageRefusalMessage(reply: string, input: Pick<AgentTurnInput, "text" | "messages" | "attachments">): string {
  if (isClearDocumentsRefusal(input)) return "Хорошо, документы можно отправить позже.";
  if (isClearCarPhotoRefusal(input)) return "Хорошо, фотографии автомобиля можно отправить позже.";
  return reply;
}

function modelMoneyPatchForTurn(patch: Partial<ApplicationFacts>, input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "pricing">, hasMoney: boolean, _loanQuestionKind: LoanQuestionKind): Partial<ApplicationFacts> {
  const result = Object.fromEntries(Object.entries(patch).filter(([key]) => !unnormalizedMoneyFactKeys.has(key))) as Partial<ApplicationFacts>;
  // A number next to «дадите» is part of a question about the available
  // limit, not proof of either the car's value or the amount the client wants
  // to request. Do not let an extraction model turn that question into facts.
  const text = input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "";
  if (isMaximumLoanKnowledgeQuestion(text)) return result;
  const deterministicMoney = resolveMoneyFacts({ text, currentFacts: {} });
  const onlyMention = deterministicMoney.mentions.length === 1 ? deterministicMoney.mentions[0] : undefined;
  // A single amount with an explicit client-side role is normally resolved by
  // the dedicated money normalizer before this agent runs. Accept the main
  // model only when it agrees exactly with that turn-local deterministic
  // mention; this keeps the standalone agent boundary correct without giving
  // it authority to reinterpret an amount from history.
  if (onlyMention?.roleCandidate === "requestedAmount" || onlyMention?.roleCandidate === "vehicleValue") {
    const field = onlyMention.roleCandidate;
    const modelValue = patch[field];
    if (hasMoney
      && (onlyMention.currency === null || onlyMention.currency === "KGS")
      && typeof modelValue === "number"
      && Number.isFinite(modelValue)
      && modelValue > 0
      && roundSomAmount(modelValue) === roundSomAmount(onlyMention.normalizedAmount)) {
      result[field] = roundSomAmount(modelValue);
    }
    return result;
  }
  const foreignCurrencyMentioned = /(?:\busd\b|\$|dollars?|bucks?|дол+ар|дол(?!\p{L})|бакс|\beur(?:o)?s?\b|€|евр|\bkzt\b|₸|тенг|\brub(?:les?)?\b|₽|руб)/iu.test(input.text ?? "");
  // For KGS-only turns the main agent is the fast-path money parser. It
  // understands conversational spellings and returns the normalized number;
  // foreign currency remains exclusive to the dedicated converter.
  // The main model sees assistant history and can echo a previously
  // converted amount. Accept KGS from it only when this client turn actually
  // contains a money mention; otherwise a repeated 2.62m can be multiplied
  // by an FX rate again on the following question.
  const clientHasMoneyMention = detectMoneyMentions(input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").length > 0;
  const modelOwnsKgsMoney = hasMoney && clientHasMoneyMention && !foreignCurrencyMentioned;
  const offeredPublicLimits = new Set([
    input.pricing?.withoutStorage.publicMax,
    input.pricing?.parking.publicMax
  ].filter((value): value is number => typeof value === "number"));
  const requestedAmountCorrection = isRequestedAmountCorrectionText(text);
  const vehicleValueCorrection = deterministicMoney.mentions.some((mention) => mention.roleCandidate === "vehicleValue");
  for (const key of ["vehicleValue", "requestedAmount"] as const) {
    // The model occasionally assigns the same corrected number to both
    // money fields. A client correcting what they want to borrow cannot
    // change the already known market value of the vehicle by implication.
    if (key === "vehicleValue" && requestedAmountCorrection && !vehicleValueCorrection) continue;
    const value = patch[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    const rounded = roundSomAmount(value);
    if (modelOwnsKgsMoney || offeredPublicLimits.has(rounded)) result[key] = rounded;
  }
  return result;
}

function removeUncorroboratedClosedVehicleChanges(
  patch: Partial<ApplicationFacts>,
  input: Pick<AgentTurnInput, "facts" | "text" | "currentTurnMessages" | "settings">
): Partial<ApplicationFacts> {
  if (!deriveStageCompletion(input.facts, input.settings as LoanPricingSettings).vehicle) return patch;
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "").toLocaleLowerCase("ru-RU");
  const guarded = { ...patch };
  for (const field of ["vehicleMake", "vehicleModel"] as const) {
    const proposed = guarded[field];
    if (typeof proposed !== "string" || proposed === input.facts[field]) continue;
    if (!text.includes(proposed.toLocaleLowerCase("ru-RU"))) delete guarded[field];
  }
  if (typeof guarded.vehicleYear === "number"
    && guarded.vehicleYear !== input.facts.vehicleYear
    && !new RegExp(`(?<!\\d)${guarded.vehicleYear}(?!\\d)`, "u").test(text)) {
    delete guarded.vehicleYear;
  }
  return guarded;
}

function isRequestedAmountCorrectionText(text: string): boolean {
  const normalized = text.toLocaleLowerCase("ru-RU");
  const amount = String.raw`\d[\d\s.,]*(?:к|кк|тыс\.?|тысяч\p{L}*|млн|миллион\p{L}*)?`;
  return new RegExp(
    String.raw`(?:(?:не|вместо)\s+${amount}\s+(?:а|а\s+не)\s+${amount}|(?:я\s+)?(?:всё\s*[- ]?таки\s+)?(?:хочу|мне\s+(?:нужно|надо)|нужно|надо|требуется)\s+(?:сумм\p{L}*\s+)?${amount}|(?:мне\s+)?(?:кстати\s+)?(?:всё\s*[- ]?таки\s+)?${amount}\s+(?:нужно|надо))`,
    "iu"
  ).test(normalized);
}

function hasExplicitProgramSelection(input: Pick<AgentTurnInput, "text" | "currentTurnMessages" | "messages">): boolean {
  const text = (input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "");
  if (hasExplicitProgramSelectionSignal(text)) return true;
  const lastAssistant = [...input.messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  return isProgramSelectionQuestion(lastAssistant) && programFromShortReply(text) !== undefined;
}

function hasExplicitProgramSelectionSignal(text: string): boolean {
  if (programFromVehiclePossessionPreference(text)) return true;
  return /(?:без\s+изъяти|со\s+стоянк|на\s+стоянк|остав(?:ить|лю|ляем)[^.!?\n]{0,40}(?:у\s+себя|на\s+(?:стоянк|парковк))|(?:давай(?:те)?|хочу|выбира(?:ю|ем)|тогда|будет|нуж(?:на|ен|но)|надо)[^.!?\n]{0,40}(?:стоянк|парковк|без\s+изъяти))/iu.test(text);
}

function isProgramSelectionQuestion(text: string): boolean {
  return /(?:вас\s+интересует|какую\s+программ\p{L}*\s+выбираете)[^?!\n]*(?:без\s+изъятия|стоянк)/iu.test(text);
}

function programFromShortReply(text: string): "without_storage" | "parking" | undefined {
  const preference = programFromVehiclePossessionPreference(text);
  if (preference) return preference;
  const normalized = text.trim().toLocaleLowerCase("ru-RU");
  if (/^(?:без|без\s+из|без\s+изъят\p{L}*|остав(?:ить|лю)\s+(?:у\s+себя|машин\p{L}*\s+себе))[.!\s]*$/iu.test(normalized)) return "without_storage";
  if (/^(?:со|стоянк\p{L}*|со\s+стоянк\p{L}*|на\s+стоянк\p{L}*|парковк\p{L}*)(?:\s+(?:устро\p{L}*|подход\p{L}*|год\p{L}*))?[.!\s]*$/iu.test(normalized)) return "parking";
  if (/^(?:без|без\s+из|без\s+изъят\p{L}*)(?:\s+(?:устро\p{L}*|подход\p{L}*|год\p{L}*))?[.!\s]*$/iu.test(normalized)) return "without_storage";
  return undefined;
}

/** Outage fallback after the model has had the first chance to normalize a
 * programme change expressed during any unrelated stage. */
function programFromExplicitReply(text: string): "without_storage" | "parking" | undefined {
  const preference = programFromVehiclePossessionPreference(text);
  if (preference) return preference;
  if (/(?:давай(?:те)?|хочу|выбира(?:ю|ем)|тогда|будет|остав(?:ить|лю|ляем))[^.!?\n]{0,40}(?:стоянк|парковк)|(?:на|со)\s+(?:стоянк|парковк)/iu.test(text)) return "parking";
  if (/(?:давай(?:те)?|хочу|выбира(?:ю|ем)|тогда|будет|остав(?:ить|лю|ляем))[^.!?\n]{0,40}без\s+изъяти|без\s+изъят/iu.test(text)) return "without_storage";
  return undefined;
}

/** Conservative fallback when the semantic classifier is unavailable or returns no decision. */
function programFromVehiclePossessionPreference(text: string): "without_storage" | "parking" | undefined {
  if (/прав(?:о|а)м\s+пользован\p{L}*/iu.test(text)) return "without_storage";
  if (/(?:пускай|пусть)\s+у\s+вас\s+(?:буд\p{L}*\s+)?(?:авто|автомобил\p{L}*|машин\p{L}*)|(?:пускай|пусть)[^.!?\n]{0,35}(?:авто|автомобил\p{L}*|машин\p{L}*)[^.!?\n]{0,35}(?:у\s+вас|остан|оста[её]т)|могу\s+без\s+(?:авто|автомобил\p{L}*|машин\p{L}*)\s+обойтись|(?:авто|автомобил\p{L}*|машин\p{L}*)[^.!?\n]{0,35}(?:могу|можно)[^.!?\n]{0,25}остав(?:ить|аться)[^.!?\n]{0,25}(?:у\s+вас|на\s+(?:стоянк|парковк))/iu.test(text)) return "parking";
  if (/(?:мне\s+(?:нужно|надо)[^.!?\n]{0,35}(?:ездить\s+на\s+машин\p{L}*|авто\s+у\s+себя|машин\p{L}*\s+у\s+себя)|чтобы\s+(?:авто|автомобил\p{L}*|машин\p{L}*)[^.!?\n]{0,25}(?:у\s+меня\s+)?остал|(?:авто|автомобил\p{L}*|машин\p{L}*)[^.!?\n]{0,25}(?:долж(?:ен|на|но)|нуж(?:ен|на|но))[^.!?\n]{0,25}у\s+меня|не\s+могу\s+без\s+(?:авто|автомобил\p{L}*|машин\p{L}*))/iu.test(text)) return "without_storage";
  return undefined;
}

function asksProgrammeDetails(text: string): boolean {
  return /(?:ставк\p{L}*|процент\p{L}*|услови\p{L}*|тариф\p{L}*|скольк\p{L}*\s+(?:стоит|платить)|как\s+(?:работает|устроен\p{L}*))(?:[^?!]{0,100}(?:стоянк|парковк|программ|изъяти))?|(?:стоянк|парковк|программ|изъяти)[^?!]{0,100}(?:ставк\p{L}*|процент\p{L}*|услови\p{L}*|тариф\p{L}*|скольк\p{L}*\s+(?:стоит|платить)|как\s+(?:работает|устроен\p{L}*))/iu.test(text);
}

function removeUnaskedProgramDetails(reply: string, input: Pick<AgentTurnInput, "text" | "currentTurnMessages">, programSelectionOnly = false): string {
  const text = input.currentTurnMessages?.map((message) => message.text).join(" ") ?? input.text ?? "";
  if (asksProgrammeDetails(text)) return reply;
  if (programSelectionOnly) {
    return reply
      .split(/(?<=[.!?])\s+/u)
      .filter((sentence) => !/(?:по\s+программе\s+(?:со\s+стоянкой|без\s+изъятия)|автомобил\p{L}*\s+(?:размещ|оста[её]тся)|охраняем\p{L}*\s+(?:стоянк|парковк)|ставк\p{L}*|парковк\p{L}*\s+\d|дополнительно\s+оплач)/iu.test(sentence))
      .join(" ")
      .trim();
  }
  return reply
    .split(/\n\s*\n/gu)
    .filter((paragraph) => !/(?:ставк|процент).{0,240}(?:программ|стоянк|изъят)|(?:программ|стоянк|изъят).{0,240}(?:ставк|процент)/iu.test(paragraph))
    .join("\n\n")
    .trim();
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

function parseRendererReply(value: string | undefined): string | undefined {
  const payload = parseAgentJson(value);
  return typeof payload.reply === "string" && payload.reply.trim().length > 0 && payload.reply.trim().length <= 4_000
    ? payload.reply.trim()
    : undefined;
}

/** Reject additions which change a server-owned plan even if the JSON shape is valid. */
function isSafeRenderedReply(reply: string, responsePlan: string): boolean {
  const questionCount = (value: string) => (value.match(/[?？]/gu) ?? []).length;
  if (questionCount(reply) !== questionCount(responsePlan)) return false;
  const numericTokens = (value: string) => new Set((value.match(/\d[\d\s\u00a0,.:]*/gu) ?? []).map((token) => token.replace(/[\s\u00a0,.:]/gu, "")));
  const planNumbers = numericTokens(responsePlan);
  const replyNumbers = numericTokens(reply);
  if ([...replyNumbers].some((token) => !planNumbers.has(token)) || [...planNumbers].some((token) => !replyNumbers.has(token))) return false;
  const mentionedCurrencies = (value: string) => new Set((value.match(/(?:сом(?:ов|а)?|доллар(?:ов|а)?|евро|тенге|руб(?:лей|ля|ль)?|USD|EUR|KZT|RUB|[$€₸₽])/giu) ?? []).map((token) => token.toLocaleLowerCase("ru-RU")));
  const planCurrencies = mentionedCurrencies(responsePlan);
  const replyCurrencies = mentionedCurrencies(reply);
  if ([...replyCurrencies].some((currency) => !planCurrencies.has(currency)) || [...planCurrencies].some((currency) => !replyCurrencies.has(currency))) return false;
  // The output model may rearrange or shorten a sentence, but new lexical
  // content is a new claim. Fail closed unless every meaningful word already
  // belongs to the server plan.
  const words = (value: string) => (value.toLocaleLowerCase("ru-RU").match(/[\p{L}\d]+/gu) ?? []).filter((word) => word.length > 1);
  const planWords = new Set(words(responsePlan));
  const replyWords = new Set(words(reply));
  // A formatter may not turn a multi-part answer into only the final stage
  // question. Require content coverage in both directions; otherwise fall
  // back to the exact server plan that answers the client first.
  return [...replyWords].every((word) => planWords.has(word))
    && [...planWords].every((word) => replyWords.has(word));
}

/**
 * Source citations are diagnostic grounding, not client-facing prose. Models
 * occasionally make a small transliteration/spelling error in a stable FAQ
 * key (for example `without_seization` instead of `without_seizure`). Resolve
 * only an unambiguous near FAQ key so an otherwise grounded raw answer does
 * not get replaced by the generic fallback. Unknown keys remain invalid.
 */
function normalizeKnowledgeSourceKeys(keys: string[], knownKnowledgeKeys: Set<string>): string[] {
  const known = [...knownKnowledgeKeys];
  const normalized = keys.map((rawKey) => {
    const key = rawKey.trim();
    if (knownKnowledgeKeys.has(key) || key === "lead_card" || key === "conversation_context") return key;
    const withFaqPrefix = key.startsWith("faq_") ? key : `faq_${key}`;
    if (knownKnowledgeKeys.has(withFaqPrefix)) return withFaqPrefix;
    if (!withFaqPrefix.startsWith("faq_")) return key;

    const candidates = known
      .filter((candidate) => candidate.startsWith("faq_"))
      .map((candidate) => ({ candidate, distance: levenshteinDistance(withFaqPrefix, candidate) }))
      .sort((left, right) => left.distance - right.distance);
    const closest = candidates[0];
    const threshold = Math.ceil(withFaqPrefix.length * 0.25);
    const isUnambiguous = closest
      && closest.distance <= threshold
      && (candidates[1] === undefined || candidates[1].distance > closest.distance);
    return isUnambiguous ? closest.candidate : key;
  });
  return [...new Set(normalized)];
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function parseAgentJson(value: string | null | undefined): Record<string, unknown> {
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

type RecognizedAttachmentType = "id_front" | "id_back" | "vehicle_registration_front" | "vehicle_registration_back" | "car" | "unknown" | "poor_quality";
type RecognizedAttachmentStatus = "received" | "poor_quality" | "blocked";
type DocumentAttachmentType = "id_front" | "id_back" | "vehicle_registration_front" | "vehicle_registration_back";

function parseDocumentIdentityExtraction(value: string | undefined): {
  fullName?: string;
  documents: Partial<Record<"id_front" | "id_back" | "vehicle_registration_front" | "vehicle_registration_back", boolean>>;
  attachments: Array<{ attachmentId: string; type: RecognizedAttachmentType; status: RecognizedAttachmentStatus; documentTypes: DocumentAttachmentType[] }>;
  hasAttachmentClassification: boolean;
} {
  const payload = parseAgentJson(value);
  const name = (key: "fullName") => {
    const candidate = payload[key];
    return typeof candidate === "string" && candidate.trim().length > 2 && candidate.trim().length <= 200 ? candidate.trim() : undefined;
  };
  const rawDocuments = payload.documents;
  const documents = rawDocuments && typeof rawDocuments === "object" && !Array.isArray(rawDocuments)
    ? Object.fromEntries(
      ["id_front", "id_back", "vehicle_registration_front", "vehicle_registration_back"]
        .filter((type) => (rawDocuments as Record<string, unknown>)[type] === true)
        .map((type) => [type, true])
    )
    : {};
  const rawAttachments = payload.attachments;
  const attachmentTypes = new Set<RecognizedAttachmentType>(["id_front", "id_back", "vehicle_registration_front", "vehicle_registration_back", "car", "unknown", "poor_quality"]);
  const attachmentStatuses = new Set<RecognizedAttachmentStatus>(["received", "poor_quality", "blocked"]);
  const documentAttachmentTypes = new Set<DocumentAttachmentType>(["id_front", "id_back", "vehicle_registration_front", "vehicle_registration_back"]);
  const attachments = Array.isArray(rawAttachments)
    ? rawAttachments.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const row = candidate as Record<string, unknown>;
      const attachmentId = typeof row.attachmentId === "string" ? row.attachmentId.trim() : "";
      const type = typeof row.type === "string" ? row.type : "";
      const suppliedStatus = typeof row.status === "string" ? row.status : undefined;
      if (!attachmentId || !attachmentTypes.has(type as RecognizedAttachmentType)) return [];
      const documentTypes = Array.isArray(row.documentTypes)
        ? [...new Set(row.documentTypes.filter((item): item is DocumentAttachmentType => typeof item === "string" && documentAttachmentTypes.has(item as DocumentAttachmentType)))]
        : [];
      if (isDocumentAttachmentType(type as RecognizedAttachmentType) && !documentTypes.includes(type as DocumentAttachmentType)) {
        documentTypes.push(type as DocumentAttachmentType);
      }
      const status = type === "poor_quality"
        ? "poor_quality"
        : attachmentStatuses.has(suppliedStatus as RecognizedAttachmentStatus)
          ? suppliedStatus as RecognizedAttachmentStatus
          : "received";
      return [{ attachmentId, type: type as RecognizedAttachmentType, status, documentTypes }];
    })
    : [];
  return {
    fullName: name("fullName"),
    documents,
    attachments,
    hasAttachmentClassification: Array.isArray(rawAttachments)
  };
}

function isCyrillicFullName(value: string | undefined): boolean {
  return typeof value === "string" && /^[\p{Script=Cyrillic}]+(?:[ -][\p{Script=Cyrillic}]+){1,3}$/u.test(value.trim());
}

function normalizeDocumentFullName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (isCyrillicFullName(trimmed)) return trimmed;
  if (!/^[A-Za-z]+(?:[ -][A-Za-z]+){1,3}$/u.test(trimmed)) return undefined;
  const digraphs: Array<[RegExp, string]> = [
    [/shch/giu, "щ"], [/yo/giu, "ё"], [/zh/giu, "ж"], [/kh/giu, "х"], [/ts/giu, "ц"],
    [/ch/giu, "ч"], [/sh/giu, "ш"], [/yu/giu, "ю"], [/ya/giu, "я"], [/ye/giu, "е"]
  ];
  const letters: Record<string, string> = {
    a: "а", b: "б", c: "к", d: "д", e: "е", f: "ф", g: "г", h: "х", i: "и", j: "й",
    k: "к", l: "л", m: "м", n: "н", o: "о", p: "п", q: "к", r: "р", s: "с", t: "т",
    u: "у", v: "в", w: "в", x: "кс", y: "й", z: "з"
  };
  let transliterated = trimmed.toLocaleLowerCase("en-US");
  for (const [pattern, replacement] of digraphs) transliterated = transliterated.replace(pattern, replacement);
  transliterated = transliterated
    .replace(/[a-z]/gu, (letter: string) => letters[letter] ?? letter)
    .replace(/(^|[ -])[\p{Script=Cyrillic}]/gu, (letter: string) => letter.toLocaleUpperCase("ru-RU"));
  return isCyrillicFullName(transliterated) ? transliterated : undefined;
}

function hasRecognizedDocument(attachments: Array<{ type: RecognizedAttachmentType; documentTypes: DocumentAttachmentType[] }>): boolean {
  return attachments.some((attachment) => isDocumentAttachmentType(attachment.type) || attachment.documentTypes.length > 0);
}

function removeDocumentDerivedFacts(parsed: AgentTurnResult): AgentTurnResult {
  const { fullName: _fullName, ownerFullName: _ownerFullName, phone: _phone,
    vehicleRegistrationCountry: _vehicleRegistrationCountry, vehicleRegistrationRegion: _vehicleRegistrationRegion,
    vehicleType: _vehicleType, vehicleMake: _vehicleMake, vehicleModel: _vehicleModel,
    vehicleYear: _vehicleYear, vehicleValue: _vehicleValue, ...leadCardPatch } = parsed.leadCardPatch;
  return { ...parsed, leadCardPatch };
}

function isDocumentAttachmentType(type: RecognizedAttachmentType): type is "id_front" | "id_back" | "vehicle_registration_front" | "vehicle_registration_back" {
  return type === "id_front" || type === "id_back" || type === "vehicle_registration_front" || type === "vehicle_registration_back";
}

/** Replace conversational guesses only for images the focused vision model
 * received. Non-image file classifications remain untouched. */
function mergeFocusedAttachmentClassification(
  existing: AgentTurnResult["attachments"],
  images: InboundAttachment[],
  focused: Array<{ attachmentId: string; type: RecognizedAttachmentType; status: RecognizedAttachmentStatus }>
): AgentTurnResult["attachments"] {
  const imageIds = new Set(images.map((attachment) => attachment.id));
  const byId = new Map<string, { attachmentId: string; type: RecognizedAttachmentType; status: RecognizedAttachmentStatus }>();
  for (const attachment of focused) {
    if (imageIds.has(attachment.attachmentId) && !byId.has(attachment.attachmentId)) byId.set(attachment.attachmentId, attachment);
  }
  return [
    ...existing.filter((attachment) => !imageIds.has(attachment.attachmentId)),
    ...images.map((attachment) => {
      const recognized = byId.get(attachment.id);
      return recognized
        ? { attachmentId: recognized.attachmentId, type: recognized.type, status: recognized.status }
        : { attachmentId: attachment.id, type: "unknown" as const, status: "received" as const };
    })
  ];
}

/**
 * Some channels preserve binary content but label a photo as
 * application/octet-stream.  Vision must receive a supported image media
 * type, so prefer an explicit type and fall back to file extension/signature.
 */
function imageAttachmentMediaType(attachment: InboundAttachment): "image/jpeg" | "image/png" | "image/webp" | "image/gif" | undefined {
  const mimeType = attachment.mimeType?.trim().toLowerCase();
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "image/jpeg";
  if (mimeType === "image/png" || mimeType === "image/webp" || mimeType === "image/gif") return mimeType;

  const fileName = attachment.fileName?.trim().toLowerCase() ?? "";
  if (/\.(?:jpe?g)$/u.test(fileName)) return "image/jpeg";
  if (/\.png$/u.test(fileName)) return "image/png";
  if (/\.webp$/u.test(fileName)) return "image/webp";
  if (/\.gif$/u.test(fileName)) return "image/gif";

  try {
    const header = Buffer.from(attachment.contentBase64 ?? "", "base64").subarray(0, 12);
    if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
    if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (header.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
    if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  } catch {
    // Invalid base64 is rejected by the provider; it is not an image hint.
  }
  return undefined;
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
  const history = activeWorkflowHistory(input.messages);
  // Keep this explicit small window alongside the compact workflow history.
  // The main model must compare the current reply with the exact latest AI
  // prompt before it treats a short word as a correction to another field.
  const lastTwoDialogueMessages = input.messages
    .slice(-2)
    .map(({ author, body, createdAt }) => ({ author, text: body, createdAt }));
  // Guarantor answers are stateful server-side workflow details. Do not give
  // them to the general model: it must neither decide the requirement nor
  // mutate the answer, otherwise a stale JSON field can reopen that branch.
  const {
    guarantorAvailable: _guarantorAvailable,
    guarantorAlternativeDeclined: _guarantorAlternativeDeclined,
    stageCompletion: rawStageCompletion,
    ...leadCardWithoutGuarantor
  } = input.facts as ApplicationFacts & { stageCompletion?: Record<string, unknown> };
  const leadCard = rawStageCompletion && typeof rawStageCompletion === "object"
    ? (() => {
      const { guarantor: _guarantor, ...stageCompletion } = rawStageCompletion;
      return { ...leadCardWithoutGuarantor, stageCompletion };
    })()
    : leadCardWithoutGuarantor;
  const knownLeadCardFields = Object.entries(leadCard)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key]) => key);
  const context = { now, timezone, history, lastTwoDialogueMessages, leadCard, knownLeadCardFields, currentMessage: input.text ?? "", currentTurnMessages, pricing, pricingAuthority: "Pricing is calculated by the server. Use only available publicMax; never calculate or expose rawMax.", currencyConversions: input.currencyConversions ?? [], ...(visitCalendar ? { visitCalendar } : {}), relevantStages: retrieval.stages, knowledge: retrieval.knowledge };
  const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "high" } }> = [{ type: "text", text: JSON.stringify(context) }];
  for (const attachment of input.attachments) {
    parts.push({ type: "text", text: JSON.stringify({ attachment: { id: attachment.id, fileName: attachment.fileName, mimeType: attachment.mimeType, textContent: attachment.textContent, metadata: attachment.metadata } }) });
    const imageMediaType = imageAttachmentMediaType(attachment);
    if (includeImages && attachment.contentBase64 && imageMediaType) parts.push({ type: "image_url", image_url: { url: `data:${imageMediaType};base64,${attachment.contentBase64}`, detail: "high" } });
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
const serverOnlyLeadFactKeys = new Set(["guarantorAvailable", "guarantorAlternativeDeclined"]);
const modelAttachmentTypes = new Set<RecognizedAttachmentType>(["id_front", "id_back", "vehicle_registration_front", "vehicle_registration_back", "car", "unknown", "poor_quality"]);
const modelAttachmentStatuses = new Set<RecognizedAttachmentStatus>(["received", "poor_quality", "blocked"]);
const modelAttachmentTypeAliases: Record<string, RecognizedAttachmentType> = {
  id: "id_front", id_card: "id_front", passport: "id_front", id_front_side: "id_front", id_back_side: "id_back",
  sts: "vehicle_registration_front", vehicle_registration: "vehicle_registration_front", registration_certificate: "vehicle_registration_front",
  sts_front: "vehicle_registration_front", sts_back: "vehicle_registration_back", car_photo: "car", vehicle_photo: "car", photo_car: "car"
};

function normalizeModelAttachmentType(value: unknown): RecognizedAttachmentType | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (modelAttachmentTypes.has(normalized as RecognizedAttachmentType)) return normalized as RecognizedAttachmentType;
  return modelAttachmentTypeAliases[normalized];
}

/** Bind malformed model attachment labels to the actual inbound file IDs.
 * The focused vision pass replaces these provisional values after Zod. */
function normalizeModelAttachments(value: unknown, inboundAttachments: InboundAttachment[]): AgentTurnResult["attachments"] {
  if (inboundAttachments.length === 0) return [];
  const inbound = inboundAttachments.slice(0, 20);
  const inboundIds = new Set(inbound.map((attachment) => attachment.id));
  const recognized = new Map<string, AgentTurnResult["attachments"][number]>();
  const rows = Array.isArray(value) ? value : [];
  for (const [index, row] of rows.entries()) {
    const source = row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : undefined;
    const attachmentId = source && typeof source.attachmentId === "string" && inboundIds.has(source.attachmentId)
      ? source.attachmentId
      : inbound[index]?.id;
    const type = normalizeModelAttachmentType(source?.type ?? row);
    if (!attachmentId || !type || recognized.has(attachmentId)) continue;
    const suppliedStatus = source?.status;
    const status = type === "poor_quality"
      ? "poor_quality"
      : typeof suppliedStatus === "string" && modelAttachmentStatuses.has(suppliedStatus as RecognizedAttachmentStatus)
        ? suppliedStatus as RecognizedAttachmentStatus
        : "received";
    recognized.set(attachmentId, { attachmentId, type, status });
  }
  return inbound.map((attachment) => recognized.get(attachment.id) ?? {
    attachmentId: attachment.id,
    type: "unknown" as const,
    status: "received" as const
  });
}

function normalizeAgentPayload(payload: Record<string, unknown>, inboundAttachments: InboundAttachment[] = []): Record<string, unknown> {
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
  // Attachment IDs are supplied by the server. Models sometimes return a
  // compact list such as ["id_front", "id_back"] or omit the IDs entirely;
  // that is a formatting issue, not grounds to discard the whole dialogue
  // response before the focused vision pass can inspect the original photos.
  payload.attachments = normalizeModelAttachments(payload.attachments, inboundAttachments);
  const acknowledgement = payload.contextualAcknowledgement;
  if (!acknowledgement || typeof acknowledgement !== "object" || Array.isArray(acknowledgement)) {
    delete payload.contextualAcknowledgement;
  } else {
    const candidate = acknowledgement as Record<string, unknown>;
    const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
    if (text.length < 2) {
      delete payload.contextualAcknowledgement;
    } else {
      payload.contextualAcknowledgement = { text };
    }
  }
  const leadCardPatch = payload.leadCardPatch;
  if (leadCardPatch && typeof leadCardPatch === "object" && !Array.isArray(leadCardPatch)) {
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
    // `leadCardPatch` is a delta for this client turn. Do not copy current
    // facts into it: doing so gives a normalizer authority to rewrite old
    // values while it is only supposed to repair this response's JSON.
    const patch = {
      ...Object.fromEntries(Object.entries(rawPatch).filter(([key]) =>
        !serverOnlyLeadFactKeys.has(key) && (permittedLeadCardKeys.has(key) || key in leadCardAliases)
      ))
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
  const validLoanQuestionKinds = new Set(["none", "maximum_limit", "maximum_preference", "loan_rate", "maximum_limit_and_rate"]);
  if (typeof payload.loanQuestionKind !== "string" || !validLoanQuestionKinds.has(payload.loanQuestionKind)) {
    payload.loanQuestionKind = "none";
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
