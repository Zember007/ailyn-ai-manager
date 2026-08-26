import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";

@Module({
  imports: [AiModule],
  controllers: [HealthController],
  providers: [HealthService]
})
export class HealthModule {}
