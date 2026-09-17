import { Injectable, Logger } from "@nestjs/common";
import { loadAppConfig } from "@ailyn/config";
import { BackendLogsService } from "../../logs/backend-logs.service.js";
import type { RouterAiChatRequest, RouterAiChatResponse } from "./router-ai.types.js";

const ROUTERAI_CHAT_COMPLETIONS_URL = "https://routerai.ru/api/v1/chat/completions";

interface RouterAiRequestOptions {
  /** Identifies the caller's pipeline stage in latency logs. */
  operation?: string;
  timeoutMs?: number;
  /** Cancels an obsolete dialogue turn when a newer client message arrives. */
  signal?: AbortSignal;
  /** Correlates an AI operation with a dialogue visible in backend logs. */
  conversationId?: string;
}

@Injectable()
export class RouterAiClient {
  private readonly config = loadAppConfig();
  private readonly logger = new Logger(RouterAiClient.name);

  constructor(private readonly logs?: BackendLogsService) {}

  isConfigured(): boolean {
    return Boolean(this.config.routerAiApiKey);
  }

  async createChatCompletion(request: RouterAiChatRequest, options: RouterAiRequestOptions = {}): Promise<RouterAiChatResponse> {
    const startedAt = performance.now();
    const prompt = measurePrompt(request);
    const requestBody = JSON.stringify(request);
    const requestBytes = Buffer.byteLength(requestBody, "utf8");
    const requestSerializedAt = performance.now();
    let outcome: "success" | "error" | "aborted" | "unconfigured" = "error";
    let responseModel: string | undefined;
    let responseReceivedAt: number | undefined;
    let responseDecodedAt: number | undefined;
    let responseBytes: number | undefined;
    let usage: RouterAiUsage | undefined;
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
          body: requestBody,
          signal: controller.signal
        });
        responseReceivedAt = performance.now();

        if (!response.ok) {
          throw new Error(`RouterAI request failed with ${response.status}`);
        }

        const payload = (await response.json()) as RouterAiChatResponse;
        responseDecodedAt = performance.now();
        responseModel = payload.model;
        responseBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
        usage = readUsage(payload);
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
      const telemetry = {
        event: "routerai.chat_completion",
        operation: options.operation ?? "unspecified",
        requestedModel: request.model,
        model: responseModel ?? request.model,
        outcome,
        durationMs: Math.round(performance.now() - startedAt),
        timing: {
          requestSerializationMs: Math.round(requestSerializedAt - startedAt),
          networkAndServerMs: responseReceivedAt === undefined ? undefined : Math.round(responseReceivedAt - requestSerializedAt),
          responseDecodingMs: responseReceivedAt === undefined || responseDecodedAt === undefined ? undefined : Math.round(responseDecodedAt - responseReceivedAt)
        },
        prompt,
        requestBytes,
        ...(responseBytes === undefined ? {} : { responseBytes }),
        ...(usage ? { usage } : {}),
        ...(error ? { error: formatError(error) } : {})
      };
      this.logger.log("RouterAI chat completion finished", telemetry);
      void this.logs?.log("routerai.chat_completion", "RouterAI chat completion finished", {
        conversationId: options.conversationId,
        metadata: telemetry
      });
    }
  }
}

interface RouterAiUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
}

function measurePrompt(request: RouterAiChatRequest) {
  const messages = request.messages.map((message) => ({
    role: message.role,
    content: typeof message.content === "string" ? message.content : JSON.stringify(message.content)
  }));
  const byRole = (role: "system" | "user" | "assistant") => messages
    .filter((message) => message.role === role)
    .reduce((total, message) => ({
      characters: total.characters + message.content.length,
      bytes: total.bytes + Buffer.byteLength(message.content, "utf8")
    }), { characters: 0, bytes: 0 });
  const total = messages.reduce((value, message) => ({
    characters: value.characters + message.content.length,
    bytes: value.bytes + Buffer.byteLength(message.content, "utf8")
  }), { characters: 0, bytes: 0 });
  const system = byRole("system");
  const user = byRole("user");
  const assistant = byRole("assistant");
  return {
    messageCount: messages.length,
    ...total,
    systemCharacters: system.characters,
    systemBytes: system.bytes,
    userCharacters: user.characters,
    userBytes: user.bytes,
    assistantCharacters: assistant.characters,
    assistantBytes: assistant.bytes
  };
}

function readUsage(payload: RouterAiChatResponse): RouterAiUsage | undefined {
  const usage = payload.usage;
  if (!usage) return undefined;
  const values: RouterAiUsage = {
    promptTokens: numberOrUndefined(usage.prompt_tokens),
    completionTokens: numberOrUndefined(usage.completion_tokens),
    totalTokens: numberOrUndefined(usage.total_tokens),
    cachedTokens: numberOrUndefined(usage.prompt_tokens_details?.cached_tokens)
  };
  return Object.values(values).some((value) => value !== undefined) ? values : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
