import { Injectable, Logger } from "@nestjs/common";
import { loadAppConfig } from "@ailyn/config";
import type { RouterAiChatRequest, RouterAiChatResponse } from "./router-ai.types.js";

const ROUTERAI_CHAT_COMPLETIONS_URL = "https://routerai.ru/api/v1/chat/completions";

interface RouterAiRequestOptions {
  /** Identifies the caller's pipeline stage in latency logs. */
  operation?: string;
  timeoutMs?: number;
  /** Cancels an obsolete dialogue turn when a newer client message arrives. */
  signal?: AbortSignal;
}

@Injectable()
export class RouterAiClient {
  private readonly config = loadAppConfig();
  private readonly logger = new Logger(RouterAiClient.name);

  isConfigured(): boolean {
    return Boolean(this.config.routerAiApiKey);
  }

  async createChatCompletion(request: RouterAiChatRequest, options: RouterAiRequestOptions = {}): Promise<RouterAiChatResponse> {
    const startedAt = performance.now();
    let outcome: "success" | "error" | "aborted" | "unconfigured" = "error";
    let responseModel: string | undefined;
    let error: unknown;

    try {
      if (!this.isConfigured()) {
        outcome = "unconfigured";
        throw new Error("RouterAI is not configured.");
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.config.routerAiTimeoutMs);
      const abortFromCaller = () => controller.abort();
      options.signal?.addEventListener("abort", abortFromCaller, { once: true });
      if (options.signal?.aborted) controller.abort();

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

        const payload = (await response.json()) as RouterAiChatResponse;
        responseModel = payload.model;
        outcome = "success";
        return payload;
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abortFromCaller);
      }
    } catch (caught) {
      error = caught;
      if (outcome !== "unconfigured" && (options.signal?.aborted || isAbortError(caught))) outcome = "aborted";
      throw caught;
    } finally {
      this.logger.log("RouterAI chat completion finished", {
        event: "routerai.chat_completion",
        operation: options.operation ?? "unspecified",
        requestedModel: request.model,
        model: responseModel ?? request.model,
        outcome,
        durationMs: Math.round(performance.now() - startedAt),
        ...(error ? { error: formatError(error) } : {})
      });
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
