import { Injectable } from "@nestjs/common";
import type { ApplicationFacts, ApplicationStage, DecisionResult } from "@ailyn/business-rules";
import type { ApplicationState, MessageAuthor, MessageChannel, Prisma } from "@prisma/client";
import { PrismaService } from "../database/prisma.service.js";

export interface Stage1Attachment {
  id: string;
  messageId?: string;
  conversationId: string;
  type: string;
  status: string;
  fileName?: string;
  mimeType?: string;
  byteSize?: number;
  storageKey?: string;
  createdAt: string;
}

export interface Stage1Message {
  id: string;
  author: "client" | "ai" | "system" | "manager";
  body: string;
  attachmentIds: string[];
  attachments: Stage1Attachment[];
  createdAt: string;
  metadata?: Record<string, unknown>;
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
  agentState?: { nextAction: string; cardSummary: string; intent: string; preliminaryLimit?: number | null };
  /** Private post-booking summary. It is intentionally not part of facts. */
  dialogueSummary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Stage1Conversation {
  id: string;
  contactId: string;
  externalContactId: string;
  externalConversationId: string;
  channel: "web-test" | "wazzup";
  messages: Stage1Message[];
  applicationId: string;
  application?: Stage1Application;
  createdAt: string;
  updatedAt: string;
  status: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

type ConversationWithRelations = Awaited<ReturnType<Stage1StoreService["loadConversation"]>>;
type ApplicationWithRelations = NonNullable<Awaited<ReturnType<Stage1StoreService["loadApplication"]>>>;

@Injectable()
export class Stage1StoreService {
  constructor(private readonly prisma: PrismaService) {}

  async listConversations(): Promise<Stage1Conversation[]> {
    const conversations = await this.prisma.conversation.findMany({
      orderBy: { updatedAt: "desc" },
      include: conversationInclude()
    });
    return conversations.map((conversation) => this.mapConversation(conversation));
  }

  async listApplications(): Promise<Stage1Application[]> {
    const applications = await this.prisma.application.findMany({
      orderBy: { updatedAt: "desc" },
      include: applicationInclude()
    });
    return applications.map((application) => this.mapApplication(application));
  }

  async listMessages(): Promise<Stage1Message[]> {
    const messages = await this.prisma.message.findMany({
      orderBy: { createdAt: "asc" },
      include: { attachments: true, conversation: true }
    });
    return messages.map((message) => ({
      id: message.id,
      author: message.author,
      body: message.body,
      attachmentIds: message.attachments.map((attachment) => attachment.id),
      attachments: message.attachments.map((attachment) => this.mapAttachment(attachment)),
      createdAt: message.createdAt.toISOString(),
      metadata: {
        ...asRecord(message.metadata),
        conversationId: message.conversationId,
        externalConversationId: message.conversation.externalConversationId
      }
    }));
  }

  async listFacts(): Promise<{ applicationId: string; key: string; value: unknown }[]> {
    const facts = await this.prisma.applicationFact.findMany({
      where: { supersededAt: null },
      orderBy: { updatedAt: "desc" }
    });
    return facts.map((fact) => ({ applicationId: fact.applicationId ?? "", key: fact.key, value: fact.value }));
  }

  async listAttachments(): Promise<Stage1Attachment[]> {
    const attachments = await this.prisma.attachment.findMany({
      orderBy: { createdAt: "desc" },
      include: { message: true }
    });
    return attachments.map((attachment) => this.mapAttachment(attachment));
  }

  async listAudit(): Promise<AuditEntry[]> {
    const audit = await this.prisma.auditEvent.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
    return audit.map((event) => ({
      id: event.id,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId ?? undefined,
      metadata: asRecord(event.metadata),
      createdAt: event.createdAt.toISOString()
    }));
  }

  async getConversation(id: string): Promise<Stage1Conversation | undefined> {
    const conversation = await this.loadConversation(id);
    return conversation ? this.mapConversation(conversation) : undefined;
  }

  async getConversationByIdForChannel(id: string, channel: "web-test" | "wazzup"): Promise<Stage1Conversation | undefined> {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id,
        channel: toPrismaChannel(channel)
      },
      include: conversationInclude()
    });
    return conversation ? this.mapConversation(conversation) : undefined;
  }

  async getApplication(id: string): Promise<Stage1Application | undefined> {
    const application = await this.loadApplication(id);
    return application ? this.mapApplication(application) : undefined;
  }

  async createWebTestConversation(input?: { externalContactId?: string; externalConversationId?: string }): Promise<Stage1Conversation> {
    return this.createConversation({
      channel: "web-test",
      externalContactId: input?.externalContactId || `web-client-${crypto.randomUUID()}`,
      externalConversationId: input?.externalConversationId || `web-conversation-${crypto.randomUUID()}`
    });
  }

  private async createConversation(input: {
    channel: "web-test" | "wazzup";
    externalContactId: string;
    externalConversationId: string;
  }): Promise<Stage1Conversation> {
    const contact = await this.prisma.contact.create({
      data: {
        externalContactId: input.externalContactId,
        metadata: toJson({ source: toPrismaChannel(input.channel) })
      }
    });
    const conversation = await this.prisma.conversation.create({
      data: {
        contactId: contact.id,
        channel: toPrismaChannel(input.channel),
        externalConversationId: input.externalConversationId,
        metadata: toJson({ source: toPrismaChannel(input.channel) }),
        applications: {
          create: {
            contactId: contact.id,
            state: "NEW",
            metadata: toJson({ status: "need_more_data" })
          }
        }
      },
      include: conversationInclude()
    });
    await this.recordAudit("conversation.created", "Conversation", conversation.id, { externalConversationId: input.externalConversationId });
    return this.mapConversation(conversation);
  }

  async getOrCreateConversation(input: {
    externalContactId: string;
    externalConversationId?: string;
    channel: "web-test" | "wazzup";
  }): Promise<{ conversation: Stage1Conversation; application: Stage1Application; isNew: boolean }> {
    const externalConversationId = input.externalConversationId || `conv-${input.externalContactId}`;
    const channel = toPrismaChannel(input.channel);
    const existing = await this.prisma.conversation.findFirst({
      where: { channel, externalConversationId },
      include: conversationInclude()
    });
    if (existing) {
      const mapped = this.mapConversation(existing);
      const application = mapped.application;
      if (!application) {
        throw new Error(`Application is missing for conversation ${mapped.id}`);
      }
      return { conversation: mapped, application, isNew: false };
    }

    const conversation = await this.createConversation({
      channel: input.channel,
      externalContactId: input.externalContactId,
      externalConversationId
    });
    const application = conversation.application;
    if (!application) {
      throw new Error(`Application is missing for conversation ${conversation.id}`);
    }
    return { conversation, application, isNew: true };
  }

  async createNewApplication(conversation: Stage1Conversation, previousFacts: ApplicationFacts): Promise<Stage1Application> {
    const saved = await this.prisma.application.create({
      data: {
        contactId: conversation.contactId,
        conversationId: conversation.id,
        state: "NEW",
        metadata: { status: "need_more_data" }
      },
      include: applicationInclude()
    });
    await this.updateFacts(this.mapApplication(saved), {
      fullName: previousFacts.fullName,
      phone: previousFacts.phone,
      language: previousFacts.language
    });
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() }
    });
    await this.recordAudit("application.created_after_owner_or_plate_change", "Application", saved.id);
    const reloaded = await this.loadApplication(saved.id);
    return this.mapApplication(reloaded ?? saved);
  }

  async addMessage(conversation: Stage1Conversation, message: Omit<Stage1Message, "id" | "createdAt">): Promise<Stage1Message> {
    const saved = await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        author: message.author as MessageAuthor,
        channel: toPrismaChannel(conversation.channel),
        body: message.body,
        idempotencyKey: `msg-${crypto.randomUUID()}`,
        metadata: toJson(message.metadata ?? {})
      }
    });
    await this.recordAudit("message.created", "Message", saved.id, message.metadata);
    return {
      id: saved.id,
      author: saved.author,
      body: saved.body,
      attachmentIds: message.attachmentIds,
      attachments: message.attachments,
      createdAt: saved.createdAt.toISOString(),
      metadata: asRecord(saved.metadata)
    };
  }

  async addAttachment(attachment: Omit<Stage1Attachment, "id" | "createdAt"> & { messageId?: string }): Promise<Stage1Attachment> {
    const saved = await this.prisma.attachment.create({
      data: {
        messageId: attachment.messageId,
        storageKey: attachment.storageKey ?? attachment.fileName ?? `web-test/${crypto.randomUUID()}`,
        mimeType: attachment.mimeType ?? "application/octet-stream",
        byteSize: attachment.byteSize,
        metadata: toJson({
          conversationId: attachment.conversationId,
          type: attachment.type,
          status: attachment.status,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          byteSize: attachment.byteSize
        })
      }
    });
    await this.recordAudit("attachment.created", "Attachment", saved.id, { type: attachment.type, status: attachment.status });
    return {
      id: saved.id,
      messageId: saved.messageId ?? undefined,
      conversationId: attachment.conversationId,
      type: attachment.type,
      status: attachment.status,
      fileName: attachment.fileName,
      mimeType: saved.mimeType ?? undefined,
      byteSize: saved.byteSize ?? undefined,
      storageKey: saved.storageKey,
      createdAt: saved.createdAt.toISOString()
    };
  }

  async updateFacts(application: Stage1Application, incoming: Partial<ApplicationFacts>): Promise<string[]> {
    const changedKeys: string[] = [];
    for (const [key, newValue] of Object.entries(incoming)) {
      if (newValue === undefined) continue;
      const current = await this.prisma.applicationFact.findFirst({
        where: { applicationId: application.id, key, supersededAt: null },
        orderBy: { updatedAt: "desc" }
      });
      const previousValue = current?.value ?? undefined;
      if (JSON.stringify(previousValue) === JSON.stringify(newValue)) continue;

      if (current) {
        await this.prisma.applicationFact.update({
          where: { id: current.id },
          data: { supersededAt: new Date() }
        });
      }
      await this.prisma.applicationFact.create({
        data: {
          applicationId: application.id,
          contactId: application.contactId,
          key,
          value: toJson(newValue),
          previousValue: previousValue === undefined ? undefined : toJson(previousValue),
          source: "web_test"
        }
      });
      await this.prisma.factHistory.create({
        data: {
          applicationId: application.id,
          key,
          previousValue: previousValue === undefined ? undefined : toJson(previousValue),
          newValue: toJson(newValue),
          source: "web_test"
        }
      });
      await this.recordAudit("fact.updated", "Application", application.id, { key, previousValue, newValue });
      changedKeys.push(key);
    }
    await this.prisma.application.update({ where: { id: application.id }, data: { updatedAt: new Date() } });
    return changedKeys;
  }

  async saveDecision(application: Stage1Application, decision: DecisionResult): Promise<void> {
    await this.prisma.application.update({
      where: { id: application.id },
      data: {
        state: decision.stage as ApplicationState,
        metadata: toJson({
          status: decision.status,
          decision
        })
      }
    });
    await this.recordAudit("decision.created", "Application", application.id, {
      status: decision.status,
      stage: decision.stage,
      rulesApplied: decision.rulesApplied
    });
  }

  async saveAgentState(application: Stage1Application, state: { stage: ApplicationStage; status: DecisionResult["status"]; nextAction: string; cardSummary: string; intent: string; preliminaryLimit?: number | null }): Promise<void> {
    const current = await this.prisma.application.findUnique({ where: { id: application.id }, select: { metadata: true } });
    const metadata = asRecord(current?.metadata);
    const previousAgentState = asRecord(metadata.agentState);
    // A limit is calculated at the programme stage. Later steps (documents,
    // family, visit) do not recalculate it, so an omitted/null field from the
    // model must not erase the confirmed value from the application state.
    const preliminaryLimit = state.preliminaryLimit ?? (typeof previousAgentState.preliminaryLimit === "number" ? previousAgentState.preliminaryLimit : undefined);
    const agentState = { ...state, ...(preliminaryLimit === undefined ? {} : { preliminaryLimit }) };
    await this.prisma.application.update({
      where: { id: application.id },
      data: { state: state.stage as ApplicationState, metadata: toJson({ ...metadata, status: state.status, agentState }) }
    });
    await this.recordAudit("agent.state.updated", "Application", application.id, { status: state.status, stage: state.stage, nextAction: state.nextAction, intent: state.intent });
  }

  /** Atomically reserves the one allowed post-booking summary generation. */
  async claimDialogueSummaryGeneration(applicationId: string): Promise<boolean> {
    const updated = await this.prisma.application.updateMany({
      where: { id: applicationId, dialogueSummaryRequestedAt: null },
      data: { dialogueSummaryRequestedAt: new Date() }
    });
    return updated.count === 1;
  }

  async saveDialogueSummary(applicationId: string, summary: string): Promise<void> {
    await this.prisma.application.update({
      where: { id: applicationId },
      data: { dialogueSummary: summary, dialogueSummaryGeneratedAt: new Date() }
    });
    await this.recordAudit("application.dialogue_summary.generated", "Application", applicationId);
  }

  /** Allow a later turn to retry if the one-time summary model call failed. */
  async releaseDialogueSummaryGeneration(applicationId: string): Promise<void> {
    await this.prisma.application.updateMany({
      where: { id: applicationId, dialogueSummary: null },
      data: { dialogueSummaryRequestedAt: null }
    });
  }

  async createManagerNotification(application: Stage1Application, kind: "initial" | "delta", payload: Record<string, unknown>): Promise<boolean> {
    const idempotencyKey = kind === "initial"
      ? `manager-${application.id}-initial`
      : `manager-${application.id}-delta-${stablePayloadKey(payload)}`;
    const existing = await this.prisma.managerNotification.findUnique({ where: { idempotencyKey } });
    if (existing) return false;
    await this.prisma.managerNotification.create({
      data: { applicationId: application.id, channel: "deferred", status: "blocked", idempotencyKey, payload: toJson({ kind, ...payload, delivery: "SPEC_GAP_MANAGER_DELIVERY" }) }
    });
    await this.recordAudit("manager_notification.created", "Application", application.id, { kind, delivery: "SPEC_GAP_MANAGER_DELIVERY" });
    return true;
  }

  async scheduleReminder(application: Stage1Application, dueAt: Date, sequence: number): Promise<void> {
    const idempotencyKey = `reminder-${application.id}-${sequence}`;
    await this.prisma.reminder.upsert({
      where: { idempotencyKey },
      create: { applicationId: application.id, dueAt, status: "blocked", idempotencyKey, payload: toJson({ sequence, code: "SPEC_CONFLICT_C2" }) },
      update: {}
    });
    await this.recordAudit("reminder.scheduled", "Application", application.id, { sequence, code: "SPEC_CONFLICT_C2" });
  }

  async reset(): Promise<void> {
    await this.prisma.auditEvent.deleteMany();
    await this.prisma.attachment.deleteMany();
    await this.prisma.message.deleteMany();
    await this.prisma.factHistory.deleteMany();
    await this.prisma.applicationFact.deleteMany();
    await this.prisma.application.deleteMany();
    await this.prisma.conversation.deleteMany();
    await this.prisma.contact.deleteMany();
  }

  async recordAudit(action: string, entityType: string, entityId?: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actor: "admin",
        action,
        entityType,
        entityId,
        idempotencyKey: `audit-${crypto.randomUUID()}`,
        metadata: toJson(metadata ?? {})
      }
    });
  }

  private async loadConversation(id: string) {
    return this.prisma.conversation.findUnique({
      where: { id },
      include: conversationInclude()
    });
  }

  private async loadApplication(id: string) {
    return this.prisma.application.findUnique({
      where: { id },
      include: applicationInclude()
    });
  }

  private mapConversation(conversation: NonNullable<ConversationWithRelations>): Stage1Conversation {
    const latestApplication = [...conversation.applications].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    const application = latestApplication ? this.mapApplication(latestApplication) : undefined;
    return {
      id: conversation.id,
      contactId: conversation.contactId ?? "",
      externalContactId: conversation.contact?.externalContactId ?? "",
      externalConversationId: conversation.externalConversationId ?? "",
      channel: fromPrismaChannel(conversation.channel),
      status: conversation.status,
      messages: conversation.messages.map((message) => ({
        id: message.id,
        author: message.author,
        body: message.body,
        attachmentIds: message.attachments.map((attachment) => attachment.id),
        attachments: message.attachments.map((attachment) => this.mapAttachment(attachment)),
        createdAt: message.createdAt.toISOString(),
        metadata: asRecord(message.metadata)
      })),
      applicationId: application?.id ?? "",
      application,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString()
    };
  }

  private mapApplication(application: ApplicationWithRelations): Stage1Application {
    const metadata = asRecord(application.metadata);
    return {
      id: application.id,
      conversationId: application.conversationId ?? "",
      contactId: application.contactId ?? "",
      status: (metadata.status as DecisionResult["status"]) ?? "need_more_data",
      stage: application.state as ApplicationStage,
      facts: factsFromRows(application.facts),
      factHistory: application.factHistory.map((fact) => ({
        key: fact.key,
        previousValue: fact.previousValue,
        newValue: fact.newValue,
        changedAt: fact.createdAt.toISOString()
      })),
      decision: metadata.decision as DecisionResult | undefined,
      agentState: metadata.agentState as Stage1Application["agentState"],
      dialogueSummary: application.dialogueSummary ?? undefined,
      createdAt: application.createdAt.toISOString(),
      updatedAt: application.updatedAt.toISOString()
    };
  }

  private mapAttachment(
    attachment: {
      id: string;
      messageId: string | null;
      storageKey: string;
      mimeType: string | null;
      byteSize: number | null;
      metadata: unknown;
      createdAt: Date;
      message?: { conversationId: string } | null;
    }
  ): Stage1Attachment {
    const metadata = asRecord(attachment.metadata);
    return {
      id: attachment.id,
      messageId: attachment.messageId ?? undefined,
      conversationId: attachment.message?.conversationId ?? String(metadata.conversationId ?? ""),
      type: String(metadata.type ?? "unknown"),
      status: String(metadata.status ?? "received"),
      fileName: typeof metadata.fileName === "string" ? metadata.fileName : attachment.storageKey,
      mimeType: attachment.mimeType ?? (typeof metadata.mimeType === "string" ? metadata.mimeType : undefined),
      byteSize: attachment.byteSize ?? (typeof metadata.byteSize === "number" ? metadata.byteSize : undefined),
      storageKey: attachment.storageKey,
      createdAt: attachment.createdAt.toISOString()
    };
  }
}

function conversationInclude() {
  return {
    contact: true,
    messages: { orderBy: { createdAt: "asc" as const }, include: { attachments: true } },
    applications: { orderBy: { updatedAt: "desc" as const }, include: applicationInclude() }
  };
}

function applicationInclude() {
  return {
    facts: { where: { supersededAt: null }, orderBy: { updatedAt: "desc" as const } },
    factHistory: { orderBy: { createdAt: "asc" as const } }
  };
}

function factsFromRows(rows: { key: string; value: unknown }[]): ApplicationFacts {
  const facts: ApplicationFacts = {};
  for (const row of rows) {
    (facts as Record<string, unknown>)[row.key] = row.value;
  }
  return facts;
}

function toPrismaChannel(channel: "web-test" | "wazzup"): MessageChannel {
  return channel === "web-test" ? "web_test" : "wazzup";
}

function fromPrismaChannel(channel: MessageChannel): "web-test" | "wazzup" {
  return channel === "wazzup" ? "wazzup" : "web-test";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function stablePayloadKey(payload: Record<string, unknown>): string {
  const normalized = Object.keys(payload).sort().map((key) => `${key}:${JSON.stringify(payload[key])}`).join("|");
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
