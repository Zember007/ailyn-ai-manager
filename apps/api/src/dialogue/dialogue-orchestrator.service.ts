import { Injectable } from "@nestjs/common";
import type { ApplicationFacts, DocumentCode } from "@ailyn/business-rules";
import { evaluateApplication } from "@ailyn/business-rules";
import { AiService } from "../ai/ai.service.js";
import type { InboundMessage } from "../channels/channel.interface.js";
import { ResponsePlanService } from "./response-plan.service.js";
import { ResponseValidatorService } from "./response-validator.service.js";
import { Stage1StoreService, type Stage1Application, type Stage1Conversation } from "./stage1-store.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { BackendLogsService } from "../logs/backend-logs.service.js";
import { KnowledgeBaseResolverService } from "./knowledge-base-resolver.service.js";
import { DeferredIntegrationsService } from "./deferred-integrations.service.js";
import type { FxConversionTrace } from "./pipeline.contracts.js";
import type { MoneyMention } from "./money-normalization.js";

type RecoveryHint = {
  unresolvedFacts: string[];
  reason: "unrecognized_reply" | "attachment_issue" | "fx_unavailable";
};

export interface DialogueResult {
  conversation: Stage1Conversation;
  application: Stage1Application;
  reply: string;
  validation: { passed: boolean; errors: string[] };
  routerAiModel: string;
  promptVersion: string;
}

@Injectable()
export class DialogueOrchestratorService {
  constructor(
    private readonly ai: AiService,
    private readonly store: Stage1StoreService,
    private readonly responsePlan: ResponsePlanService,
    private readonly validator: ResponseValidatorService,
    private readonly settings: SettingsService,
    private readonly logs: BackendLogsService,
    private readonly deferredIntegrations: DeferredIntegrationsService,
    private readonly knowledge?: KnowledgeBaseResolverService
  ) {}

  async receive(message: InboundMessage): Promise<DialogueResult> {
    void this.logs.log("dialogue.receive", "Started processing inbound message", {
      metadata: {
        channel: message.channel,
        externalConversationId: message.externalConversationId,
        externalContactId: message.externalContactId,
        hasText: Boolean(message.text?.trim()),
        attachments: message.attachments.length
      }
    });

    let conversationId: string | undefined;

    try {
      const { conversation, application: originalApplication, isNew } = await this.store.getOrCreateConversation({
        externalContactId: message.externalContactId,
        externalConversationId: message.externalConversationId,
        channel: message.channel
      });
      conversationId = conversation.id;
      let application = originalApplication;
      // Web Admin may pre-create an empty conversation. A first contact is defined
      // by the absence of prior messages, not by whether the DB row already exists.
      const isFirstClientTurn = conversation.messages.length === 0;
      const voiceContext = getVoiceContext(message.attachments);
      const extractionText = [message.text?.trim(), voiceContext.transcript].filter(Boolean).join("\n").trim() || undefined;

      void this.logs.debug("dialogue.receive", "Conversation resolved", {
        conversationId,
        metadata: {
          applicationId: application.id,
          isNew,
          externalConversationId: conversation.externalConversationId,
          externalContactId: conversation.externalContactId
        }
      });

      if (!isNew) {
        void this.logs.debug("dialogue.receive", "Reusing existing conversation for follow-up message", {
          conversationId,
          metadata: {
            applicationId: application.id,
            externalConversationId: conversation.externalConversationId,
            externalContactId: conversation.externalContactId
          }
        });
      }

      const inbound = await this.store.addMessage(conversation, {
        author: "client",
        body: extractionText ?? "",
        attachmentIds: message.attachments.map((attachment) => attachment.id),
        attachments: [],
        metadata: {
          externalMessageId: message.externalMessageId,
          channel: message.channel
        }
      });

      void this.logs.debug("dialogue.receive", "Inbound message persisted", {
        conversationId,
        metadata: {
          inboundMessageId: inbound.id
        }
      });

      void this.logs.debug("dialogue.receive", "Starting extraction", {
        conversationId,
        metadata: {
          attachments: message.attachments.length
        }
      });
      const pendingFacts = application.decision?.requiredFacts ?? [];
      if (voiceContext.requiresRetry && !message.text?.trim()) {
        return await this.respondWithVoiceRetry({
          conversation,
          application,
          inboundMessageId: inbound.id
        });
      }
      const [businessRuleSettings, extraction] = await Promise.all([
        this.settings.getBusinessRuleSettings(),
        this.ai.getProvider().extract({
          text: extractionText,
          attachments: message.attachments,
          facts: application.facts,
          pendingFacts
        })
      ]);

      void this.logs.debug("dialogue.receive", "Extraction completed", {
        conversationId,
        metadata: {
          factsExtracted: extraction.facts.length,
          questionsDetected: extraction.questions.length,
          promptInjectionDetected: extraction.promptInjectionDetected
        }
      });

      const incomingFacts: Partial<ApplicationFacts> = { language: extraction.language };
      for (const fact of extraction.facts) {
        (incomingFacts as Record<string, unknown>)[fact.key] = fact.value;
      }
      if (typeof incomingFacts.vehicleYear === "number") {
        if (incomingFacts.vehicleYear > businessRuleSettings.currentYear) {
          incomingFacts.reportedInvalidVehicleYear = incomingFacts.vehicleYear;
          delete incomingFacts.vehicleYear;
        } else if (application.facts.reportedInvalidVehicleYear) {
          incomingFacts.reportedInvalidVehicleYear = null;
        }
      }
      if (!incomingFacts.phone) {
        const contactPhone = normalizePhoneLikeValue(message.externalContactId);
        if (contactPhone) {
          incomingFacts.phone = contactPhone;
        }
      }
      if (incomingFacts.residenceNeedsClarification) {
        delete incomingFacts.residenceRegion;
        delete incomingFacts.residenceCategory;
      }
      const fxResolution = await resolveForeignCurrencyFacts({
        mentions: extraction.moneyMentions,
        currentFacts: application.facts,
        incomingFacts,
        deferredIntegrations: this.deferredIntegrations
      });

      if (incomingFacts.ownerChanged || incomingFacts.plateChanged) {
        application = await this.store.createNewApplication(conversation, application.facts);
        void this.logs.debug("dialogue.receive", "Created new application after owner/plate change", {
          conversationId,
          metadata: {
            applicationId: application.id
          }
        });
      }

      const documentFacts = await this.processAttachments(conversation.id, inbound.id, message.attachments);
      const changedFactKeys = await this.store.updateFacts(application, mergeFacts(incomingFacts, fxResolution.facts, documentFacts.facts)) ?? [];
      application = (await this.store.getApplication(application.id)) ?? application;
      const decision = evaluateApplication(application.facts, businessRuleSettings);
      const recovery = buildFxRecoveryHint(application.facts, decision.requiredFacts, fxResolution.blockedRoles) ?? detectRecoveryHint({
        previousFacts: originalApplication.facts,
        currentFacts: application.facts,
        pendingFacts,
        changedFactKeys,
        currentRequiredFacts: decision.requiredFacts.map(String),
        extractionQuestions: extraction.questions.length,
        intents: extraction.intents,
        text: extractionText,
        attachments: message.attachments,
        attachmentIssueDetected: documentFacts.hasRecognitionIssue
      });

      void this.logs.debug("dialogue.receive", "Facts updated", {
        conversationId,
        metadata: {
          applicationId: application.id,
          factKeys: Object.keys(application.facts)
        }
      });

      void this.logs.debug("dialogue.receive", "Business rule settings loaded", {
        conversationId,
        metadata: {
          minimumLoan: businessRuleSettings.minimumLoan,
          latestArrivalTime: businessRuleSettings.latestArrivalTime
        }
      });

      await this.store.saveDecision(application, decision);
      application = (await this.store.getApplication(application.id)) ?? { ...application, decision, status: decision.status, stage: decision.stage };

      let managerEvent: "initial" | "delta" | null = null;
      if (decision.targetEvent && !application.facts.handedToManager) {
        const created = await this.store.createManagerNotification(application, "initial", {
          event: decision.targetEvent,
          fullName: application.facts.fullName,
          phone: application.facts.phone,
          vehicle: `${application.facts.vehicleMake ?? ""} ${application.facts.vehicleModel ?? ""}`.trim(),
          requestedAmount: application.facts.requestedAmount,
          requestedProgram: application.facts.requestedProgram,
          visitDate: application.facts.visitDate,
          visitTime: application.facts.visitTime
        });
        if (created !== false) managerEvent = "initial";
        await this.store.updateFacts(application, { handedToManager: true });
        application = (await this.store.getApplication(application.id)) ?? application;
      } else if (application.facts.handedToManager && changedFactKeys.some((key) => managerDeltaFactKeys.has(key))) {
        const created = await this.store.createManagerNotification(application, "delta", {
          changedFactKeys: changedFactKeys.filter((key) => managerDeltaFactKeys.has(key)),
          requestedAmount: application.facts.requestedAmount,
          requestedProgram: application.facts.requestedProgram,
          visitDate: application.facts.visitDate,
          visitTime: application.facts.visitTime,
          clientPaused: application.facts.clientPaused
        });
        if (created !== false) managerEvent = "delta";
      }

      void this.logs.debug("dialogue.receive", "Decision evaluated", {
        conversationId,
        metadata: {
          applicationId: application.id,
          status: decision.status,
          stage: decision.stage,
          nextAction: decision.nextAction
        }
      });

      const knowledgeAnswers = this.knowledge
        ? await this.knowledge.resolve(extraction.questions, extraction.language === "kg" ? "kg" : "ru")
        : [];
      const plan = this.responsePlan.build({
        facts: application.facts,
        decision,
        isFirstMessage: isFirstClientTurn,
        questions: extraction.questions,
        intents: extraction.intents,
        recovery,
        fxConversions: fxResolution.traces,
        previousAssistantMessages: conversation.messages.filter((item) => item.author === "ai").map((item) => item.body),
        knowledgeAnswers
      });

      void this.logs.debug("dialogue.receive", "Response plan prepared", {
        conversationId,
        metadata: {
          nextQuestions: plan.nextQuestions.length,
          requiredStatements: plan.requiredStatements.length,
          answers: plan.answers.length
        }
      });

      void this.logs.debug("dialogue.receive", "Starting response generation", {
        conversationId,
        metadata: {
          applicationId: application.id
        }
      });
      const generated = await this.ai.getProvider().generateResponse({
        userText: extractionText,
        facts: application.facts,
        decision,
        responsePlan: plan
      });

      void this.logs.debug("dialogue.receive", "Response generated", {
        conversationId,
        metadata: {
          routerAiModel: generated.model,
          promptVersion: generated.promptVersion,
          messageLength: generated.message.length
        }
      });

      const validation = this.validator.validate({ message: generated.message, decision, plan });
      await this.store.addMessage(conversation, {
        author: "ai",
        body: validation.finalMessage,
        attachmentIds: [],
        attachments: [],
        metadata: {
          sourceMessageId: inbound.id,
          routerAiModel: generated.model,
          promptVersion: generated.promptVersion,
          validation,
          trace: {
            conversationId: conversation.id,
            applicationId: application.id,
            inboundMessageIds: [inbound.id],
            detectedLanguage: extraction.language,
            intents: extraction.intents,
            questionsDetected: extraction.questions.map((question) => question.text),
            factsExtracted: extraction.facts,
            moneyMentions: extraction.moneyMentions,
            fxConversions: fxResolution.traces,
            factsChanged: changedFactKeys,
            attachments: message.attachments.map((attachment) => attachment.id),
            kbKeysUsed: plan.trace?.kbKeys ?? [],
            rulesFired: decision.rulesApplied,
            eligibilityResult: decision.status,
            nextAction: decision.nextAction,
            currentStageAfter: decision.stage,
            managerEvent,
            responseValidation: { passed: validation.passed, violations: validation.errors }
          }
        }
      });

      const refreshedConversation = (await this.store.getConversation(conversation.id)) ?? conversation;
      const refreshedApplication =
        (await this.store.getApplication(application.id)) ?? refreshedConversation.application ?? application;

      void this.logs.log("dialogue.receive", "Finished processing inbound message", {
        conversationId: refreshedConversation.id,
        metadata: {
          applicationId: refreshedApplication.id,
          stage: refreshedApplication.stage,
          status: refreshedApplication.status,
          validationPassed: validation.passed,
          routerAiModel: generated.model,
          messagesInConversation: refreshedConversation.messages.length
        }
      });

      return {
        conversation: refreshedConversation,
        application: refreshedApplication,
        reply: validation.finalMessage,
        validation: { passed: validation.passed, errors: validation.errors },
        routerAiModel: generated.model,
        promptVersion: generated.promptVersion
      };
    } catch (error) {
      await this.logs.error("dialogue.receive", "Failed to process inbound message", {
        conversationId,
        metadata: {
          channel: message.channel,
          externalConversationId: message.externalConversationId,
          externalContactId: message.externalContactId,
          errorMessage: error instanceof Error ? error.message : String(error)
        },
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  private async processAttachments(
    conversationId: string,
    messageId: string,
    attachments: InboundMessage["attachments"]
  ): Promise<{ facts: Partial<ApplicationFacts>; hasRecognitionIssue: boolean }> {
    const documents: ApplicationFacts["documents"] = {};
    const extractedFacts: Partial<ApplicationFacts> = {};
    let hasRecognitionIssue = false;
    for (const attachment of attachments) {
      if (isAudioAttachment(attachment)) {
        await this.store.addAttachment({
          conversationId,
          messageId,
          type: "voice",
          status: attachment.textContent?.trim() ? "received" : "blocked",
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          byteSize: typeof attachment.metadata?.byteSize === "number" ? attachment.metadata.byteSize : undefined,
          storageKey: typeof attachment.metadata?.storageKey === "string" ? attachment.metadata.storageKey : undefined
        });
        if (!attachment.textContent?.trim()) {
          hasRecognitionIssue = true;
        }
        continue;
      }
      const vision = await this.ai.getProvider().analyzeImage({ attachment });
      const docCode = mapVisionTypeToDocument(vision.type);
      if (docCode) {
        documents[docCode] = vision.quality === "poor" ? "poor_quality" : "received";
      }
      if (vision.quality !== "good" || vision.type === "unknown") {
        hasRecognitionIssue = true;
      }
      for (const fact of vision.extractedFacts) {
        (extractedFacts as Record<string, unknown>)[fact.key] = fact.value;
      }
      await this.store.addAttachment({
        conversationId,
        messageId,
        type: vision.type,
        status: vision.quality === "poor" ? "poor_quality" : "received",
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        byteSize: typeof attachment.metadata?.byteSize === "number" ? attachment.metadata.byteSize : undefined,
        storageKey: typeof attachment.metadata?.storageKey === "string" ? attachment.metadata.storageKey : undefined
      });
    }
    return {
      facts: mergeFacts(Object.keys(documents).length > 0 ? { documents } : {}, extractedFacts),
      hasRecognitionIssue
    };
  }

  private async respondWithVoiceRetry(input: {
    conversation: Stage1Conversation;
    application: Stage1Application;
    inboundMessageId: string;
  }): Promise<DialogueResult> {
    const reply = "Извините, не удалось полностью понять Ваше сообщение. Пожалуйста, повторите его ещё раз.";
    const validation = { passed: true, errors: [] };
    await this.store.addMessage(input.conversation, {
      author: "ai",
      body: reply,
      attachmentIds: [],
      attachments: [],
      metadata: {
        sourceMessageId: input.inboundMessageId,
        routerAiModel: "stage1-voice-retry",
        promptVersion: "stage1-voice-retry-v1",
        validation
      }
    });
    const refreshedConversation = (await this.store.getConversation(input.conversation.id)) ?? input.conversation;
    const refreshedApplication =
      (await this.store.getApplication(input.application.id)) ?? refreshedConversation.application ?? input.application;
    return {
      conversation: refreshedConversation,
      application: refreshedApplication,
      reply,
      validation,
      routerAiModel: "stage1-voice-retry",
      promptVersion: "stage1-voice-retry-v1"
    };
  }
}

const managerDeltaFactKeys = new Set<string>([
  "requestedAmount", "requestedProgram", "visitDate", "visitTime", "clientPaused",
  "residenceRegion", "residenceCategory", "guarantorAvailable", "spouseConsentReady",
  "vehicleInCredit", "vehiclePledged", "vehicleArrested", "registrationRestricted",
  "ownerCanVisit", "vehicleRegistrationRegion"
]);

function mergeFacts(...items: Partial<ApplicationFacts>[]): Partial<ApplicationFacts> {
  const merged: Partial<ApplicationFacts> = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      if (key === "documents") {
        merged.documents = { ...merged.documents, ...(value as ApplicationFacts["documents"]) };
      } else {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }
  return merged;
}

async function resolveForeignCurrencyFacts(input: {
  mentions?: MoneyMention[];
  currentFacts: ApplicationFacts;
  incomingFacts: Partial<ApplicationFacts>;
  deferredIntegrations: DeferredIntegrationsService;
}): Promise<{ facts: Partial<ApplicationFacts>; traces: FxConversionTrace[]; blockedRoles: ("requestedAmount" | "vehicleValue")[] }> {
  const facts: Partial<ApplicationFacts> = {};
  const traces: FxConversionTrace[] = [];
  const blockedRoles = new Set<"requestedAmount" | "vehicleValue">();

  for (const mention of input.mentions ?? []) {
    if (mention.roleCandidate === "unknown" || mention.currency === "KGS") continue;
    if (mention.roleCandidate === "requestedAmount" && (input.currentFacts.requestedAmount !== undefined || input.incomingFacts.requestedAmount !== undefined || facts.requestedAmount !== undefined)) continue;
    if (mention.roleCandidate === "vehicleValue" && (input.currentFacts.vehicleValue !== undefined || input.incomingFacts.vehicleValue !== undefined || facts.vehicleValue !== undefined)) continue;

    const conversion = await input.deferredIntegrations.convertToSom({
      amount: mention.normalizedAmount,
      currency: mention.currency
    });

    if (conversion.available) {
      if (mention.roleCandidate === "requestedAmount") {
        facts.requestedAmount = conversion.value;
      } else {
        facts.vehicleValue = conversion.value;
      }
      traces.push({
        role: mention.roleCandidate,
        sourceText: mention.sourceText,
        currency: mention.currency,
        amount: mention.normalizedAmount,
        somValue: conversion.value,
        status: "converted",
        source: conversion.source,
        sourceUrl: conversion.sourceUrl,
        effectiveDate: conversion.effectiveDate
      });
    } else {
      blockedRoles.add(mention.roleCandidate);
      traces.push({
        role: mention.roleCandidate,
        sourceText: mention.sourceText,
        currency: mention.currency,
        amount: mention.normalizedAmount,
        status: "blocked",
        code: conversion.code
      });
    }
  }

  return { facts, traces, blockedRoles: [...blockedRoles] };
}

export function detectRecoveryHint(input: {
  previousFacts: ApplicationFacts;
  currentFacts: ApplicationFacts;
  pendingFacts: (keyof ApplicationFacts | DocumentCode)[];
  changedFactKeys: string[];
  currentRequiredFacts: string[];
  extractionQuestions: number;
  intents: string[];
  text?: string;
  attachments: InboundMessage["attachments"];
  attachmentIssueDetected: boolean;
}): RecoveryHint | undefined {
  if (input.pendingFacts.length === 0) return undefined;
  if (input.extractionQuestions > 0) return undefined;
  if (input.intents.some((intent) => intent === "limit_objection" || intent === "clarification_request")) return undefined;
  if (!input.text?.trim() && input.attachments.length === 0) return undefined;

  const unresolvedFacts = input.pendingFacts.filter((fact) => !isFactSatisfied(input.currentFacts, fact)).map(String);
  if (unresolvedFacts.length === 0) return undefined;
  if (!sameFactSet(unresolvedFacts, input.currentRequiredFacts)) return undefined;

  const anyPendingResolved = input.pendingFacts.some((fact) =>
    isFactSatisfied(input.currentFacts, fact) && !isFactSatisfied(input.previousFacts, fact)
  );
  if (anyPendingResolved) return undefined;

  if (input.attachments.length > 0 && input.attachmentIssueDetected) {
    return { unresolvedFacts, reason: "attachment_issue" };
  }

  if (unresolvedFacts.every((fact) => isDocumentCode(fact as keyof ApplicationFacts | DocumentCode))) {
    return undefined;
  }

  if (input.changedFactKeys.length === 0 || unresolvedFacts.length === input.pendingFacts.length) {
    return { unresolvedFacts, reason: "unrecognized_reply" };
  }

  return undefined;
}

function sameFactSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  if (leftSet.size !== right.length) return false;
  return right.every((item) => leftSet.has(item));
}

function buildFxRecoveryHint(
  facts: ApplicationFacts,
  requiredFacts: (keyof ApplicationFacts | DocumentCode)[],
  blockedRoles: ("requestedAmount" | "vehicleValue")[]
): RecoveryHint | undefined {
  const unresolvedFacts = blockedRoles.filter((role) => requiredFacts.includes(role) && !isFactSatisfied(facts, role));
  if (unresolvedFacts.length === 0) return undefined;
  return { unresolvedFacts, reason: "fx_unavailable" };
}

function isFactSatisfied(facts: ApplicationFacts, fact: keyof ApplicationFacts | DocumentCode): boolean {
  if (isDocumentCode(fact)) {
    return facts.documents?.[fact] === "received";
  }
  if (fact === "residenceRegion") {
    return Boolean(facts.residenceRegion) && facts.residenceNeedsClarification !== true;
  }
  const value = facts[fact];
  return value !== undefined && value !== null && value !== "";
}

function isDocumentCode(value: keyof ApplicationFacts | DocumentCode): value is DocumentCode {
  return value === "id_front" || value === "id_back" || value === "vehicle_registration_front" || value === "vehicle_registration_back" || value === "car_photo" || value === "unknown";
}

function mapVisionTypeToDocument(type: string): DocumentCode | undefined {
  if (type === "id_front" || type === "id_back" || type === "vehicle_registration_front" || type === "vehicle_registration_back") {
    return type;
  }
  if (type === "car") {
    return "car_photo";
  }
  if (type === "unknown" || type === "poor_quality") {
    return "unknown";
  }
  return undefined;
}

function normalizePhoneLikeValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("996")) return `+${digits}`;
  if (digits.length === 10 && digits.startsWith("0")) return `+996${digits.slice(1)}`;
  return undefined;
}

function isAudioAttachment(attachment: InboundMessage["attachments"][number]): boolean {
  return String(attachment.mimeType ?? "").toLowerCase().startsWith("audio/");
}

function getVoiceContext(attachments: InboundMessage["attachments"]): { transcript?: string; requiresRetry: boolean } {
  const audioAttachments = attachments.filter(isAudioAttachment);
  const transcript = audioAttachments
    .map((attachment) => attachment.textContent?.trim())
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .trim();
  return {
    transcript: transcript || undefined,
    requiresRetry: audioAttachments.length > 0 && !transcript
  };
}
