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
    private readonly knowledge?: KnowledgeBaseResolverService
  ) {}

  async receive(message: InboundMessage): Promise<DialogueResult> {
    await this.logs.log("dialogue.receive", "Started processing inbound message", {
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

      await this.logs.debug("dialogue.receive", "Conversation resolved", {
        conversationId,
        metadata: {
          applicationId: application.id,
          isNew,
          externalConversationId: conversation.externalConversationId,
          externalContactId: conversation.externalContactId
        }
      });

      if (!isNew) {
        await this.logs.debug("dialogue.receive", "Reusing existing conversation for follow-up message", {
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
        body: message.text ?? "",
        attachmentIds: message.attachments.map((attachment) => attachment.id),
        attachments: [],
        metadata: {
          externalMessageId: message.externalMessageId,
          channel: message.channel
        }
      });

      await this.logs.debug("dialogue.receive", "Inbound message persisted", {
        conversationId,
        metadata: {
          inboundMessageId: inbound.id
        }
      });

      await this.logs.debug("dialogue.receive", "Starting extraction", {
        conversationId,
        metadata: {
          attachments: message.attachments.length
        }
      });
      const extraction = await this.ai.getProvider().extract({
        text: message.text,
        attachments: message.attachments,
        facts: application.facts
      });

      await this.logs.debug("dialogue.receive", "Extraction completed", {
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
      const text = (message.text ?? "").toLowerCase();
      if (text.includes("сменился собственник") || text.includes("другой собственник")) {
        incomingFacts.ownerChanged = true;
      }
      if (text.includes("сменился номер") || text.includes("другой госномер") || text.includes("новый госномер")) {
        incomingFacts.plateChanged = true;
      }

      if (incomingFacts.ownerChanged || incomingFacts.plateChanged) {
        application = await this.store.createNewApplication(conversation, application.facts);
        await this.logs.debug("dialogue.receive", "Created new application after owner/plate change", {
          conversationId,
          metadata: {
            applicationId: application.id
          }
        });
      }

      const documentFacts = await this.processAttachments(conversation.id, inbound.id, message.attachments);
      await this.store.updateFacts(application, mergeFacts(incomingFacts, documentFacts));
      application = (await this.store.getApplication(application.id)) ?? application;

      await this.logs.debug("dialogue.receive", "Facts updated", {
        conversationId,
        metadata: {
          applicationId: application.id,
          factKeys: Object.keys(application.facts)
        }
      });

      const businessRuleSettings = await this.settings.getBusinessRuleSettings();
      await this.logs.debug("dialogue.receive", "Business rule settings loaded", {
        conversationId,
        metadata: {
          minimumLoan: businessRuleSettings.minimumLoan,
          latestArrivalTime: businessRuleSettings.latestArrivalTime
        }
      });

      const decision = evaluateApplication(application.facts, businessRuleSettings);
      await this.store.saveDecision(application, decision);
      application = (await this.store.getApplication(application.id)) ?? { ...application, decision, status: decision.status, stage: decision.stage };

      if (decision.targetEvent) {
        await this.store.createManagerNotification(application, application.facts.handedToManager ? "delta" : "initial", {
          event: decision.targetEvent,
          fullName: application.facts.fullName,
          phone: application.facts.phone,
          vehicle: `${application.facts.vehicleMake ?? ""} ${application.facts.vehicleModel ?? ""}`.trim(),
          requestedAmount: application.facts.requestedAmount,
          requestedProgram: application.facts.requestedProgram,
          visitDate: application.facts.visitDate,
          visitTime: application.facts.visitTime
        });
        await this.store.updateFacts(application, { handedToManager: true });
      }

      await this.logs.debug("dialogue.receive", "Decision evaluated", {
        conversationId,
        metadata: {
          applicationId: application.id,
          status: decision.status,
          stage: decision.stage,
          nextAction: decision.nextAction
        }
      });

      const plan = this.responsePlan.build({
        facts: application.facts,
        decision,
        isFirstMessage: isNew,
        questions: extraction.questions,
        knowledgeAnswers: this.knowledge ? await this.knowledge.resolve(extraction.questions, extraction.language === "kg" ? "kg" : "ru") : []
      });

      await this.logs.debug("dialogue.receive", "Response plan prepared", {
        conversationId,
        metadata: {
          nextQuestions: plan.nextQuestions.length,
          requiredStatements: plan.requiredStatements.length,
          answers: plan.answers.length
        }
      });

      await this.logs.debug("dialogue.receive", "Starting response generation", {
        conversationId,
        metadata: {
          applicationId: application.id
        }
      });
      const generated = await this.ai.getProvider().generateResponse({
        userText: message.text,
        facts: application.facts,
        decision,
        responsePlan: plan
      });

      await this.logs.debug("dialogue.receive", "Response generated", {
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
          validation
        }
      });

      const refreshedConversation = (await this.store.getConversation(conversation.id)) ?? conversation;
      const refreshedApplication =
        (await this.store.getApplication(application.id)) ?? refreshedConversation.application ?? application;

      await this.logs.log("dialogue.receive", "Finished processing inbound message", {
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
  ): Promise<Partial<ApplicationFacts>> {
    const documents: ApplicationFacts["documents"] = {};
    const extractedFacts: Partial<ApplicationFacts> = {};
    for (const attachment of attachments) {
      const vision = await this.ai.getProvider().analyzeImage({ attachment });
      const docCode = mapVisionTypeToDocument(vision.type);
      if (docCode) {
        documents[docCode] = vision.quality === "poor" ? "poor_quality" : "received";
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
    return mergeFacts(Object.keys(documents).length > 0 ? { documents } : {}, extractedFacts);
  }
}

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
