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

  it("treats a short numeric reply as vehicle value when that fact is still missing", async () => {
    process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
    process.env.REDIS_URL ??= "redis://localhost:6379";

    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn().mockRejectedValue(new DOMException("This operation was aborted", "AbortError"))
    } as any;

    const provider = new RouterAiProvider(client);
    const result = await provider.extract({
      text: "2 000 000 руб",
      attachments: [],
      facts: {
        vehicleMake: "Toyota",
        vehicleModel: "Camry",
        vehicleYear: 2018
      }
    } as any);

    expect(result.facts).toEqual(expect.arrayContaining([expect.objectContaining({ key: "vehicleValue", value: 2_000_000 })]));
    expect(result.facts).not.toEqual(expect.arrayContaining([expect.objectContaining({ key: "requestedAmount" })]));
  });

  it("does not mistake a vehicle year inside the first message for vehicle value", async () => {
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

    expect(result.facts).toEqual(expect.arrayContaining([expect.objectContaining({ key: "vehicleYear", value: 2018 })]));
    expect(result.facts).not.toEqual(expect.arrayContaining([expect.objectContaining({ key: "vehicleValue" })]));
  });

  it("extracts the requested programme from a short follow-up", async () => {
    const provider = new RouterAiProvider({ isConfigured: vi.fn().mockReturnValue(false) } as any);
    const result = await provider.extract({ text: "Без изъятия, Бишкек", attachments: [], facts: {} });
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "requestedProgram", value: "without_storage" }),
      expect.objectContaining({ key: "residenceRegion", value: "Бишкек" })
    ]));
  });

  it("extracts attachment facts from text documents and classifies them conservatively", async () => {
    process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
    process.env.REDIS_URL ??= "redis://localhost:6379";

    const provider = new RouterAiProvider({ isConfigured: vi.fn().mockReturnValue(false) } as any);
    const result = await provider.analyzeImage({
      attachment: {
        id: "att-1",
        fileName: "passport-front.txt",
        mimeType: "text/plain",
        textContent: "ID FRONT\nФИО: Иванов Иван Иванович"
      }
    });

    expect(result.type).toBe("id_front");
    expect(result.extractedFacts).toEqual(expect.arrayContaining([expect.objectContaining({ key: "fullName", value: "Иванов Иван Иванович" })]));
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

  it("does not expose internal planning statements in the local response", async () => {
    const provider = new RouterAiProvider({ isConfigured: vi.fn().mockReturnValue(false) } as any);
    const result = await provider.generateResponse({
      facts: {}, userText: "", decision: {},
      responsePlan: { answers: [], nextQuestions: ["Пришлите, пожалуйста, фото ID."], requiredStatements: ["Попросить только недостающие документы."] }
    } as any);
    expect(result.message).toBe("Пришлите, пожалуйста, фото ID.");
  });
});
