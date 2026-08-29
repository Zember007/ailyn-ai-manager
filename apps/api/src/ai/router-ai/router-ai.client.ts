import { Injectable } from "@nestjs/common";
import { loadAppConfig } from "@ailyn/config";
import type { RouterAiChatRequest, RouterAiChatResponse } from "./router-ai.types.js";

const ROUTERAI_CHAT_COMPLETIONS_URL = "https://routerai.ru/api/v1/chat/completions";

interface RouterAiRequestOptions {
  timeoutMs?: number;
}

@Injectable()
export class RouterAiClient {
  private readonly config = loadAppConfig();

  isConfigured(): boolean {
    return Boolean(this.config.routerAiApiKey);
  }

  async createChatCompletion(request: RouterAiChatRequest, options: RouterAiRequestOptions = {}): Promise<RouterAiChatResponse> {
    if (!this.isConfigured()) {
      throw new Error("RouterAI is not configured.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.config.routerAiTimeoutMs);

    try {
      const response = await fetch(ROUTERAI_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.routerAiApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(request),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`RouterAI request failed with ${response.status}`);
      }

      return (await response.json()) as RouterAiChatResponse;
    } finally {
      clearTimeout(timeout);
    }
  }
}
