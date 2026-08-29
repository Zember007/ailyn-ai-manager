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

  it("falls back to local extraction when RouterAI errors", async () => {
    process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
    process.env.REDIS_URL ??= "redis://localhost:6379";

    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn().mockRejectedValue(new DOMException("This operation was aborted", "AbortError"))
    } as any;

    const provider = new RouterAiProvider(client);
    const result = await provider.extract({
      text: "Toyota Camry 2018",
      attachments: [],
      facts: {}
    } as any);

    expect(result.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "vehicleMake", value: "Toyota" }),
        expect.objectContaining({ key: "vehicleModel", value: "Camry" }),
        expect.objectContaining({ key: "vehicleYear", value: 2018 })
      ])
    );
  });

  it("falls back to local response when RouterAI errors", async () => {
    process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
    process.env.REDIS_URL ??= "redis://localhost:6379";

    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn().mockRejectedValue(new DOMException("This operation was aborted", "AbortError"))
    } as any;

    const provider = new RouterAiProvider(client);
    const result = await provider.generateResponse({
      userText: "Toyota Camry 2018",
      facts: {},
      decision: {
        stage: "COLLECTING_VEHICLE",
        status: "need_more_data",
        nextAction: "collect_vehicle",
        blockedRules: [],
        rulesApplied: [],
        requiredFacts: ["vehicleValue"],
        calculatedLimits: {},
        eligiblePrograms: ["without_storage"],
        requiredStatements: [],
        forbiddenStatements: []
      },
      responsePlan: {
        answers: [],
        nextQuestions: ["Уточните, пожалуйста, ориентировочную стоимость автомобиля."],
        requiredStatements: []
      }
    } as any);

    expect(result).toEqual({
      message: "Уточните, пожалуйста, ориентировочную стоимость автомобиля.",
      model: "routerai-local-fallback",
      promptVersion: "stage1-local-v1"
    });
  });
});
