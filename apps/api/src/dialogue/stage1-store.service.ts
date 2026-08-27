import { Injectable } from "@nestjs/common";
import type { ApplicationFacts, ApplicationStage, DecisionResult } from "@ailyn/business-rules";

export interface Stage1Message {
  id: string;
  author: "client" | "ai" | "system";
  body: string;
  attachmentIds: string[];
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface Stage1Attachment {
  id: string;
  conversationId: string;
  type: string;
  status: string;
  fileName?: string;
  createdAt: string;
}

export interface Stage1Application {
  id: string;
  conversationId: string;
  contactId: string;
  status: DecisionResult["status"];
  stage: ApplicationStage;
  facts: ApplicationFacts;
  factHistory: { key: string; previousValue: unknown; newValue: unknown; changedAt: string }[];
  decision?: DecisionResult;
  createdAt: string;
  updatedAt: string;
}

export interface Stage1Conversation {
  id: string;
  contactId: string;
  externalContactId: string;
  channel: "web-test" | "wazzup";
  messages: Stage1Message[];
  applicationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

@Injectable()
export class Stage1StoreService {
  private readonly conversations = new Map<string, Stage1Conversation>();
  private readonly applications = new Map<string, Stage1Application>();
  private readonly attachments = new Map<string, Stage1Attachment>();
  private readonly audit: AuditEntry[] = [];

  listConversations(): Stage1Conversation[] {
    return [...this.conversations.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  listApplications(): Stage1Application[] {
    return [...this.applications.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  listMessages(): Stage1Message[] {
    return this.listConversations().flatMap((conversation) =>
      conversation.messages.map((message) => ({ ...message, metadata: { ...message.metadata, conversationId: conversation.id } }))
    );
  }

  listFacts(): { applicationId: string; key: string; value: unknown }[] {
    return this.listApplications().flatMap((application) =>
      Object.entries(application.facts).map(([key, value]) => ({ applicationId: application.id, key, value }))
    );
  }

  listAttachments(): Stage1Attachment[] {
    return [...this.attachments.values()];
  }

  listAudit(): AuditEntry[] {
    return [...this.audit].reverse();
  }

  getConversation(id: string): Stage1Conversation | undefined {
    return this.conversations.get(id);
  }

  getApplication(id: string): Stage1Application | undefined {
    return this.applications.get(id);
  }

  getOrCreateConversation(input: {
    externalContactId: string;
    externalConversationId?: string;
    channel: "web-test" | "wazzup";
  }): { conversation: Stage1Conversation; application: Stage1Application; isNew: boolean } {
    const id = input.externalConversationId || `conv-${input.externalContactId}`;
    const existing = this.conversations.get(id);
    if (existing) {
      const application = this.applications.get(existing.applicationId);
      if (!application) {
        throw new Error(`Application ${existing.applicationId} is missing for conversation ${id}`);
      }
      return { conversation: existing, application, isNew: false };
    }

    const now = new Date().toISOString();
    const applicationId = `app-${crypto.randomUUID()}`;
    const conversation: Stage1Conversation = {
      id,
      contactId: `contact-${input.externalContactId}`,
      externalContactId: input.externalContactId,
      channel: input.channel,
      messages: [],
      applicationId,
      createdAt: now,
      updatedAt: now
    };
    const application: Stage1Application = {
      id: applicationId,
      conversationId: conversation.id,
      contactId: conversation.contactId,
      status: "need_more_data",
      stage: "NEW",
      facts: {},
      factHistory: [],
      createdAt: now,
      updatedAt: now
    };
    this.conversations.set(conversation.id, conversation);
    this.applications.set(application.id, application);
    this.recordAudit("conversation.created", "Conversation", conversation.id);
    this.recordAudit("application.created", "Application", application.id);
    return { conversation, application, isNew: true };
  }

  createNewApplication(conversation: Stage1Conversation, previousFacts: ApplicationFacts): Stage1Application {
    const now = new Date().toISOString();
    const application: Stage1Application = {
      id: `app-${crypto.randomUUID()}`,
      conversationId: conversation.id,
      contactId: conversation.contactId,
      status: "need_more_data",
      stage: "NEW",
      facts: {
        fullName: previousFacts.fullName,
        phone: previousFacts.phone,
        language: previousFacts.language
      },
      factHistory: [],
      createdAt: now,
      updatedAt: now
    };
    conversation.applicationId = application.id;
    conversation.updatedAt = now;
    this.applications.set(application.id, application);
    this.recordAudit("application.created_after_owner_or_plate_change", "Application", application.id);
    return application;
  }

  addMessage(conversation: Stage1Conversation, message: Omit<Stage1Message, "id" | "createdAt">): Stage1Message {
    const now = new Date().toISOString();
    const saved: Stage1Message = {
      id: `msg-${crypto.randomUUID()}`,
      createdAt: now,
      ...message
    };
    conversation.messages.push(saved);
    conversation.updatedAt = now;
    this.recordAudit("message.created", "Message", saved.id);
    return saved;
  }

  addAttachment(attachment: Omit<Stage1Attachment, "id" | "createdAt">): Stage1Attachment {
    const saved: Stage1Attachment = {
      id: `att-${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      ...attachment
    };
    this.attachments.set(saved.id, saved);
    this.recordAudit("attachment.created", "Attachment", saved.id, { type: saved.type });
    return saved;
  }

  updateFacts(application: Stage1Application, incoming: Partial<ApplicationFacts>): void {
    const now = new Date().toISOString();
    for (const [key, newValue] of Object.entries(incoming)) {
      if (newValue === undefined) continue;
      const previousValue = application.facts[key as keyof ApplicationFacts];
      if (JSON.stringify(previousValue) === JSON.stringify(newValue)) continue;
      application.factHistory.push({ key, previousValue, newValue, changedAt: now });
      (application.facts as Record<string, unknown>)[key] = newValue;
      this.recordAudit("fact.updated", "Application", application.id, { key, previousValue, newValue });
    }
    application.updatedAt = now;
  }

  saveDecision(application: Stage1Application, decision: DecisionResult): void {
    application.decision = decision;
    application.status = decision.status;
    application.stage = decision.stage;
    application.updatedAt = new Date().toISOString();
    this.recordAudit("decision.created", "Application", application.id, {
      status: decision.status,
      stage: decision.stage,
      rulesApplied: decision.rulesApplied
    });
  }

  reset(): void {
    this.conversations.clear();
    this.applications.clear();
    this.attachments.clear();
    this.audit.length = 0;
  }

  private recordAudit(action: string, entityType: string, entityId?: string, metadata?: Record<string, unknown>): void {
    this.audit.push({
      id: `audit-${crypto.randomUUID()}`,
      action,
      entityType,
      entityId,
      metadata,
      createdAt: new Date().toISOString()
    });
  }
}
