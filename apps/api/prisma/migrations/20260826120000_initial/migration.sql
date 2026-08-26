CREATE TYPE "MessageAuthor" AS ENUM ('client', 'manager', 'system', 'ai');
CREATE TYPE "MessageChannel" AS ENUM ('admin', 'whatsapp', 'telegram', 'system');
CREATE TYPE "ApplicationState" AS ENUM ('draft', 'collecting_facts', 'ready_for_review', 'approved', 'refused', 'closed');

CREATE TABLE "Contact" (
  "id" TEXT NOT NULL,
  "externalContactId" TEXT,
  "fullName" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Conversation" (
  "id" TEXT NOT NULL,
  "contactId" TEXT,
  "channel" "MessageChannel" NOT NULL,
  "externalConversationId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Application" (
  "id" TEXT NOT NULL,
  "contactId" TEXT,
  "conversationId" TEXT,
  "state" "ApplicationState" NOT NULL DEFAULT 'draft',
  "idempotencyKey" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Message" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "author" "MessageAuthor" NOT NULL,
  "channel" "MessageChannel" NOT NULL,
  "body" TEXT NOT NULL,
  "externalMessageId" TEXT,
  "sourceMessageId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Attachment" (
  "id" TEXT NOT NULL,
  "messageId" TEXT,
  "externalAttachmentId" TEXT,
  "storageKey" TEXT NOT NULL,
  "mimeType" TEXT,
  "byteSize" INTEGER,
  "checksum" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApplicationFact" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT,
  "contactId" TEXT,
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "previousValue" JSONB,
  "source" TEXT NOT NULL,
  "sourceMessageId" TEXT,
  "supersededAt" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApplicationFact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Visit" (
  "id" TEXT NOT NULL,
  "contactId" TEXT,
  "applicationId" TEXT,
  "scheduledAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'planned',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ManagerNotification" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT,
  "channel" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "payload" JSONB NOT NULL DEFAULT '{}',
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ManagerNotification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Reminder" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'scheduled',
  "payload" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KnowledgeItem" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "source" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditEvent" (
  "id" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT,
  "messageId" TEXT,
  "idempotencyKey" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Application_idempotencyKey_key" ON "Application"("idempotencyKey");
CREATE UNIQUE INDEX "Message_idempotencyKey_key" ON "Message"("idempotencyKey");
CREATE UNIQUE INDEX "AuditEvent_idempotencyKey_key" ON "AuditEvent"("idempotencyKey");
CREATE INDEX "Contact_phone_idx" ON "Contact"("phone");
CREATE INDEX "Contact_externalContactId_idx" ON "Contact"("externalContactId");
CREATE INDEX "Conversation_contactId_idx" ON "Conversation"("contactId");
CREATE INDEX "Conversation_channel_externalConversationId_idx" ON "Conversation"("channel", "externalConversationId");
CREATE INDEX "Application_contactId_idx" ON "Application"("contactId");
CREATE INDEX "Application_conversationId_idx" ON "Application"("conversationId");
CREATE INDEX "Application_state_idx" ON "Application"("state");
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
CREATE INDEX "Message_externalMessageId_idx" ON "Message"("externalMessageId");
CREATE INDEX "Message_sourceMessageId_idx" ON "Message"("sourceMessageId");
CREATE INDEX "Attachment_messageId_idx" ON "Attachment"("messageId");
CREATE INDEX "ApplicationFact_applicationId_key_idx" ON "ApplicationFact"("applicationId", "key");
CREATE INDEX "ApplicationFact_contactId_key_idx" ON "ApplicationFact"("contactId", "key");
CREATE INDEX "ApplicationFact_sourceMessageId_idx" ON "ApplicationFact"("sourceMessageId");
CREATE INDEX "Visit_contactId_idx" ON "Visit"("contactId");
CREATE INDEX "Visit_applicationId_idx" ON "Visit"("applicationId");
CREATE INDEX "ManagerNotification_applicationId_idx" ON "ManagerNotification"("applicationId");
CREATE INDEX "ManagerNotification_status_idx" ON "ManagerNotification"("status");
CREATE INDEX "Reminder_applicationId_idx" ON "Reminder"("applicationId");
CREATE INDEX "Reminder_dueAt_status_idx" ON "Reminder"("dueAt", "status");
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");
CREATE INDEX "AuditEvent_messageId_idx" ON "AuditEvent"("messageId");

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Application" ADD CONSTRAINT "Application_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Application" ADD CONSTRAINT "Application_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ApplicationFact" ADD CONSTRAINT "ApplicationFact_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ApplicationFact" ADD CONSTRAINT "ApplicationFact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ApplicationFact" ADD CONSTRAINT "ApplicationFact_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ManagerNotification" ADD CONSTRAINT "ManagerNotification_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
