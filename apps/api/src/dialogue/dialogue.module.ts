import { Global, Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { DialogueOrchestratorService } from "./dialogue-orchestrator.service.js";
import { Stage1StoreService } from "./stage1-store.service.js";
import { SettingsModule } from "../settings/settings.module.js";
import { AgentTurnService } from "./agent-turn.service.js";
import { DeferredIntegrationsService } from "./deferred-integrations.service.js";
import { LogsModule } from "../logs/logs.module.js";

@Global()
@Module({
  imports: [AiModule, SettingsModule, LogsModule],
  providers: [DialogueOrchestratorService, AgentTurnService, Stage1StoreService, DeferredIntegrationsService],
  exports: [DialogueOrchestratorService, Stage1StoreService]
})
export class DialogueModule {}
