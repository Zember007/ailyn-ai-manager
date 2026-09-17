import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterAiClient } from "./router-ai.client.js";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.ROUTERAI_API_KEY ??= "test-routerai-key";

describe("RouterAiClient timing logs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("logs the operation, model, timing breakdown, prompt size, and token usage", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        model: "router-fast-model",
        choices: [],
        usage: {
          prompt_tokens: 123,
          completion_tokens: 45,
          total_tokens: 168,
          prompt_tokens_details: { cached_tokens: 80 }
        }
      })
    }));

    await new RouterAiClient().createChatCompletion({
      model: "requested-model",
      messages: [{ role: "user", content: "test" }]
    }, { operation: "main_agent" });

    expect(log).toHaveBeenCalledWith("RouterAI chat completion finished", expect.objectContaining({
      event: "routerai.chat_completion",
      operation: "main_agent",
      requestedModel: "requested-model",
      model: "router-fast-model",
      outcome: "success",
      durationMs: expect.any(Number),
      timing: expect.objectContaining({
        requestSerializationMs: expect.any(Number),
        networkAndServerMs: expect.any(Number),
        responseDecodingMs: expect.any(Number)
      }),
      prompt: expect.objectContaining({
        messageCount: 1,
        characters: 4,
        bytes: 4,
        systemCharacters: 0,
        systemBytes: 0,
        userCharacters: 4,
        userBytes: 4
      }),
      requestBytes: expect.any(Number),
      responseBytes: expect.any(Number),
      usage: {
        promptTokens: 123,
        completionTokens: 45,
        totalTokens: 168,
        cachedTokens: 80
      }
    }));
  });

  it("logs failed requests as errors", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));

    await expect(new RouterAiClient().createChatCompletion({
      model: "requested-model",
      messages: [{ role: "user", content: "test" }]
    }, { operation: "knowledge_answer" })).rejects.toThrow("network unavailable");

    expect(log).toHaveBeenCalledWith("RouterAI chat completion finished", expect.objectContaining({
      event: "routerai.chat_completion",
      operation: "knowledge_answer",
      requestedModel: "requested-model",
      model: "requested-model",
      outcome: "error",
      durationMs: expect.any(Number),
      error: "Error: network unavailable"
    }));
  });

  it("logs cancelled requests as aborted", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("request cancelled", "AbortError")));

    await expect(new RouterAiClient().createChatCompletion({
      model: "requested-model",
      messages: [{ role: "user", content: "test" }]
    }, { operation: "main_agent", signal: controller.signal })).rejects.toThrow("request cancelled");

    expect(log).toHaveBeenCalledWith("RouterAI chat completion finished", expect.objectContaining({
      event: "routerai.chat_completion",
      operation: "main_agent",
      requestedModel: "requested-model",
      model: "requested-model",
      outcome: "aborted",
      durationMs: expect.any(Number)
    }));
  });
});
