import { Injectable } from "@nestjs/common";
import type { HealthDependency } from "@ailyn/shared";
import { loadAppConfig } from "@ailyn/config";

export interface StructuredGenerationRequest {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
}

@Injectable()
export class AiService {
  getStatus(): HealthDependency {
    return loadAppConfig().openAiApiKey
      ? { status: "ok", message: "OpenAI Responses API configured" }
      : { status: "unconfigured", message: "OPENAI_API_KEY is not set" };
  }

  async generateStructured(_request: StructuredGenerationRequest): Promise<never> {
    throw new Error("AI language generation is not configured for Stage 1.");
  }
}
