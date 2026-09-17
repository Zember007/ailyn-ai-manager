import { Injectable, Logger } from "@nestjs/common";
import type { ApplicationFacts } from "@ailyn/business-rules";
import type { NormalizedMoneyValue } from "../ai/ai-provider.interface.js";
import { AgentTurnService, enforceFirstContactGreeting, isAlreadyProvidedWorkflowReply, isClearMoneyConfirmationRejection, nextRequiredStageQuestion, suppressInactiveGuarantorPrompts, type PendingMoneyClarificationDecision } from "./agent-turn.service.js";
import { isExistingContractServiceRequest, isMaximumLoanKnowledgeQuestion } from "./documentation-retrieval.js";
import { attachmentFactsForCurrentStage, deriveStageCompletion, effectiveFactsForTurn, isCarPhotoStagePrompt, selectedProgramLimit } from "./agent-turn-reconciliation.js";
import type { InboundMessage } from "../channels/channel.interface.js";
import { SettingsService } from "../settings/settings.service.js";
import { BackendLogsService } from "../logs/backend-logs.service.js";
import { Stage1StoreService, type Stage1Application, type Stage1Conversation, type Stage1Message } from "./stage1-store.service.js";
import { DeferredIntegrationsService } from "./deferred-integrations.service.js";
import { detectMoneyMentions, formatMoney, formatSomMoney, resolveMoneyFacts, roundSomAmount, type ForeignMoneyCurrencyCode } from "./money-normalization.js";
import { calculateLoanPricing, calculateLoanRangeDisplayMaximums, MINIMUM_VEHICLE_VALUE } from "./loan-pricing.js";
import { referencesOtherPersonsVehicle } from "./lead-card-ownership.js";
import { isRepeatLoanRequest } from "./repeat-loan.js";

export interface DialogueResult { conversation: Stage1Conversation; application: Stage1Application; reply: string; validation: { passed: boolean; errors: string[] }; routerAiModel: string; promptVersion: string; needsKnowledgeLookup?: boolean; summaryNeedsRefresh?: boolean; }
export interface DialogueReceiveOptions { signal?: AbortSignal; deferReplyPersistence?: boolean; }
const managerDeltaFactKeys = new Set(["requestedAmount", "requestedProgram", "visitDate", "visitTime", "vehicleValue", "vehicleMake", "vehicleModel", "vehicleYear", "fullName", "phone"]);
const ANSWER_MAXIMUM_AFTER_PREREQUISITES = "answer_maximum_after_prerequisites";
const VEHICLE_VALUE_BELOW_MINIMUM_REPLY = "К сожалению, мы не можем принять данный автомобиль в залог, так как его рыночная стоимость должна составлять не менее 300 000 сом.";
const EXISTING_CONTRACT_REDIRECT_REPLY = "Я Айлин — виртуальный помощник по вопросам оформления новых займов. Если у Вас уже оформлен займ, пожалуйста, позвоните по телефону +996 502 108 108 или напишите в WhatsApp +996 776 108 108. Наши специалисты проверят информацию по Вашему договору и помогут решить Ваш вопрос.";

function formatTimingError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function omitRepeatLoanServiceFacts(patch: Partial<ApplicationFacts>, text: string): Partial<ApplicationFacts> {
  const {
    existingContractQuestion: _existingContractQuestion,
    existingContractPaymentMessage: _existingContractPaymentMessage,
    clientClosed: _clientClosed,
    clientPaused: _clientPaused,
    familyStatus,
    ...safePatch
  } = patch;
  return explicitlyStatesFamilyStatus(text) && familyStatus !== undefined
    ? { ...safePatch, familyStatus }
    : safePatch;
}

function explicitlyStatesFamilyStatus(text: string): boolean {
  return /(?:женат|замужем|в\s+браке|не\s+(?:женат|замужем|в\s+браке)|в\s+разводе|разв[её]д)/iu.test(text);
}

function isTerminalApplicationHistory(application: Stage1Application): boolean {
  return application.facts.clientClosed === true
    || application.stage === "TARGET_REACHED_DOCUMENTS"
    || application.stage === "TARGET_REACHED_VISIT"
    || application.stage === "PAUSED";
}

/** The model may mislabel a contextual "I already wrote it" as contract
 * servicing. The server already knows the actual outstanding application
 * stage, so persist that stage rather than a model-proposed redirect. */
function workflowContinuationState(facts: ApplicationFacts, settings: object) {
  const completion = deriveStageCompletion(facts, settings);
  const stage = !completion.vehicle
    ? "COLLECTING_VEHICLE" as const
    : !completion.requestedAmount
      ? "COLLECTING_AMOUNT" as const
      : !completion.program
        ? "ELIGIBILITY_CHECK" as const
        : !completion.residence
          ? "COLLECTING_RESIDENCE" as const
          : !completion.guarantor
            ? "CHECKING_GUARANTOR" as const
            : !completion.documents
              ? "COLLECTING_DOCUMENTS" as const
              : !completion.family
                ? "COLLECTING_FAMILY_STATUS" as const
                : "SCHEDULING_VISIT" as const;
  return { stage, status: "need_more_data" as const, nextAction: "continue_application" };
}

const newLoanOpeningFactKeys = new Set<keyof ApplicationFacts>([
  "fullName", "phone", "citizenship", "residenceRegion", "residenceText", "residenceCategory",
  "vehicleRegistrationCountry", "vehicleRegistrationRegion", "vehicleType", "vehicleMake", "vehicleModel", "vehicleYear", "vehicleValue",
  "requestedAmount", "requestedProgram", "borrowerIsOwner", "ownerFullName", "ownerResidenceRegion", "ownerFamilyStatus", "ownerCanVisit",
  "familyStatus", "vehicleBoughtDuringMarriage", "documents"
]);

function opensNewLoanApplication(
  text: string,
  leadPatch: Partial<ApplicationFacts>,
  moneyFacts: Partial<ApplicationFacts>,
  hasInboundAttachments = false
): boolean {
  const explicitNewLoanIntent = /(?:(?:хочу|нуж(?:ен|на|ны|но)|планирую|собираюсь|можно).{0,40}(?:оформить|получить|взять)?\s*(?:нов(?:ый|ую)\s+)?(?:займ|деньг)|(?:оформить|получить|взять)\s+(?:нов(?:ый|ую)\s+)?(?:займ|деньг))/iu.test(text);
  if (explicitNewLoanIntent) return true;
  if (hasInboundAttachments) return true;
  return Object.entries({ ...leadPatch, ...moneyFacts })
    .some(([key, value]) => newLoanOpeningFactKeys.has(key as keyof ApplicationFacts) && value !== undefined);
}

function hasNewLoanOpeningFacts(facts: Partial<ApplicationFacts>): boolean {
  return Object.entries(facts)
    .some(([key, value]) => newLoanOpeningFactKeys.has(key as keyof ApplicationFacts) && value !== undefined);
}

@Injectable()
export class DialogueOrchestratorService {
  private readonly logger = new Logger(DialogueOrchestratorService.name);

  constructor(private readonly agent: AgentTurnService, private readonly store: Stage1StoreService, private readonly settings: SettingsService, private readonly logs: BackendLogsService, private readonly integrations?: DeferredIntegrationsService) {}

  async receive(message: InboundMessage): Promise<DialogueResult> {
    return this.receiveBatch([message]);
  }

  async receiveBatch(messages: InboundMessage[], options: DialogueReceiveOptions = {}): Promise<DialogueResult> {
    const startedAt = performance.now();
    let result: DialogueResult | undefined;
    let error: unknown;
    try {
      result = await this.receiveBatchInternal(messages, options);
      return result;
    } catch (caught) {
      error = caught;
      throw caught;
    } finally {
      this.logger.log("Dialogue turn finished", {
        event: "dialogue.turn",
        channel: messages[0]?.channel ?? "unknown",
        conversationId: result?.conversation.id,
        model: result?.routerAiModel ?? "not_reached",
        messageCount: messages.length,
        outcome: result ? "success" : options.signal?.aborted ? "aborted" : "error",
        durationMs: Math.round(performance.now() - startedAt),
        ...(error ? { error: formatTimingError(error) } : {})
      });
    }
  }

  private async receiveBatchInternal(messages: InboundMessage[], options: DialogueReceiveOptions = {}): Promise<DialogueResult> {
    if (messages.length === 0) throw new Error("dialogue_batch_empty");
    const firstMessage = messages[0]!;
    const lastMessage = messages.at(-1)!;
    const { conversation, application: initialApplication } = await this.store.getOrCreateConversation({ externalContactId: firstMessage.externalContactId, externalConversationId: firstMessage.externalConversationId, channel: firstMessage.channel });
    let application = initialApplication;
    // Inbounds must be available to the model before they are stored. A newer
    // client message can abort this turn; persisting here would make the
    // batcher retry those same messages and duplicate them in history.
    const pendingInbounds = messages.map(toPendingInboundMessage);
    const turnMessages = [...conversation.messages, ...pendingInbounds];
    const text = messages.map((message) => message.text?.trim()).filter((value): value is string => Boolean(value)).join("\n");
    const startsRepeatLoan = !isExistingContractServiceRequest(text) && isRepeatLoanRequest(text);
    if (startsRepeatLoan) {
      const closedApplication = await this.store.findLatestClosedApplication(application.contactId)
        ?? (isTerminalApplicationHistory(application) ? await this.store.closeApplicationForRepeatLoan(application) : undefined);
      if (closedApplication) application = await this.store.createRepeatLoanApplication(conversation, closedApplication);
    }
    const repeatLoanStarted = application.id !== initialApplication.id;
    // The previous conversation may be retained as history, but the model
    // must not treat old collateral as facts of this new application.
    const modelMessages = suppressInactiveGuarantorPrompts(
      repeatLoanStarted ? pendingInbounds : turnMessages,
      application.facts
    );
    const resumingPausedConversation = Boolean(application.facts.clientPaused && isPausedConversationContinuation(text));
    const factsBeforeTurn: ApplicationFacts = resumingPausedConversation
      ? { ...application.facts, clientPaused: false }
      : application.facts;
    const currentTurnMessages = messages.map((message, index) => ({ index: index + 1, text: message.text?.trim() ?? "" }));
    const attachments = messages.flatMap((message) => message.attachments);
    const settings = await this.settings.getValues();
    const classifyMoneyClarification = (this.agent as Partial<Pick<AgentTurnService, "classifyPendingMoneyClarification">>).classifyPendingMoneyClarification;
    // The currency-confirmation classifier and money normalizer both inspect
    // only the inbound text plus prior history. Run them together: neither
    // result changes the other's prompt or validation boundary.
    const moneyClarificationPromise = classifyMoneyClarification
      ? classifyMoneyClarification.call(this.agent, { text, messages: modelMessages, conversationId: conversation.id, signal: options.signal })
      : Promise.resolve(undefined);
    const lastAssistantMessage = [...modelMessages].reverse().find((message) => message.author === "ai")?.body ?? "";
    // Money roles and FX must be known before the dialogue model builds its
    // answer. Previously this ran only after `run()` and only when the main
    // model set hasMoney; a newer client message could then cancel the second
    // call and leave a reply based on stale card facts.
    // A correction may use two bare numbers («не 200, а 500») without a
    // currency suffix. It is still a money turn: send it to the semantic
    // normalizer instead of silently leaving the old requested amount.
    // A written amount such as «два миллиона» deliberately has no numeric
    // fallback match. When the server is explicitly awaiting a price or loan
    // amount, still send the reply to RouterAI: the model owns natural-language
    // money understanding, including words, typos, and mixed phrasing.
    const awaitingMoneyField = expectedMoneyFieldFromLastQuestion(modelMessages);
    const moneyMentionedWithoutClassifier = !isBareVehicleYearReply(modelMessages, text)
      && (detectMoneyMentions(text).length > 0 || awaitingMoneyField !== undefined || isRequestedAmountCorrectionText(text) || currencyOnlyForeignMoneyFromHistory(text, modelMessages).length > 0);
    const normalizeMoneyPromise = moneyMentionedWithoutClassifier && this.agent.normalizeMoney
      ? this.agent.normalizeMoney({ text, facts: factsBeforeTurn, messages: modelMessages, conversationId: conversation.id, signal: options.signal })
      : Promise.resolve<NormalizedMoneyValue[]>([]);
    const [classifiedMoneyClarification, earlyNormalizedMoney] = await Promise.all([moneyClarificationPromise, normalizeMoneyPromise]);
    // Do not let an unavailable/undecided classifier route a bare "нет" to
    // the KB. This is a deterministic response to the immediately preceding
    // server confirmation, not a free-form semantic inference.
    const moneyClarification = isClearMoneyConfirmationRejection(lastAssistantMessage, text)
      && (classifiedMoneyClarification === undefined || classifiedMoneyClarification.decision === "undecided")
      ? { decision: "reject" as const }
      : classifiedMoneyClarification;
    throwIfAborted(options.signal);
    // A classifier-only confirmation is rare (for example, a bare currency
    // name with no recognised prior amount). Preserve the former behaviour by
    // starting normalization after classification only in that narrow case.
    const modelNormalizedMoney = moneyMentionedWithoutClassifier
      ? earlyNormalizedMoney
      : moneyClarification?.decision === "accept" && this.agent.normalizeMoney
        ? await this.agent.normalizeMoney({ text, facts: factsBeforeTurn, messages: modelMessages, conversationId: conversation.id, signal: options.signal })
        : [];
    throwIfAborted(options.signal);
    // The semantic normalizer owns flexible role interpretation. The
    // deterministic parser is deliberately a narrow supplemental path for an
    // empty/partial normalizer response and explicit confirmation in context.
    const normalizedMoney = supplementNormalizedMoney(modelNormalizedMoney, text, factsBeforeTurn, modelMessages, moneyClarification);
    const currency = await resolveNormalizedMoneyFacts(normalizedMoney, this.integrations, factsBeforeTurn);
    throwIfAborted(options.signal);
    const belowMinimumRequestedAmount = typeof currency.facts.requestedAmount === "number" && currency.facts.requestedAmount < 50_000
      ? currency.facts.requestedAmount
      : undefined;
    // Keep an invalid low amount out of persisted facts. The agent receives it
    // separately only to form the confirmation or minimum-loan response.
    const currencyFactsForTurn = belowMinimumRequestedAmount === undefined && !referencesOtherPersonsVehicle(text)
      ? discardConflictingSingleMoneyRole(currency.facts, text)
      : {};
    const normalizedFacts = effectiveFactsForTurn({
      previous: factsBeforeTurn,
      modelPatch: {},
      explicitFacts: {},
      currencyFacts: currencyFactsForTurn,
      attachmentFacts: {}
    });
    // Currency conversion completes before this boundary. Do not let a model,
    // knowledge answer, or later workflow composer bypass the collateral
    // minimum once the server has a KGS vehicle value.
    const vehicleValueBelowMinimum = typeof normalizedFacts.vehicleValue === "number"
      && normalizedFacts.vehicleValue < MINIMUM_VEHICLE_VALUE;
    await this.logs.log("dialogue.money-resolution", "Money values resolved for lead card", {
      conversationId: conversation.id,
      metadata: {
        inputText: text,
        modelValues: modelNormalizedMoney,
        deterministicMentions: detectMoneyMentions(text),
        valuesAfterSupplement: normalizedMoney,
        resolvedFacts: currency.facts,
        conversions: currency.conversions
      }
    });
    // Knowledge resolution is independent of the universal extractor when
    // the client turn does not alter the lead card. Start with the already
    // normalized server facts so routine questions do not wait for two model
    // round trips. A turn has a strict one-KB-call budget: the first response
    // is used even when this turn updates the card, rather than launching a
    // second request after reconciliation.
    const repeatedWorkflowReply = isAlreadyProvidedWorkflowReply({ text, currentTurnMessages, messages: modelMessages });
    const speculativeKnowledgePromise = repeatedWorkflowReply
      ? undefined
      : this.agent.answerWithKnowledge?.({
        conversationId: conversation.id,
        messages: modelMessages,
        facts: normalizedFacts,
        settings,
        text,
        currentTurnMessages,
        currentTime: lastMessage.timestamp,
        workflowFollowUp: nextRequiredStageQuestion(normalizedFacts, deriveStageCompletion(normalizedFacts, settings)) || "",
        isFirstClientMessage: conversation.messages.length === 0,
        signal: options.signal
      });
    // Keep the speculative rejection observed so a request skipped because
    // the server owns the reply cannot become unhandled.
    void speculativeKnowledgePromise?.catch((error: unknown) => {
      if (!options.signal?.aborted) this.logger.warn(`Speculative knowledge request failed: ${formatTimingError(error)}`);
    });
    let turn = await this.agent.run({
      conversationId: conversation.id,
      messages: modelMessages,
      facts: normalizedFacts,
      settings,
      text,
      currentTurnMessages,
      pricing: calculateLoanPricing(normalizedFacts, settings),
      currencyConversions: currency.conversions,
      moneyClarificationDecision: moneyClarification?.decision === "accept" || moneyClarification?.decision === "reject" ? moneyClarification.decision : undefined,
      minimumRequestedAmountCandidate: belowMinimumRequestedAmount,
      attachments,
      signal: options.signal
    });
    // A short "I already wrote it" after a collection question is not a
    // request about a previous contract. Do not let either model reinterpret
    // it as one. If an earlier value is actually recoverable, the main agent
    // has already placed it in the patch and the normal flow continues.
    const { knowledgeRequest: _recoveryKnowledgeRequest, existingContractQuestion: _recoveryExistingContractQuestion, existingContractPaymentMessage: _recoveryExistingContractPaymentMessage, ...recoveryPatch } = turn.result?.leadCardPatch ?? {};
    const recoveryFacts = { ...normalizedFacts, ...recoveryPatch };
    const recoveryQuestion = repeatedWorkflowReply
      ? nextRequiredStageQuestion(recoveryFacts, deriveStageCompletion(recoveryFacts, settings))
      : undefined;
    const repeatedWorkflowRecovery = recoveryQuestion
      ? `К сожалению, я не смогла распознать эту информацию. Пожалуйста, продублируйте её.\n\n${recoveryQuestion}`
      : undefined;
    if (repeatedWorkflowRecovery) {
      const dialogueState = workflowContinuationState(recoveryFacts, settings);
      turn = {
        ...turn,
        reply: repeatedWorkflowRecovery,
        ...(turn.result ? {
          result: {
            ...turn.result,
            reply: repeatedWorkflowRecovery,
            leadCardPatch: recoveryPatch,
            dialogueState
          }
        } : {})
      };
    }
    // Terminal refusals and complete visit confirmations are closed
    // server-owned replies. The knowledge model must not replace them with
    // a repeated stage question or an unrelated FAQ answer.
    const existingContractServiceRequest = isExistingContractServiceRequest(text);
    const existingContractRedirect = existingContractServiceRequest
      || (!repeatedWorkflowRecovery && turn.result?.dialogueState.status === "redirect_existing_contract");
    const confirmedVisitReply = Boolean(
      turn.result?.leadCardPatch.visitDate
      && turn.result?.leadCardPatch.visitTime
      && /записываю\s+вас\s+на/iu.test(turn.reply)
    );
    // A confirmed slot remains server-owned only for a pure booking reply.
    // If the same message has an independent question, preserve both its KB
    // answer and the booking confirmation.
    const visitAlsoHasQuestion = confirmedVisitReply && (
      /[?？]/u.test(text)
      || Boolean(turn.result?.clientQuestion)
      || turn.result?.needsKnowledgeLookup === true
    );
    let serverOwnsReply = turn.result?.dialogueState.status === "refuse"
      || existingContractRedirect
      || Boolean(repeatedWorkflowRecovery)
      || (confirmedVisitReply && !visitAlsoHasQuestion);
    // Servicing an existing contract never opens a new-loan workflow. The
    // normalizer may have reconstructed its reply after a model schema error;
    // that fallback can contain a greeting and an unrelated stage question.
    // Deliver the canonical approved redirect directly and do not require a
    // second KB call to clean up an already-classified servicing request.
    if (existingContractRedirect) {
      const dialogueState = { stage: "EXISTING_CONTRACT_REDIRECT" as const, status: "redirect_existing_contract" as const, nextAction: "redirect_existing_contract" };
      turn = {
        ...turn,
        reply: EXISTING_CONTRACT_REDIRECT_REPLY,
        ...(turn.result ? { result: { ...turn.result, reply: EXISTING_CONTRACT_REDIRECT_REPLY, dialogueState } } : {})
      };
    }
    if (repeatLoanStarted) {
      serverOwnsReply = true;
      const reply = "Поняла, оформляем новую заявку. Ваши личные данные у нас уже сохранены. Окончательное решение и сумма определяются после проверки автомобиля и документов. Для нового оформления пришлите, пожалуйста, актуальные фото автомобиля и свидетельство о регистрации ТС с обеих сторон. Также уточните марку, модель, год выпуска и ориентировочную стоимость автомобиля.";
      turn = {
        ...turn,
        reply,
        ...(turn.result ? {
          result: {
            ...turn.result,
            reply,
            leadCardPatch: omitRepeatLoanServiceFacts(turn.result.leadCardPatch, text)
          }
        } : {})
      };
    }
    // This flag is set from the approved KB payload, not from wording the
    // client or a model used to ask about a maximum.
    let receivedMaximumLoanTemplate = false;
    // On the first client message, a standalone KB question or an existing
    // contract request is not an application opening. The KB owns this
    // classification, so its approved reply must not be polluted by the
    // new-loan compliance greeting at the final delivery boundary.
    let suppressFirstContactGreeting = false;
    let newLoanWorkflowStarted = Boolean(application.agentState?.newLoanStarted)
      || hasNewLoanOpeningFacts(application.facts)
      || repeatLoanStarted;
    const currentMaximumLoanQuestion = isMaximumLoanKnowledgeQuestion(text);
    const deferredMaximumLoanAnswer = !existingContractServiceRequest
      && application.agentState?.nextAction === ANSWER_MAXIMUM_AFTER_PREREQUISITES
      && Boolean(turn.result)
      && hasMaximumLoanPrerequisites(turn.result!.leadCardPatch);
    const maximumLoanQuestion = currentMaximumLoanQuestion || deferredMaximumLoanAnswer;
    // A maximum-limit question has an approved KB answer and a server-owned
    // calculation template. It must reach that path even when the workflow
    // model failed to set `needsKnowledgeLookup`; otherwise the stage prompt
    // below replaces the answer the client actually asked for.
    // Each turn is evaluated against approved knowledge independently. The
    // workflow model is fallible at identifying natural questions, so its
    // `knowledgeRequest` flag cannot be a permission boundary for KB lookup.
    {
      const { knowledgeRequest: _knowledgeRequest, ...turnFacts } = turn.result?.leadCardPatch ?? {};
      newLoanWorkflowStarted ||= opensNewLoanApplication(text, turnFacts, currencyFactsForTurn, attachments.length > 0);
      const factsForWorkflow = { ...normalizedFacts, ...turnFacts };
      const canonicalWorkflowFollowUp = nextRequiredStageQuestion(
        factsForWorkflow,
        deriveStageCompletion(factsForWorkflow, settings)
      ) || "";
      // The main model can omit the final canonical prompt while routing a
      // factual question to knowledge. Do not let the KB answer terminate the
      // application: derive the next required action from server-owned facts.
      const workflowFollowUp = maximumLoanQuestion
        ? maximumLoanCalculationFollowUp(factsForWorkflow, canonicalWorkflowFollowUp)
        : deferredMaximumLoanAnswer || turn.result?.dialogueState.status === "redirect_existing_contract"
        ? ""
        : canonicalWorkflowFollowUp
        || extractWorkflowFollowUp(turn.reply)
        // A completed application has no further collection action. The
        // knowledge contract still receives a string in that terminal case.
        || "";
      const knowledge = serverOwnsReply
        ? undefined
        : await speculativeKnowledgePromise;
      // The KB owns the decision whether the client asked a meaningful
      // question. Do not let the workflow model's stage classification, a
      // missing question mark, or programme-selection heuristics discard an
      // answer that the KB explicitly found. Stage facts are protected by the
      // KB's `answerFound: false` workflow sentinel instead.
      // The KB is invoked on every turn, but its workflow sentinel is an
      // internal protocol result, never client-facing content. Keep this
      // delivery guard even if a model or adapter incorrectly flags it for
      // use, so it cannot replace a new-loan workflow reply.
      const knowledgeIsWorkflowSentinel = knowledge?.reply.trim() === "__WORKFLOW_STAGE_RESPONSE__";
      if (!knowledgeIsWorkflowSentinel && (knowledge?.answerFound || knowledge?.shouldUseReply)) {
        const standaloneKnowledgeTurn = !newLoanWorkflowStarted;
        suppressFirstContactGreeting = standaloneKnowledgeTurn;
        receivedMaximumLoanTemplate = hasMaximumLoanPlaceholders(knowledge.reply);
        // The knowledge model is the only author of factual company answers.
        // Never prefix it with the workflow model's prose: that prose may be
        // plausible but unsupported and would reintroduce a hallucination.
        // Any turn that includes a maximum-limit question has a
        // server-calculated limit plan. Preserve it before the independent
        // KB answer (office address, FAQ, etc.); only a direct rate question
        // may add interest-rate wording.
        const responsePlan = maximumLoanQuestion
          ? stripWorkflowQuestionsFromMaximumAnswer(knowledge.reply)
          : confirmedVisitReply
            ? appendWorkflowFollowUp(knowledge.reply, turn.reply)
            : knowledge.reply;
        // A KB answer supplements an application already in progress. Its
        // own topic (for example, tea or coffee) must not end collection of
        // the next missing fact. Scope can stop the workflow only on the very
        // first client contact, before an application conversation exists.
        // A completed (or paused) application has no active collection
        // stage. Its card can still contain historical gaps such as a spouse
        // consent flag, but those gaps must never be appended to a KB answer
        // during a post-scenario test question.
        const continuesNewLoanWorkflow = !isTerminalApplicationHistory(application)
          && !standaloneKnowledgeTurn;
        const reply = appendWorkflowFollowUp(
          responsePlan,
          knowledge.answerFound && continuesNewLoanWorkflow
            ? workflowFollowUpAfterKnowledge(responsePlan, workflowFollowUp, lastAssistantMessage, factsForWorkflow, maximumLoanQuestion)
            : "",
          lastAssistantMessage
        );
        turn = {
          ...turn,
          ...(turn.result ? { result: { ...turn.result, reply } } : {}),
          reply,
          model: knowledge.model,
          promptVersion: `${turn.promptVersion}+knowledge`
        };
      }
    }
    if (turn.result) {
      const factsForReply = { ...normalizedFacts, ...turn.result.leadCardPatch };
      const reply = replaceMaximumLimitPlaceholders(turn.reply, factsForReply, settings);
      if (reply !== turn.reply) {
        turn = { ...turn, reply, result: { ...turn.result, reply } };
      }
    }
    // The input model only interprets the turn. At this point the server has
    // selected all facts, calculations, canonical workflow text and (when
    // needed) the approved knowledge answer, so the output model receives a
    // closed plan and cannot choose a new stage or invent a condition.
    // TEMP: responsePlan rendering is disabled for latency testing. Keep this
    // block intact so it can be restored after comparing production timings.
    /*
    const renderClientReply = (this.agent as Partial<Pick<AgentTurnService, "renderClientReply">>).renderClientReply;
    // The limit is a closed server calculation, not prose that benefits from
    // rewording. In particular, a formatter must never keep only the later
    // document prompt and drop the calculation the client asked for.
    const hasServerCalculatedLimit = isMaximumLoanKnowledgeQuestion(text);
    if (renderClientReply && !hasServerCalculatedLimit) {
      const rendered = await renderClientReply.call(this.agent, {
        // FX text is generated by the server too, so it must be part of the
        // closed plan seen by the renderer rather than prefixed afterwards.
        responsePlan: composeReply(turn.reply, currency.clientText),
        clientMessage: text,
        facts: { ...normalizedFacts, ...(turn.result?.leadCardPatch ?? {}) },
        conversationId: conversation.id,
        signal: options.signal
      });
      if (rendered.reply) {
        turn = {
          ...turn,
          reply: rendered.reply,
          ...(turn.result ? { result: { ...turn.result, reply: rendered.reply } } : {}),
          ...(rendered.rendered ? { model: rendered.model, promptVersion: `${turn.promptVersion}+output` } : {})
        };
      }
    }
    */
    if (vehicleValueBelowMinimum) {
      const refusalState = { stage: "REFUSED" as const, status: "refuse" as const, nextAction: "none" };
      turn = {
        ...turn,
        reply: VEHICLE_VALUE_BELOW_MINIMUM_REPLY,
        ...(turn.result ? {
          result: {
            ...turn.result,
            reply: VEHICLE_VALUE_BELOW_MINIMUM_REPLY,
            needsKnowledgeLookup: false,
            leadCardPatch: { ...turn.result.leadCardPatch, vehicleValue: normalizedFacts.vehicleValue },
            dialogueState: refusalState
          }
        } : {})
      };
    }
    throwIfAborted(options.signal);
    // Only commit client messages after all cancellable inference succeeded.
    // Attachments below deliberately use these stored IDs, not the ephemeral
    // model-context messages above.
    const inbounds = await Promise.all(messages.map((message) => this.store.addMessage(conversation, { author: "client", body: message.text?.trim() ?? "", attachmentIds: [], attachments: [], metadata: { externalMessageId: message.externalMessageId, channel: message.channel } })));
    let changedFactKeys: string[] = [];
    let managerEvent: "initial" | "delta" | null = null;
    if (turn.result) {
      const turnResult = turn.result;
      const { knowledgeRequest: _knowledgeRequest, ...leadCardPatch } = turnResult.leadCardPatch;
      // The dialogue model receives a full lead-card view and can echo or
      // hallucinate a second money role. A single client amount that has an
      // explicit role in this turn is an immutable boundary: it cannot create
      // the other monetary fact at persistence time.
      const guardedLeadCardPatch = discardConflictingSingleMoneyRole(leadCardPatch, text);
      const modelPatch: Partial<ApplicationFacts> = {
        ...guardedLeadCardPatch,
        ...(resumingPausedConversation ? { clientPaused: false } : {}),
        ...(turnResult.language === "unknown" ? {} : { language: turnResult.language })
      };
      const lastAssistantReply = [...modelMessages].reverse().find((message) => message.author === "ai")?.body ?? "";
      const attachmentFacts = attachmentFactsForCurrentStage({
        previous: application.facts,
        attachments: turnResult.attachments,
        inboundAttachmentCount: attachments.length,
        lastAssistantReply
      });
      const reconciledFacts = effectiveFactsForTurn({ previous: application.facts, modelPatch, explicitFacts: {}, currencyFacts: currencyFactsForTurn, attachmentFacts });
      const effectiveFacts = { ...reconciledFacts, stageCompletion: deriveStageCompletion(reconciledFacts, settings) };
      const preliminaryLimit = selectedProgramLimit(effectiveFacts, settings);
      changedFactKeys = await this.store.updateFacts(application, effectiveFacts);
      await this.store.saveAgentState(application, {
        ...turnResult.dialogueState,
        // A maximum request may be temporarily blocked by vehicle/residence
        // facts. This is server-owned conversational state, not a client-card
        // preference: the next turn that completes those facts receives the
        // deferred range automatically.
        ...(receivedMaximumLoanTemplate && !hasMaximumLoanPrerequisites(reconciledFacts)
          || application.agentState?.nextAction === ANSWER_MAXIMUM_AFTER_PREREQUISITES && !hasMaximumLoanPrerequisites(reconciledFacts)
          ? { nextAction: ANSWER_MAXIMUM_AFTER_PREREQUISITES }
          : {}),
        cardSummary: turnResult.cardSummary,
        intent: turnResult.intent,
        preliminaryLimit,
        newLoanStarted: newLoanWorkflowStarted
      });
      application = (await this.store.getApplication(application.id)) ?? application;
      const initial = Boolean(turnResult.targetEvent) && !application.facts.handedToManager;
      const delta = application.facts.handedToManager && changedFactKeys.some((key) => managerDeltaFactKeys.has(key));
      if (initial) {
        if (await this.store.createManagerNotification(application, "initial", { event: turnResult.targetEvent, summary: turnResult.cardSummary, facts: application.facts })) managerEvent = "initial";
        await this.store.updateFacts(application, { handedToManager: true });
      } else if (delta) {
        const fields = changedFactKeys.filter((key) => managerDeltaFactKeys.has(key));
        if (await this.store.createManagerNotification(application, "delta", { summary: turnResult.cardSummary, changedFactKeys: fields, facts: Object.fromEntries(fields.map((key) => [key, (application.facts as Record<string, unknown>)[key]])) })) managerEvent = "delta";
      }
    }
    // Keep the uploaded files even if RouterAI is unavailable. Recognition can
    // be retried later, but a temporary model outage must not discard client
    // documents or turn their upload into a system-error response.
    for (const attachment of attachments) {
      const recognized = turn.result?.attachments.find((item) => item.attachmentId === attachment.id);
      const inbound = inbounds[messages.findIndex((message) => message.attachments.some((candidate) => candidate.id === attachment.id))] ?? inbounds.at(-1);
      await this.store.addAttachment({ conversationId: conversation.id, messageId: inbound?.id, type: recognized?.type ?? "unknown", status: recognized?.status ?? "received", fileName: attachment.fileName, mimeType: attachment.mimeType, byteSize: typeof attachment.metadata?.byteSize === "number" ? attachment.metadata?.byteSize : undefined, storageKey: typeof attachment.metadata?.storageKey === "string" ? attachment.metadata?.storageKey : undefined });
    }
    // Preserve the client's progress even if the model was temporarily unable
    // to classify the upload or return a valid answer for this turn.
    if (attachments.length > 0 && !application.facts.documentsProvided) {
      const lastAssistantReply = [...modelMessages].reverse().find((message) => message.author === "ai")?.body ?? "";
      const attachmentFallback = isCarPhotoStagePrompt(lastAssistantReply)
        ? { documents: { ...(application.facts.documents ?? {}), car_photo: "received" as const } }
        : { documentsProvided: true };
      const fallbackChangedFactKeys = await this.store.updateFacts(application, attachmentFallback);
      changedFactKeys = [...new Set([...changedFactKeys, ...fallbackChangedFactKeys])];
      application = (await this.store.getApplication(application.id)) ?? application;
    }
    const validation = { passed: Boolean(turn.result), errors: turn.error ? [turn.error] : [] };
    // A real output renderer receives the complete plan including FX above.
    // Keep the old composition path for test doubles and legacy callers that
    // do not implement the renderer yet.
    // The output model and server follow-up can independently include the
    // same instruction. Deduplicate at the final delivery boundary so the
    // persisted and returned message are identical.
    const plannedReply = ensureNonEmptyClientReply(
      stripUnrequestedAssistanceOffers(removeEarlierDuplicateSentences(composeReply(turn.reply, currency.clientText))),
      application.facts
    );
    // Knowledge lookup replaces the main-turn response with its own approved
    // answer. Re-apply the compliance greeting at the final delivery boundary
    // so the first visible reply always has it, including FAQ/KB paths.
    const reply = vehicleValueBelowMinimum
      ? VEHICLE_VALUE_BELOW_MINIMUM_REPLY
      : serverOwnsReply
        ? plannedReply
        : suppressFirstContactGreeting
          ? plannedReply
        : enforceFirstContactGreeting(plannedReply, {
      messages: conversation.messages,
      text,
      currentTurnMessages,
      hadPriorAssistantMessage: conversation.messages.some((message) => message.author === "ai")
    });
    // The batcher may process several already-received client messages in
    // sequence. Facts and client messages must commit after every one, but
    // only the final combined reply may appear in the visible history.
    if (options.deferReplyPersistence) {
      return { conversation, application, reply, validation, routerAiModel: turn.model, promptVersion: turn.promptVersion, needsKnowledgeLookup: turn.result?.needsKnowledgeLookup, summaryNeedsRefresh: changedFactKeys.length > 0 };
    }
    await this.store.addMessage(conversation, { author: "ai", body: reply, attachmentIds: [], attachments: [], metadata: { sourceMessageId: lastMessage.externalMessageId, routerAiModel: turn.model, promptVersion: turn.promptVersion, validation, trace: { singleModel: true, batchedClientMessages: messages.length, changedFactKeys, managerEvent, intent: turn.result?.intent, targetEvent: turn.result?.targetEvent } } });
    // This is a mutable private snapshot, not a one-time visit artifact.
    // Refresh it after every persisted lead-card change so managers see the
    // current application before documents or a visit are complete.
    if (changedFactKeys.length > 0) {
      this.refreshDialogueSummary({
        conversationId: conversation.id,
        applicationId: application.id,
        facts: application.facts,
        messages: [...turnMessages, { id: "pending-ai-summary", author: "ai", body: reply, attachmentIds: [], attachments: [], createdAt: new Date().toISOString() }]
      });
    }
    const refreshedConversation = (await this.store.getConversation(conversation.id)) ?? conversation;
    const refreshedApplication = (await this.store.getApplication(application.id)) ?? refreshedConversation.application ?? application;
    void this.logs.log("dialogue.single-agent", "Processed dialogue turn", { conversationId: conversation.id, metadata: { applicationId: refreshedApplication.id, validModelResult: Boolean(turn.result), model: turn.model } });
    return { conversation: refreshedConversation, application: refreshedApplication, reply, validation, routerAiModel: turn.model, promptVersion: turn.promptVersion, needsKnowledgeLookup: turn.result?.needsKnowledgeLookup };
  }

  /** Publishes the one visible reply after a sequentially processed batch. */
  async publishDeferredBatchReply(result: DialogueResult, reply: string, sourceMessageId: string, options?: { refreshSummary: true }): Promise<DialogueResult> {
    const plannedReply = ensureNonEmptyClientReply(removeEarlierDuplicateSentences(reply), result.application.facts);
    const visibleReply = enforceFirstContactGreeting(plannedReply, {
      messages: result.conversation.messages,
      text: "",
      hadPriorAssistantMessage: result.conversation.messages.some((message) => message.author === "ai")
    });
    await this.store.addMessage(result.conversation, {
      author: "ai", body: visibleReply, attachmentIds: [], attachments: [],
      metadata: {
        sourceMessageId, routerAiModel: result.routerAiModel, promptVersion: result.promptVersion,
        validation: result.validation,
        trace: { singleModel: true, batchedClientMessages: true, deferredReply: true }
      }
    });
    if (options?.refreshSummary) {
      this.refreshDialogueSummary({
        conversationId: result.conversation.id,
        applicationId: result.application.id,
        facts: result.application.facts,
        messages: [{ id: "pending-ai-summary", author: "ai", body: visibleReply, attachmentIds: [], attachments: [], createdAt: new Date().toISOString() }]
      });
    }
    const conversation = (await this.store.getConversation(result.conversation.id)) ?? result.conversation;
    const application = (await this.store.getApplication(result.application.id)) ?? conversation.application ?? result.application;
    return { ...result, conversation, application, reply: visibleReply };
  }

  /** Summary is useful to staff, but must never delay the client reply. */
  private refreshDialogueSummary(input: {
    conversationId: string;
    applicationId: string;
    facts: ApplicationFacts;
    messages: Stage1Message[];
  }): void {
    const summarizeDialogue = (this.agent as Partial<Pick<AgentTurnService, "summarizeDialogue">>).summarizeDialogue;
    if (!summarizeDialogue) return;
    void (async () => {
      const summary = await summarizeDialogue.call(this.agent, {
        conversationId: input.conversationId,
        facts: input.facts,
        messages: input.messages
      });
      if (summary) await this.store.saveDialogueSummary(input.applicationId, summary);
    })().catch((error: unknown) => void this.logs.warn("dialogue.summary-model", "Background dialogue summary persistence failed", {
      conversationId: input.conversationId,
      metadata: { error: error instanceof Error ? error.message : String(error) }
    }));
  }
}

function extractWorkflowFollowUp(reply: string): string {
  // `AgentTurnService` always appends the server-owned workflow text as the
  // final paragraph. Do not infer it from just "Подскажите": a visit prompt
  // begins with office hours and an amount-limit branch begins with the
  // approved limit explanation.
  const candidate = reply.trim().split(/\n{2,}/gu).at(-1)?.trim() ?? "";
  return /^(?:подскажите|какая\s+сумма\s+займа|вас\s+интересует|пожалуйста,?\s+(?:отправьте|пришлите)|офис\s+работает|по\s+программе\s+(?:без\s+изъятия|со\s+стоянкой)\s+доступно\s+до)/iu.test(candidate)
    ? candidate
    : "";
}

export function appendWorkflowFollowUp(reply: string, followUp: string, lastAssistantMessage = ""): string {
  const normalizedReply = reply.replace(/[?!.]/gu, "").replace(/\s+/gu, " ").trim().toLocaleLowerCase("ru-RU");
  const normalizedFollowUp = followUp.replace(/[?!.]/gu, "").replace(/\s+/gu, " ").trim().toLocaleLowerCase("ru-RU");
  const normalizedLastAssistant = lastAssistantMessage.replace(/[?!.]/gu, "").replace(/\s+/gu, " ").trim().toLocaleLowerCase("ru-RU");
  if (!normalizedFollowUp || normalizedReply.includes(normalizedFollowUp) || normalizedLastAssistant.includes(normalizedFollowUp) || (asksForResidenceIn(reply) && asksForResidenceIn(followUp))) return reply;
  return [reply.trim(), followUp].filter(Boolean).join("\n\n");
}

/** A KB answer may use a shorter wording than the canonical residence prompt. */
function asksForResidenceIn(text: string): boolean {
  return /(?:подскажите|уточните)[^?!\n]{0,120}(?:пропис|регион)|(?:пропис|регион)[^?!\n]{0,120}\?/iu.test(text);
}

/** A maximum-limit answer may be followed by one server-owned prerequisite,
 * never by a KB/model echo of another application stage. */
function stripWorkflowQuestionsFromMaximumAnswer(reply: string): string {
  return reply
    .replace(
      /(?:^|\n|\s{2,})(?:(?:подскажите|уточните),?\s+(?:пожалуйста,?\s*)?(?:модель|марку|год|стоимост\p{L}*|сумм\p{L}*|пропис|ваш\p{L}*\s+пропис)[^?!\n]*(?:[?!]|[.!](?=\s|$))|какая\s+сумм\p{L}*\s+займ[^?!\n]*(?:[?!]|[.!](?=\s|$))|вас\s+интересует[^?!\n]*(?:[?!]|[.!](?=\s|$))|пожалуйста,?\s+(?:отправьте|пришлите)[^?!\n]*(?:[?!]|[.!](?=\s|$)))/giu,
      "\n"
    )
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * A maximum-range FAQ is itself the answer to the amount-stage question.
 * Repeating that question immediately after the two ranges traps the client
 * in the same stage. This narrowly applies only when the prior server prompt
 * collected the requested amount; other FAQ answers keep their normal stage
 * follow-up.
 */
export function workflowFollowUpAfterKnowledge(reply: string, followUp: string, lastAssistantMessage: string, facts?: ApplicationFacts, _maximumLoanQuestion = false): string {
  // Only the approved FAQ's two placeholders identify a maximum-range
  // response. No model wording or user-text pattern may change its workflow.
  if (!hasMaximumLoanPlaceholders(reply)) return followUp;
  if (facts && (!facts.residenceRegion || !facts.residenceCategory || facts.vehicleValue === undefined)) {
    return maximumLoanCalculationFollowUp(facts, followUp);
  }
  // The maximum range replaces (rather than supplements) only the current
  // requested-amount prompt. For every other stage, including vehicle,
  // documents, family and visit, the client must receive the next canonical
  // server-owned question after the FAQ answer.
  if (facts && isRequestedAmountStagePrompt(lastAssistantMessage)) return "";
  return followUp;
}

function isRequestedAmountStagePrompt(text: string): boolean {
  return /(?:какая\s+)?сумм\p{L}*\s+займ/iu.test(text);
}

function hasMaximumLoanPlaceholders(text: string): boolean {
  return /MAX_LIMIT_WITHOUT/iu.test(text) && /MAX_LIMIT_PARK/iu.test(text);
}

function maximumLoanCalculationFollowUp(facts: ApplicationFacts, fallback: string): string {
  if (!deriveStageCompletion(facts).vehicle) return nextRequiredStageQuestion(facts, deriveStageCompletion(facts)) ?? fallback;
  if (!facts.residenceRegion || !facts.residenceCategory) {
    return "Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.";
  }
  return fallback;
}

function hasMaximumLoanPrerequisites(facts: ApplicationFacts): boolean {
  return Boolean(
    facts.vehicleModel
    && facts.vehicleYear !== undefined
    && facts.vehicleValue !== undefined
    && facts.residenceRegion
    && facts.residenceCategory
  );
}

/**
 * A KB template must never reach the client with an unresolved variable.
 * This is deliberately the final server boundary, after every model and
 * workflow composer. It also protects a persisted legacy KB answer.
 */
export function replaceMaximumLimitPlaceholders(reply: string, facts: ApplicationFacts, settings: object): string {
  const containsMaximumRange = /(?:MAX_LIMIT_(?:WITHOUT|PARK)|(?:Без\s+изъятия|Со\s+стоянкой)\s*:\s*от\s+50\s*000\s+сом\s+до)/iu.test(reply);
  if (!containsMaximumRange) return reply;
  const displayMaximums = calculateLoanRangeDisplayMaximums(facts, settings);
  const withoutTemplate = /(?:Какая\s+максимальная\s+сумма\s+возможна\?\s*)?Без\s+изъятия:\s*от\s+50\s*000\s+сом\s+до\s+MAX_LIMIT_WITHOUT\s+сом[.!?]?\s*/giu;
  const parkingTemplate = /Со\s+стоянкой:\s*от\s+50\s*000\s+сом\s+до\s+MAX_LIMIT_PARK\s+сом[.!?]?\s*/giu;

  // The maximum/minimum FAQ presents both preliminary ranges. It must not
  // turn a later programme-eligibility decision into an "unavailable" answer
  // here; that decision still uses `calculateLoanPricing` in the workflow.
  if (typeof displayMaximums.withoutStorage === "number" && typeof displayMaximums.parking === "number") {
    return reply
      .replace(/MAX_LIMIT_WITHOUT/giu, formatSomMoney(displayMaximums.withoutStorage))
      .replace(/MAX_LIMIT_PARK/giu, formatSomMoney(displayMaximums.parking))
      .replace(/\n{3,}/gu, "\n\n")
      .replace(/[ \t]{2,}/gu, " ")
      .trim();
  }
  const answerWithoutTemplate = reply
    .replace(withoutTemplate, "")
    .replace(parkingTemplate, "")
    // A model can corrupt a placeholder (for example leave only `som`).
    // Before all calculation prerequisites exist, no client-facing range may
    // survive in any spelling.
    .replace(/(?:^|\n)\s*(?:Без\s+изъятия|Со\s+стоянкой)\s*:\s*от\s+50\s*000\s+сом\s+до[^\n]*/giu, "")
    // This heading belongs to the two ranges and must not be delivered on
    // its own after the missing-data explanation.
    .replace(/(?:^|\n)\s*Для\s+вас\s+доступно:\s*(?=\n|$)/giu, "\n")
    .replace(/MAX_LIMIT_(?:WITHOUT|PARK)/giu, "")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const missing = [
    facts.vehicleValue === undefined ? "ориентировочную стоимость автомобиля" : undefined,
    !facts.residenceRegion || !facts.residenceCategory ? "Вашу прописку" : undefined
  ].filter((value): value is string => Boolean(value));
  const clarification = "Максимальную сумму смогу рассчитать после того, как узнаю: "
    + (missing.length > 0 ? missing : ["ориентировочную стоимость автомобиля и Вашу прописку"]).join(" и ")
    + ".";
  // The knowledge answer comes first, then the next server-owned collection
  // question. This makes the missing-data explanation readable and keeps the
  // workflow prompt after it.
  return [clarification, answerWithoutTemplate].filter(Boolean).join("\n\n");
}

function toPendingInboundMessage(message: InboundMessage): Stage1Message {
  return {
    id: message.externalMessageId,
    author: "client",
    body: message.text?.trim() ?? "",
    attachmentIds: [],
    attachments: [],
    createdAt: message.timestamp.toISOString(),
    metadata: { externalMessageId: message.externalMessageId, channel: message.channel }
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Dialogue turn superseded by a newer client message", "AbortError");
  }
}

/** Any new application action resumes a saved conversation. Keep it narrow so
 * an explicit second postponement continues to be treated as a pause. */
function isPausedConversationContinuation(text: string): boolean {
  const normalized = text.trim().toLocaleLowerCase("ru-RU");
  if (!normalized) return false;
  return !/^(?:потом\s+(?:напиш\p{L}*|отвеч\p{L}*|продолж\p{L}*)|вернусь\s+позже|давайте\s+(?:продолжим\s+)?потом|сейчас\s+(?:некогда|не\s+могу|занят(?:а)?|занят)|подумаю(?:\s+и\s+напишу)?|пока\s+не\s+решил(?:а)?)[.!\s]*$/iu.test(normalized);
}

function supplementNormalizedMoney(values: NormalizedMoneyValue[], text: string, currentFacts: ApplicationFacts, messages: Stage1Message[] = [], moneyClarification?: PendingMoneyClarificationDecision): NormalizedMoneyValue[] {
  const expectedField = expectedMoneyFieldFromLastQuestion(messages);
  const classifiedValue = moneyValueFromClarificationDecision(text, messages, moneyClarification);
  const mentions = detectMoneyMentions(text);
  const singleMention = mentions.length === 1 ? mentions[0] : undefined;
  // In an amount-collection context, clients routinely omit «тысяч»: «мне
  // надо 300» means 300 000 сом, not 300 som. This must be resolved from the
  // current turn before the semantic normalizer can echo a previously shown
  // programme maximum as the requested amount.
  const shortRequestedAmount = shortRequestedAmountFromActiveQuestion(text, expectedField, singleMention);
  // One client-written amount is one fact, never evidence for both the loan
  // and the vehicle. A direct loan cue («нужно», «требуется», «потребуется»)
  // is authoritative over an erroneous normalizer response that emits both
  // fields for the same number.
  const singleExplicitRole = singleMention?.roleCandidate === "requestedAmount" || singleMention?.roleCandidate === "vehicleValue"
    ? singleMention.roleCandidate
    : undefined;
  const result = classifiedValue
    ? [classifiedValue]
    : shortRequestedAmount
      ? [shortRequestedAmount]
      : singleExplicitRole
      ? [{ field: singleExplicitRole, amount: singleMention!.normalizedAmount, currency: singleMention!.currency ?? "KGS" as const, confidence: singleMention!.confidence }]
      : values.filter((value) => value.amount > 0 && (!expectedField || value.field === expectedField));
  // The model can be uncertain about an unqualified standalone amount, but it
  // must still never duplicate that one mention into both lead-card fields.
  if (!classifiedValue && singleMention && !singleExplicitRole && result.length > 1) {
    const preferredField = expectedField ?? result[0]!.field;
    result.splice(0, result.length, ...result.filter((value) => value.field === preferredField).slice(0, 1));
  }
  // The model remains the primary normalizer. This is a deliberately narrow
  // correction for an unambiguous numeric construction it can occasionally
  // truncate: «1 млн с половиной» must never reach pricing as 1 млн. It is
  // not a heuristic role assignment—the deterministic parser has already
  // established both the explicit unit and the role cue.
  for (const mention of mentions) {
    const start = mention.start ?? 0;
    if (!/\d\s*(?:млн|миллион)\s+с\s+половин/iu.test(text.slice(start, (mention.end ?? start) + 32))) continue;
    if (mention.roleCandidate !== "requestedAmount" && mention.roleCandidate !== "vehicleValue") continue;
    const index = result.findIndex((value) => value.field === mention.roleCandidate);
    const normalized = { field: mention.roleCandidate, amount: mention.normalizedAmount, currency: mention.currency ?? "KGS" as const, confidence: mention.confidence };
    if (index >= 0) result[index] = normalized;
    else result.push(normalized);
  }
  const present = new Set(result.map((value) => value.field));
  const resolved = resolveMoneyFacts({ text, currentFacts });
  // The last workflow question is a deterministic role boundary. A bare
  // amount after «Какая сумма займа?» is the requested amount, never an
  // unknown value or a programme choice; do not delegate that to the model.
  if (expectedField && !present.has(expectedField) && mentions.length === 1) {
    const mention = mentions[0]!;
    result.push({ field: expectedField, amount: mention.normalizedAmount, currency: mention.currency ?? "KGS", confidence: mention.confidence });
    present.add(expectedField);
  }
  for (const field of ["vehicleValue", "requestedAmount"] as const) {
    if (present.has(field)) continue;
    const mention = mentions
      .filter((candidate) => candidate.roleCandidate === field)
      .sort((left, right) => right.confidence - left.confidence || (left.start ?? Number.MAX_SAFE_INTEGER) - (right.start ?? Number.MAX_SAFE_INTEGER))[0];
    if (!mention) continue;
    result.push({ field, amount: mention.normalizedAmount, currency: mention.currency ?? "KGS", confidence: mention.confidence });
    present.add(field);
  }
  // Preserve the no-guessing rule for bare money. This branch applies only
  // when the currency is explicit and resolveMoneyFacts can associate a
  // correction with an existing lead-card fact (for example a corrected car
  // price: «стоимость перепутал, 20к долларов»).
  for (const field of ["vehicleValue", "requestedAmount"] as const) {
    if (present.has(field)) continue;
    const amount = resolved[field];
    const currency = resolved[field === "vehicleValue" ? "vehicleValueCurrency" : "requestedAmountCurrency"];
    if (typeof amount !== "number" || !currency || currency === "KGS") continue;
    result.push({ field, amount, currency, confidence: 0.9 });
    present.add(field);
  }
  // A clear confirmation («да») answers the immediately preceding money-role
  // clarification. Recover that explicit foreign amount from the preceding
  // client message instead of making the customer type it a second time.
  for (const value of confirmedForeignMoneyFromHistory(text, messages)) {
    if (present.has(value.field)) continue;
    result.push(value);
    present.add(value.field);
  }
  // A client may correct only the currency after the agent repeats the exact
  // amount for confirmation: «10 тысяч сом, верно?» → «долларов». The
  // number is not a new fact from history; it is the immediately pending
  // confirmation, and the current message supplies its explicit currency.
  for (const value of currencyOnlyForeignMoneyFromHistory(text, messages)) {
    if (present.has(value.field)) continue;
    result.push(value);
    present.add(value.field);
  }
  // Once a car price exists, changing it requires an explicit price/car cue.
  // A later bare number is always the requested loan amount; otherwise a
  // model that emits both roles can silently rewrite collateral valuation.
  const mayReplaceVehicleValue = currentFacts.vehicleValue === undefined || isExplicitVehicleValueCorrectionText(text);
  return mayReplaceVehicleValue
    ? result
    : result.filter((value) => value.field !== "vehicleValue");
}

/** A 2–3 digit shorthand is unambiguous only while the server awaits the loan amount. */
function shortRequestedAmountFromActiveQuestion(text: string, expectedField: "vehicleValue" | "requestedAmount" | undefined, mention: ReturnType<typeof detectMoneyMentions>[number] | undefined): NormalizedMoneyValue | undefined {
  if (expectedField !== "requestedAmount") return undefined;
  const shorthandMention = mention
    && mention.roleCandidate === "requestedAmount"
    && mention.normalizedAmount >= 50
    && mention.normalizedAmount < 1_000
    && !/(?:тыс|тыщ|млн|миллион|лям|\d\s*[кk](?=\s|$))/iu.test(mention.sourceText)
    ? mention
    : undefined;
  const match = text.trim().match(/^(?:(?:мне\s+)?(?:надо|нужно|хочу|требуется|давай(?:те)?|беру)\s+)?(\d{2,3})(?:\s+(?:сом\p{L}*|дол+ар\p{L}*|евро|тенге|руб\p{L}*|USD|EUR|KZT|RUB))?[.!\s]*$/iu);
  const thousands = shorthandMention?.normalizedAmount ?? Number(match?.[1]);
  if (!Number.isInteger(thousands) || thousands < 50) return undefined;
  return { field: "requestedAmount", amount: thousands * 1_000, currency: shorthandMention?.currency ?? "KGS", confidence: 0.99 };
}

/** Final persistence boundary for the main dialogue model's lead-card patch.
 * The dedicated normalizer resolves current-turn money first; this guard
 * prevents a model echo from turning one explicit amount into two facts. */
function discardConflictingSingleMoneyRole(patch: Partial<ApplicationFacts>, text: string): Partial<ApplicationFacts> {
  const mentions = detectMoneyMentions(text);
  const role = mentions.length === 1 ? mentions[0]?.roleCandidate : undefined;
  if (role !== "requestedAmount" && role !== "vehicleValue") return patch;
  const conflictingKeys = role === "requestedAmount"
    ? new Set(["vehicleValue", "vehicleValueSourceCurrency"])
    : new Set(["requestedAmount", "requestedAmountSourceCurrency"]);
  return Object.fromEntries(Object.entries(patch).filter(([key]) => !conflictingKeys.has(key))) as Partial<ApplicationFacts>;
}

/** A narrow role guard for a correction of the amount requested by client. */
function isRequestedAmountCorrectionText(text: string): boolean {
  const normalized = text.toLocaleLowerCase("ru-RU");
  const amount = String.raw`\d[\d\s.,]*(?:к|кк|тыс\.?|тысяч\p{L}*|млн|миллион\p{L}*)?`;
  return new RegExp(
    String.raw`(?:(?:не|вместо)\s+${amount}\s+(?:а|а\s+не)\s+${amount}|(?:я\s+)?(?:всё\s*[- ]?таки\s+)?(?:хочу|мне\s+(?:нужно|надо)|нужно|надо|требуется|давай(?:те)?|беру)\s+(?:сумм\p{L}*\s+)?${amount}|мне\s+(?:всё\s*[- ]?таки\s+)?(?:нужно|надо)\s+(?:сумм\p{L}*\s+)?${amount}|(?:мне\s+)?(?:кстати\s+)?(?:всё\s*[- ]?таки\s+)?${amount}\s+(?:нужно|надо))`,
    "iu"
  ).test(normalized);
}

/** A persisted vehicle price is changed only by an unmistakable price cue. */
function isExplicitVehicleValueCorrectionText(text: string): boolean {
  const normalized = text.toLocaleLowerCase("ru-RU");
  const amount = String.raw`\d[\d\s.,]*(?:к|кк|тыс\.?|тысяч\p{L}*|млн|миллион\p{L}*)?`;
  return new RegExp(
    String.raw`(?:стоимост\p{L}*|цен\p{L}*|оцен\p{L}*|стоит)\s*(?:авто|машин\p{L}*|тачк\p{L}*)?[^.!?]{0,50}${amount}|(?:авто|машин\p{L}*|тачк\p{L}*)[^.!?]{0,40}${amount}`,
    "iu"
  ).test(normalized);
}

function expectedMoneyFieldFromLastQuestion(messages: Stage1Message[]): "vehicleValue" | "requestedAmount" | undefined {
  const lastAssistantIndex = [...messages].map((message) => message.author).lastIndexOf("ai");
  if (lastAssistantIndex < 0) return undefined;
  return pendingMoneyFieldFromHistory(messages, lastAssistantIndex);
}

function pendingMoneyFieldFromHistory(messages: Stage1Message[], startIndex: number): "vehicleValue" | "requestedAmount" | undefined {
  const message = messages[startIndex];
  if (message?.author !== "ai") return undefined;
  if (/(?:какая\s+)?сумм\p{L}*\s+займ/iu.test(message.body)) return "requestedAmount";
  if (/(?:ориентировочн\p{L}*\s+)?стоимост\p{L}*\s+автомобил/iu.test(message.body)) return "vehicleValue";
  return undefined;
}

/** A bare number is a year only when it answers the immediately preceding
 * vehicle-year question. This prevents 2020 / 22 год from invoking the money
 * model merely because an older assistant message mentioned an amount. */
function isBareVehicleYearReply(messages: Stage1Message[], text: string): boolean {
  const lastAssistantMessage = [...messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  if (!/(?:год\s+выпуска|какого\s+года\s+(?:ваш(?:а|его)?\s*)?(?:автомобил|машин|авто))/iu.test(lastAssistantMessage)) return false;
  return /^(?:(?:ладно|тогда|ну|ок(?:ей)?)\s*,?\s*)?(?:год(?:а)?\s*)?(?:(?:19|20)\d{2}|\d{2})(?:\s*(?:г(?:од(?:а)?)?\.?)?)?[.!]?$/iu.test(text.trim());
}

function confirmedForeignMoneyFromHistory(text: string, messages: Stage1Message[]): NormalizedMoneyValue[] {
  if (!/^(?:да|ага|угу|конечно|верно|yes|oui|ооба|оа)$/iu.test(text.trim())) return [];
  const lastAssistantIndex = [...messages].map((message) => message.author).lastIndexOf("ai");
  if (lastAssistantIndex < 1) return [];
  const question = messages[lastAssistantIndex]?.body ?? "";
  const field = /(?:ориентировочн\p{L}*\s+)?стоимост\p{L}*\s+автомобил/iu.test(question)
    ? "vehicleValue"
    : /(?:сумм\p{L}*\s+)?займ/iu.test(question)
      ? "requestedAmount"
      : undefined;
  if (!field) return [];
  const previousClient = [...messages.slice(0, lastAssistantIndex)].reverse().find((message) => message.author === "client")?.body;
  if (!previousClient) return [];
  const mention = detectMoneyMentions(previousClient)
    .filter((item) => item.currency && item.currency !== "KGS")
    .sort((left, right) => right.confidence - left.confidence)[0];
  return mention ? [{ field, amount: mention.normalizedAmount, currency: mention.currency!, confidence: mention.confidence }] : [];
}

function currencyOnlyForeignMoneyFromHistory(text: string, messages: Stage1Message[]): NormalizedMoneyValue[] {
  const currency = explicitForeignCurrencyOnly(text);
  if (!currency) return [];
  const lastAssistantIndex = [...messages].map((message) => message.author).lastIndexOf("ai");
  if (lastAssistantIndex < 0) return [];
  const question = messages[lastAssistantIndex]?.body ?? "";
  if (!isPendingMoneyCurrencyClarificationQuestion(question)) return [];
  const amount = detectMoneyMentions(question)
    .map((mention) => mention.normalizedAmount)
    .find((value) => value > 0);
  const field = pendingMoneyFieldFromHistory(messages, lastAssistantIndex);
  return amount && field ? [{ field, amount, currency, confidence: 0.99 }] : [];
}

function moneyValueFromClarificationDecision(text: string, messages: Stage1Message[], decision: PendingMoneyClarificationDecision | undefined): NormalizedMoneyValue | undefined {
  if (decision?.decision !== "accept") return undefined;
  const lastAssistantIndex = [...messages].map((message) => message.author).lastIndexOf("ai");
  if (lastAssistantIndex < 0) return undefined;
  const question = messages[lastAssistantIndex]?.body ?? "";
  if (!isPendingMoneyCurrencyClarificationQuestion(question)) return undefined;
  const amount = detectMoneyMentions(question)
    .map((mention) => mention.normalizedAmount)
    .find((value) => value > 0);
  const field = pendingMoneyFieldFromHistory(messages, lastAssistantIndex);
  const explicitCurrency = decision.currency && explicitForeignCurrencyOnly(text) === decision.currency
    ? decision.currency
    : undefined;
  return amount && field
    ? { field, amount, currency: explicitCurrency ?? "KGS", confidence: 0.99 }
    : undefined;
}

function explicitForeignCurrencyOnly(text: string): ForeignMoneyCurrencyCode | undefined {
  const source = text.trim().toLocaleLowerCase("ru-RU");
  if (/^(?:в\s+)?(?:usd|\$|дол+ар\p{L}*)[.!\s]*$/u.test(source)) return "USD";
  if (/^(?:в\s+)?(?:eur(?:o)?|€|евро)[.!\s]*$/u.test(source)) return "EUR";
  if (/^(?:в\s+)?(?:kzt|₸|тенге)[.!\s]*$/u.test(source)) return "KZT";
  if (/^(?:в\s+)?(?:rub|₽|руб\p{L}*)[.!\s]*$/u.test(source)) return "RUB";
  return undefined;
}

function isPendingMoneyCurrencyClarificationQuestion(text: string): boolean {
  const amount = "\\d[\\d\\s.,]*(?:тыс\\p{L}*|млн\\p{L}*)?\\s*(?:сом\\p{L}*|дол+ар\\p{L}*|евро|тенге|руб\\p{L}*)";
  const confirmation = "(?:верно|правильно|имели\\s+в\\s+виду|это\\s+сумм\\p{L}*)";
  return new RegExp(`(?:${amount}[^?]{0,80}${confirmation}|${confirmation}[^?]{0,80}${amount})\\s*\\?`, "iu").test(text);
}

/** Knowledge answers must finish after answering the customer's question.
 * A workflow prompt is appended separately by the server, so model-authored
 * offers such as «Если хотите, я могу подсказать…» only add noise. */
export function stripUnrequestedAssistanceOffers(reply: string): string {
  return reply
    .replace(/\s*если\s+хотите,?[^.!?\n]*(?:помогу|подскажу|сориентирую|расскажу|объясню)[^.!?\n]*[.!?]?/giu, "")
    .replace(/\s*(?:если\s+хотите,?\s*)?(?:я\s+)?(?<!\p{L})могу(?!\p{L})\s+(?:подсказать|помочь|сориентировать|рассказать|объяснить)[^.!?\n]*[.!?]?/giu, "")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\s+([,.!?])/gu, "$1")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** Keep the conversational order: greeting/introduction first, then the
 * server-confirmed currency explanation, then the model's next-step reply.
 * The model is instructed not to repeat this explanation, but removing an
 * exact duplicate here makes the public reply idempotent as well. */
export function composeReply(modelReply: string, currencyText?: string): string {
  const cleanReply = currencyText
    ? modelReply.split(currencyText).join("").replace(/(?:По\s+(?:текущему|официальному)\s+курсу)[^.!?\n]*сом[.!]?/giu, "").replace(/(?:•\s*)?(?:Стоимость автомобиля|Необходимая сумма займа)\s*:[^.!?\n]*сом[.!]?/giu, "").replace(/(?:•\s*)?[^.!?\n]{0,180}ориентировочно\s+[\d\s\u00a0]+сом[.!]?/giu, "").replace(/—\s*(?:стоимость автомобиля|необходимая сумма займа)\.?\s*/giu, "").replace(/\s*;\s*(?=[А-ЯЁ])/gu, " ").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim()
    : modelReply.trim();
  if (!currencyText) return cleanReply;
  const officialGreeting = "Здравствуйте! Меня зовут Айлин. Я менеджер по оформлению новых займов автоломбарда «Молодой».";
  const introduction = cleanReply.trimStart().startsWith(officialGreeting)
    ? officialGreeting
    : cleanReply.match(/^\s*((?:Здравствуйте|Добрый\s+(?:день|вечер)|Салам(?:атсызбы)?)[!,.]?\s*(?:(?:Меня\s+зовут|Я)\s+Айлин[^.!?\n]*[.!?]\s*)?)/iu)?.[1]?.trim();
  if (!introduction) return [currencyText, cleanReply].filter(Boolean).join("\n\n");
  const rest = cleanReply.slice(introduction.length).trim();
  return [introduction, currencyText, rest].filter(Boolean).join("\n\n");
}

/** Never persist an empty assistant message: an empty body renders as a
 * phantom attachment in some channel clients and leaves the customer without
 * a recoverable workflow instruction. */
function ensureNonEmptyClientReply(reply: string, facts: ApplicationFacts): string {
  const normalized = reply.trim();
  return normalized || nextRequiredStageQuestion(facts) || "Пожалуйста, уточните Ваш вопрос.";
}

/**
 * If a later sentence repeats the opening three words of an earlier sentence,
 * keep the later (usually canonical server) wording and remove the first.
 * Matching arbitrary fragments is unsafe: a knowledge answer and its
 * follow-up often both mention a required fact such as «ориентировочную
 * стоимость автомобиля».
 */
export function removeEarlierDuplicateSentences(reply: string): string {
  const sentences = reply.match(/[^.!?]+[.!?]+|[^.!?]+$/gu) ?? [];
  const firstByFragment = new Map<string, number>();
  const remove = new Set<number>();
  for (const [index, sentence] of sentences.entries()) {
    // These are distinct server-owned conversion records. They necessarily
    // share phrases such as "евро — ориентировочно … сом", but their role and
    // amount differ; never let generic prose deduplication remove one.
    if (/(?:стоимость\s+автомобиля|необходимая\s+сумма\s+займа)\s*:/iu.test(sentence)) continue;
    const words = sentence.toLocaleLowerCase("ru-RU").match(/[\p{L}\p{N}]+/gu) ?? [];
    if (words.length < 3) continue;
    const key = words.slice(0, 3).join(" ");
    const first = firstByFragment.get(key);
    // A calculation may repeat a shared floor such as «50 000 сом» in two
    // programme ranges. It is not an opening phrase and therefore does not
    // make either sentence a duplicate.
    if (first !== undefined && first !== index) remove.add(first);
    firstByFragment.set(key, index);
  }
  return sentences
    .filter((_, index) => !remove.has(index))
    .join("")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

// Public compatibility symbols kept while the old orchestration path is removed.
export function buildDialogueContext(): never { throw new Error("Dialogue context is owned by AgentTurnService."); }
export function alignExtractionToPendingFacts<T>(value: T): T { return value; }
export function selectClientQuestions(): [] { return []; }
export function detectRecoveryHint(): undefined { return undefined; }
export const MAX_DIALOGUE_RECENT_MESSAGES = Number.MAX_SAFE_INTEGER;
export const MAX_DIALOGUE_MESSAGE_LENGTH = Number.MAX_SAFE_INTEGER;
export const MAX_DIALOGUE_SUMMARY_LENGTH = Number.MAX_SAFE_INTEGER;
export function validateRouteProposal(): { kind: "none" } { return { kind: "none" }; }
export function discardUnknownCurrencyMoneyFacts(): void {}
export function getWritableMoneyMentionKeys(): [] { return []; }
export async function resolveForeignCurrencyFacts(text: string | undefined, currentFacts: ApplicationFacts, integrations?: DeferredIntegrationsService): Promise<{ facts: Partial<ApplicationFacts>; conversions: { role: "requestedAmount" | "vehicleValue"; amount: number; currency: ForeignMoneyCurrencyCode; somValue: number; effectiveDate: string }[]; clientText?: string }> {
  if (!text || !integrations) return { facts: {}, conversions: [] };
  const money = resolveMoneyFacts({ text, currentFacts });
  const mentionFor = (role: "requestedAmount" | "vehicleValue") => money.mentions.find((item) => item.roleCandidate === role);
  const requestedMention = mentionFor("requestedAmount");
  const vehicleMention = mentionFor("vehicleValue");
  const detectedCurrencies = [money.requestedAmountCurrency, money.vehicleValueCurrency, ...money.mentions.map((item) => item.currency)].filter(isForeignCurrency);
  const sharedCurrency = new Set(detectedCurrencies).size === 1 ? detectedCurrencies[0] : undefined;
  const candidates: Array<{ role: "requestedAmount" | "vehicleValue"; amount?: number; currency?: string }> = [
    { role: "requestedAmount", amount: money.requestedAmount ?? requestedMention?.normalizedAmount, currency: money.requestedAmountCurrency ?? requestedMention?.currency ?? sharedCurrency },
    { role: "vehicleValue", amount: money.vehicleValue ?? vehicleMention?.normalizedAmount, currency: money.vehicleValueCurrency ?? vehicleMention?.currency ?? sharedCurrency }
  ];
  const facts: Partial<ApplicationFacts> = {};
  const conversions: { role: "requestedAmount" | "vehicleValue"; amount: number; currency: ForeignMoneyCurrencyCode; somValue: number; effectiveDate: string }[] = [];
  for (const candidate of candidates) {
    if (!candidate.amount || !candidate.currency || candidate.currency === "KGS" || !isForeignCurrency(candidate.currency)) continue;
    const conversion = await integrations.convertToSom({ amount: candidate.amount, currency: candidate.currency });
    if (!conversion.available) continue;
    facts[candidate.role] = roundSomAmount(conversion.value);
    facts[candidate.role === "requestedAmount" ? "requestedAmountSourceCurrency" : "vehicleValueSourceCurrency"] = candidate.currency;
    conversions.push({ role: candidate.role, amount: candidate.amount, currency: candidate.currency, somValue: roundSomAmount(conversion.value), effectiveDate: conversion.effectiveDate });
  }
  const clientText = formatConversionText(conversions);
  return { facts, conversions, clientText };
}

export async function resolveNormalizedMoneyFacts(values: NormalizedMoneyValue[], integrations?: DeferredIntegrationsService, existingFacts?: ApplicationFacts): Promise<{ facts: Partial<ApplicationFacts>; conversions: { role: "requestedAmount" | "vehicleValue"; amount: number; currency: ForeignMoneyCurrencyCode; somValue: number; effectiveDate: string }[]; clientText?: string }> {
  if (values.length === 0) return { facts: {}, conversions: [] };
  const facts: Partial<ApplicationFacts> = {};
  const conversions: { role: "requestedAmount" | "vehicleValue"; amount: number; currency: ForeignMoneyCurrencyCode; somValue: number; effectiveDate: string }[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.field)) continue;
    seen.add(value.field);
    if (value.currency === "KGS") {
      if (existingFacts?.[value.field] === Math.round(value.amount)) continue;
      facts[value.field] = roundSomAmount(value.amount);
      // A new som amount supersedes a previously converted foreign-currency
      // amount. Leaving (for example) USD here makes the card internally
      // inconsistent and can cause a later turn to treat the old currency as
      // the source of the new amount.
      facts[value.field === "requestedAmount" ? "requestedAmountSourceCurrency" : "vehicleValueSourceCurrency"] = undefined;
      continue;
    }
    if (!integrations) continue;
    const conversion = await integrations.convertToSom({ amount: value.amount, currency: value.currency });
    if (!conversion.available) continue;
    // The normalizer can repeat an amount visible in the prior assistant
    // message. Do not turn that into a second public currency block.
    if (existingFacts?.[value.field] === conversion.value) continue;
    facts[value.field] = roundSomAmount(conversion.value);
    facts[value.field === "requestedAmount" ? "requestedAmountSourceCurrency" : "vehicleValueSourceCurrency"] = value.currency;
    conversions.push({ role: value.field, amount: value.amount, currency: value.currency, somValue: roundSomAmount(conversion.value), effectiveDate: conversion.effectiveDate });
  }
  return { facts, conversions, clientText: formatConversionText(conversions) };
}

function formatConversionText(conversions: { role: "requestedAmount" | "vehicleValue"; amount: number; currency: ForeignMoneyCurrencyCode; somValue: number }[]): string | undefined {
  if (conversions.length === 0) return undefined;
  const lines = conversions.map((item) => `• ${item.role === "vehicleValue" ? "Стоимость автомобиля" : "Необходимая сумма займа"}: ${formatForeignMoney(item.amount, item.currency)} — ориентировочно ${formatSomMoney(item.somValue)} сом.`);
  return `По текущему курсу НБКР:\n${lines.join("\n")}`;
}

function isForeignCurrency(value: string | null | undefined): value is ForeignMoneyCurrencyCode {
  return value === "USD" || value === "EUR" || value === "KZT" || value === "RUB";
}

function formatForeignMoney(amount: number, currency: ForeignMoneyCurrencyCode): string {
  const label = { USD: "долларов США", EUR: "евро", KZT: "тенге", RUB: "российских рублей" }[currency];
  return `${formatMoney(amount)} ${label}`;
}
