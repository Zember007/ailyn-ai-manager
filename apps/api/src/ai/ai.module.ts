import { Module } from "@nestjs/common";
import { AiService } from "./ai.service.js";
import { RouterAiClient } from "./router-ai/router-ai.client.js";
import { RouterAiProvider } from "./router-ai/router-ai.provider.js";

@Module({
  providers: [AiService, RouterAiClient, RouterAiProvider],
  exports: [AiService]
})
export class AiModule {}
