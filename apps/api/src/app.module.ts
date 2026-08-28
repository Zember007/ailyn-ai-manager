import { Module } from "@nestjs/common";
import { AiModule } from "./ai/ai.module.js";
import { ApplicationsModule } from "./applications/applications.module.js";
import { AttachmentsModule } from "./attachments/attachments.module.js";
import { AuditModule } from "./audit/audit.module.js";
import { BusinessRulesModule } from "./business-rules/business-rules.module.js";
import { ContactsModule } from "./contacts/contacts.module.js";
import { ConversationsModule } from "./conversations/conversations.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { FactsModule } from "./facts/facts.module.js";
import { HealthModule } from "./health/health.module.js";
import { IntegrationsModule } from "./integrations/integrations.module.js";
import { KnowledgeModule } from "./knowledge/knowledge.module.js";
import { LogsModule } from "./logs/logs.module.js";
import { MessagesModule } from "./messages/messages.module.js";
import { DialogueModule } from "./dialogue/dialogue.module.js";
import { SettingsModule } from "./settings/settings.module.js";
import { ScenariosModule } from "./scenarios/scenarios.module.js";

@Module({
  imports: [
    DatabaseModule,
    LogsModule,
    HealthModule,
    ContactsModule,
    ConversationsModule,
    ApplicationsModule,
    MessagesModule,
    FactsModule,
    DialogueModule,
    AttachmentsModule,
    BusinessRulesModule,
    AiModule,
    KnowledgeModule,
    AuditModule,
    IntegrationsModule,
    SettingsModule,
    ScenariosModule
  ]
})
export class AppModule {}
