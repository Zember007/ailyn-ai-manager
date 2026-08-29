import { Global, Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { DialogueOrchestratorService } from "./dialogue-orchestrator.service.js";
import { ResponsePlanService } from "./response-plan.service.js";
import { ResponseValidatorService } from "./response-validator.service.js";
import { Stage1StoreService } from "./stage1-store.service.js";
import { SettingsModule } from "../settings/settings.module.js";
import { KnowledgeModule } from "../knowledge/knowledge.module.js";
import { KnowledgeBaseResolverService } from "./knowledge-base-resolver.service.js";
import { DeferredIntegrationsService } from "./deferred-integrations.service.js";

@Global()
@Module({
  imports: [AiModule, SettingsModule, KnowledgeModule],
  providers: [DialogueOrchestratorService, ResponsePlanService, ResponseValidatorService, Stage1StoreService, KnowledgeBaseResolverService, DeferredIntegrationsService],
  exports: [DialogueOrchestratorService, Stage1StoreService]
})
export class DialogueModule {}
