import { Injectable } from "@nestjs/common";
import type { ApplicationFacts, DocumentCode } from "@ailyn/business-rules";
import { evaluateApplication } from "@ailyn/business-rules";
import { AiService } from "../ai/ai.service.js";
import type { InboundMessage } from "../channels/channel.interface.js";
import { ResponsePlanService } from "./response-plan.service.js";
import { ResponseValidatorService } from "./response-validator.service.js";
import { Stage1StoreService, type Stage1Application, type Stage1Conversation } from "./stage1-store.service.js";
import { SettingsService } from "../settings/settings.service.js";

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
    private readonly settings: SettingsService
  ) {}

  async receive(message: InboundMessage): Promise<DialogueResult> {
    const { conversation, application: originalApplication, isNew } = await this.store.getOrCreateConversation({
      externalContactId: message.externalContactId,
      externalConversationId: message.externalConversationId,
      channel: message.channel
    });
    let application = originalApplication;

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

    const extraction = await this.ai.getProvider().extract({
      text: message.text,
      attachments: message.attachments,
      facts: application.facts
    });

    const incomingFacts: Partial<ApplicationFacts> = {};
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
    }

    const documentFacts = await this.processAttachments(conversation.id, inbound.id, message.attachments);
    await this.store.updateFacts(application, mergeFacts(incomingFacts, documentFacts));
    application = (await this.store.getApplication(application.id)) ?? application;

    const decision = evaluateApplication(application.facts, await this.settings.getBusinessRuleSettings());
    await this.store.saveDecision(application, decision);
    application = (await this.store.getApplication(application.id)) ?? { ...application, decision, status: decision.status, stage: decision.stage };

    const plan = this.responsePlan.build({
      facts: application.facts,
      decision,
      isFirstMessage: isNew,
      questions: extraction.questions
    });
    const generated = await this.ai.getProvider().generateResponse({
      userText: message.text,
      facts: application.facts,
      decision,
      responsePlan: plan
    });
    const validation = this.validator.validate({ message: generated.message, decision });
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

    return {
      conversation,
      application,
      reply: validation.finalMessage,
      validation: { passed: validation.passed, errors: validation.errors },
      routerAiModel: generated.model,
      promptVersion: generated.promptVersion
    };
  }

  private async processAttachments(
    conversationId: string,
    messageId: string,
    attachments: InboundMessage["attachments"]
  ): Promise<Partial<ApplicationFacts>> {
    const documents: ApplicationFacts["documents"] = {};
    for (const attachment of attachments) {
      const vision = await this.ai.getProvider().analyzeImage({ attachment });
      const docCode = mapVisionTypeToDocument(vision.type);
      if (docCode) {
        documents[docCode] = vision.quality === "poor" ? "poor_quality" : "received";
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
    return Object.keys(documents).length > 0 ? { documents } : {};
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
