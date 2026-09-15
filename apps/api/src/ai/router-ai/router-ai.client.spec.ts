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

  it("logs the operation, model, duration, and successful outcome", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ model: "router-fast-model", choices: [] })
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
      durationMs: expect.any(Number)
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
