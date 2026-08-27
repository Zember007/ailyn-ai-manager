import { Global, Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { DialogueOrchestratorService } from "./dialogue-orchestrator.service.js";
import { ResponsePlanService } from "./response-plan.service.js";
import { ResponseValidatorService } from "./response-validator.service.js";
import { Stage1StoreService } from "./stage1-store.service.js";
import { SettingsModule } from "../settings/settings.module.js";

@Global()
@Module({
  imports: [AiModule, SettingsModule],
  providers: [DialogueOrchestratorService, ResponsePlanService, ResponseValidatorService, Stage1StoreService],
  exports: [DialogueOrchestratorService, Stage1StoreService]
})
export class DialogueModule {}
