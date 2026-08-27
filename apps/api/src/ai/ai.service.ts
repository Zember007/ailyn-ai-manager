import { Injectable } from "@nestjs/common";
import type { HealthDependency } from "@ailyn/shared";
import { loadAppConfig } from "@ailyn/config";
import type { AiProvider } from "./ai-provider.interface.js";
import { RouterAiProvider } from "./router-ai/router-ai.provider.js";

@Injectable()
export class AiService {
  constructor(private readonly routerAiProvider: RouterAiProvider) {}

  getProvider(): AiProvider {
    return this.routerAiProvider;
  }

  getStatus(): HealthDependency {
    const config = loadAppConfig();
    if (config.routerAiApiKey) {
      return { status: "ok", message: "RouterAI configured" };
    }
    return { status: "unconfigured", message: "ROUTERAI_API_KEY is not set; local Stage 1 fallback is active" };
  }
}
