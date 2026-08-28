import { describe, expect, it, vi } from "vitest";
import { RouterAiProvider } from "./router-ai.provider.js";

describe("RouterAiProvider", () => {
  it("normalizes sparse extraction payloads from RouterAI", async () => {
    process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
    process.env.REDIS_URL ??= "redis://localhost:6379";

    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn().mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ language: "ru", promptInjectionDetected: true }) } }]
      })
    } as any;

    const provider = new RouterAiProvider(client);
    const result = await provider.extract({
      text: "Здравствуйте",
      attachments: [],
      facts: {}
    } as any);

    expect(result).toEqual({
      language: "ru",
      intents: [],
      questions: [],
      facts: [],
      changedFacts: [],
      attachments: [],
      promptInjectionDetected: true,
      clarificationNeeded: false
    });
  });
});
