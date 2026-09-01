import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterAiProvider } from "./router-ai.provider.js";

describe("RouterAiProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
      moneyMentions: [],
      changedFacts: [],
      route: { kind: "none" },
      attachments: [],
      promptInjectionDetected: true,
      clarificationNeeded: false
    });
  });

  it("passes bounded dialogue context to RouterAI and preserves its route proposal", async () => {
    const dialogueContext = {
      summary: "Known vehicle and requested amount; deterministic state asks for documents.",
      recentMessages: [
        { author: "ai" as const, text: "Если Вам нужна сумма больше лимита без изъятия, можем продолжить по программе с постановкой автомобиля на охраняемую стоянку?" },
        { author: "client" as const, text: "Ок" }
      ],
      currentFacts: {
        vehicleMake: "Toyota",
        vehicleModel: "Camry",
        requestedAmount: 800_000,
        requestedProgram: "without_storage" as const
      },
      pendingFacts: ["id_front" as const],
      decisionEnvelope: {
        allowedNextFacts: ["id_front", "requestedAmount", "requestedProgram"],
        activeOffer: "parking_after_without_storage_limit" as const
      }
    };
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn().mockResolvedValue({
        model: "routerai-text",
        choices: [{ message: { content: JSON.stringify({
          language: "ru",
          route: { kind: "set_fact", fact: "requestedProgram", value: "parking" }
        }) } }]
      })
    } as any;

    const provider = new RouterAiProvider(client);
    const result = await provider.extract({
      text: "Ок",
      attachments: [],
      dialogueContext
    });

    expect(result.route).toEqual({ kind: "set_fact", fact: "requestedProgram", value: "parking" });
    expect(client.createChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining("parking_after_without_storage_limit") }),
        expect.objectContaining({ content: expect.stringContaining("\"recentMessages\"") })
      ])
    }), expect.anything());
  });

  it("gives RouterAI an explicit rule for the typo-filled vehicle value and requested amount", async () => {
    process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
    process.env.REDIS_URL ??= "redis://localhost:6379";

    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn().mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ language: "ru" }) } }]
      })
    } as any;
    const provider = new RouterAiProvider(client);

    await provider.extract({
      text: "камри 2022 стоит 20 тфыс долларов надо 10",
      attachments: [],
      facts: {},
      pendingFacts: ["vehicleValue", "requestedAmount"]
    } as any);

    expect(client.createChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      max_tokens: 600,
      reasoning: { enabled: false },
      messages: expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining("vehicleValue=20 000 USD") }),
        expect.objectContaining({ content: expect.stringContaining("камри 2022 стоит 20 тфыс долларов надо 10") })
      ])
    }), expect.anything());
  });

  it("accepts GPT-style field names while keeping foreign amounts for FX conversion", async () => {
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn().mockResolvedValue({
        model: "openai/gpt-5.4-mini",
        choices: [{ message: { content: JSON.stringify({
          language: "ru",
          intents: ["statement"],
          questions: [],
          facts: [
            { field: "vehicleValue", amount: 20_000, currency: "USD" },
            { field: "requestedAmount", amount: 10_000, currency: "USD" }
          ],
          moneyMentions: [
            { sourceText: "20 тфыс долларов", amount: 20_000, normalizedAmount: 20_000, currency: "USD", roleCandidate: "vehicleValue", confidence: 0.98, start: 18, end: 35 },
            { sourceText: "10", amount: 10, normalizedAmount: 10_000, currency: "USD", roleCandidate: "requestedAmount", confidence: 0.92, start: 41, end: 43 }
          ],
          changedFacts: [],
          attachments: [],
          promptInjectionDetected: false,
          clarificationNeeded: false
        }) } }]
      })
    } as any;

    const provider = new RouterAiProvider(client);
    const result = await provider.extract({ text: "камри 2022 стоит 20 тфыс долларов надо 10", attachments: [], facts: {} } as any);

    expect(result.moneyMentions).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleCandidate: "vehicleValue", normalizedAmount: 20_000, currency: "USD" }),
      expect.objectContaining({ roleCandidate: "requestedAmount", normalizedAmount: 10_000, currency: "USD" })
    ]));
    expect(result.facts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "vehicleValue" }),
      expect.objectContaining({ key: "requestedAmount" })
    ]));
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

  it("keeps a short foreign-currency vehicle value reply as a money mention until FX conversion", async () => {
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

    expect(result.moneyMentions).toEqual(expect.arrayContaining([expect.objectContaining({
      sourceText: "2 000 000 руб",
      currency: "RUB",
      roleCandidate: "vehicleValue",
      normalizedAmount: 2_000_000
    })]));
    expect(result.facts).not.toEqual(expect.arrayContaining([expect.objectContaining({ key: "vehicleValue" })]));
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

  it("parses decimal millions and compact thousands without losing magnitude", async () => {
    const provider = new RouterAiProvider({ isConfigured: vi.fn().mockReturnValue(false) } as any);
    const result = await provider.extract({
      text: "Camry 2021, стоит 1.5 млн, нужно 500к",
      attachments: [],
      facts: {}
    });

    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "vehicleValue", value: 1_500_000 }),
      expect.objectContaining({ key: "requestedAmount", value: 500_000 })
    ]));
  });

  it("extracts mixed free-form requested amount and vehicle value mentions from one turn", async () => {
    const provider = new RouterAiProvider({ isConfigured: vi.fn().mockReturnValue(false) } as any);
    const result = await provider.extract({
      text: "камри 2010 года надо 10 тыс долларов стоит 20 тыс",
      attachments: [],
      facts: {}
    });

    expect(result.moneyMentions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceText: "10 тыс долларов", currency: "USD", roleCandidate: "requestedAmount", normalizedAmount: 10_000 }),
      expect.objectContaining({ sourceText: "20 тыс", currency: "KGS", roleCandidate: "vehicleValue", normalizedAmount: 20_000 })
    ]));
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "vehicleValue", value: 20_000 })
    ]));
    expect(result.facts).not.toEqual(expect.arrayContaining([expect.objectContaining({ key: "requestedAmount" })]));
  });

  it("detects generalized correction and limit-objection intents without exact phrase matching", async () => {
    const provider = new RouterAiProvider({ isConfigured: vi.fn().mockReturnValue(false) } as any);
    const correction = await provider.extract({
      text: "нет, теперь нужно 450 000",
      attachments: [],
      facts: { vehicleValue: 1_500_000, requestedAmount: 300_000 }
    });
    const objection = await provider.extract({
      text: "почему так мало, мне нужно 800 тысяч",
      attachments: [],
      facts: {
        vehicleValue: 1_749_000,
        requestedAmount: 874_500,
        requestedProgram: "without_storage",
        residenceRegion: "Бишкек"
      },
      pendingFacts: ["id_front", "id_back", "vehicle_registration_front", "vehicle_registration_back"]
    } as any);
    const alreadyProvided = await provider.extract({
      text: "я выше уже писал",
      attachments: [],
      facts: {},
      pendingFacts: ["vehicleValue"]
    } as any);

    expect(correction.intents).toContain("correction");
    expect(correction.facts).toEqual(expect.arrayContaining([expect.objectContaining({ key: "requestedAmount", value: 450_000 })]));
    expect(objection.intents).toEqual(expect.arrayContaining(["limit_objection", "clarification_request"]));
    expect(objection.facts).toEqual(expect.arrayContaining([expect.objectContaining({ key: "requestedAmount", value: 800_000 })]));
    expect(alreadyProvided.intents).toContain("already_provided");
  });

  it("does not mark the vehicle as pledged from a generic new-loan phrase", async () => {
    const provider = new RouterAiProvider({ isConfigured: vi.fn().mockReturnValue(false) } as any);
    const generic = await provider.extract({ text: "Хочу займ под залог автомобиля", attachments: [], facts: {} });
    const explicit = await provider.extract({ text: "Машина сейчас в кредите", attachments: [], facts: {} });

    expect(generic.facts).not.toEqual(expect.arrayContaining([expect.objectContaining({ key: "vehicleInCredit", value: true })]));
    expect(explicit.facts).toEqual(expect.arrayContaining([expect.objectContaining({ key: "vehicleInCredit", value: true })]));
  });

  it("extracts refusal, ownership, and existing-contract facts from short special-flow turns", async () => {
    const provider = new RouterAiProvider({ isConfigured: vi.fn().mockReturnValue(false) } as any);

    const foreignVehicle = await provider.extract({ text: "Машина зарегистрирована в Казахстане.", attachments: [], facts: {} });
    const foreignCitizen = await provider.extract({ text: "Я гражданин Казахстана, машина на кыргызских номерах.", attachments: [], facts: {} });
    const ownerCannotVisit = await provider.extract({ text: "Собственник приехать не сможет.", attachments: [], facts: {} });
    const existingContract = await provider.extract({ text: "Сколько у меня осталось долга по договору?", attachments: [], facts: {} });

    expect(foreignVehicle.facts).toEqual(expect.arrayContaining([expect.objectContaining({ key: "vehicleRegistrationCountry", value: "KZ" })]));
    expect(foreignCitizen.facts).toEqual(expect.arrayContaining([expect.objectContaining({ key: "citizenship", value: "KZ" })]));
    expect(ownerCannotVisit.facts).toEqual(expect.arrayContaining([expect.objectContaining({ key: "ownerCanVisit", value: false })]));
    expect(existingContract.facts).toEqual(expect.arrayContaining([expect.objectContaining({ key: "existingContractQuestion", value: true })]));
  });

  it("extracts family follow-ups and relative visit dates from special replies", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
    const provider = new RouterAiProvider({ isConfigured: vi.fn().mockReturnValue(false) } as any);

    const single = await provider.extract({ text: "Никогда не был женат.", attachments: [], facts: {} });
    const tomorrowVisit = await provider.extract({ text: "Я могу приехать завтра.", attachments: [], facts: {} });
    const sundayVisit = await provider.extract({ text: "Приеду в воскресенье.", attachments: [], facts: {} });
    const divorcedFlow = await provider.extract({ text: "В браке.", attachments: [], facts: { familyStatus: "divorced" } as any });

    expect(single.facts).toEqual(expect.arrayContaining([expect.objectContaining({ key: "familyStatus", value: "single" })]));
    expect(tomorrowVisit.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "visitRequested", value: true }),
      expect.objectContaining({ key: "visitDate", value: "2026-09-01" })
    ]));
    expect(sundayVisit.facts).toEqual(expect.arrayContaining([expect.objectContaining({ key: "visitDate", value: "2026-09-06" })]));
    expect(divorcedFlow.facts).toEqual(expect.arrayContaining([expect.objectContaining({ key: "vehicleBoughtDuringMarriage", value: true })]));
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

  it("keeps unknown images unknown and preserves poor-quality registration classification", async () => {
    const provider = new RouterAiProvider({ isConfigured: vi.fn().mockReturnValue(false) } as any);

    const cat = await provider.analyzeImage({
      attachment: {
        id: "att-cat",
        fileName: "cat.jpg",
        mimeType: "image/jpeg"
      }
    });
    const poorRegistration = await provider.analyzeImage({
      attachment: {
        id: "att-reg",
        fileName: "registration-front-poor.jpg",
        mimeType: "image/jpeg"
      }
    });

    expect(cat).toEqual(expect.objectContaining({ type: "unknown" }));
    expect(poorRegistration).toEqual(expect.objectContaining({ type: "vehicle_registration_front", quality: "poor" }));
  });

  it("extracts an explicit borrower full name and phone from text when RouterAI extraction falls back", async () => {
    const provider = new RouterAiProvider({ isConfigured: vi.fn().mockReturnValue(false) } as any);
    const result = await provider.extract({
      text: "Меня зовут Иванов Иван Иванович, телефон +996 555 123 456. Toyota Camry 2018",
      attachments: [],
      facts: {}
    });

    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "fullName", value: "Иванов Иван Иванович" }),
      expect.objectContaining({ key: "phone", value: "+996555123456" })
    ]));
  });

  it("calls RouterAI first even when local fallback could understand the message", async () => {
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn().mockResolvedValue({
        model: "routerai-text",
        choices: [{ message: { content: JSON.stringify({
          language: "ru",
          facts: [
            { key: "vehicleMake", value: "Toyota", confidence: 0.96 },
            { key: "vehicleModel", value: "Camry", confidence: 0.96 },
            { key: "vehicleYear", value: 2018, confidence: 0.96 },
            { key: "vehicleValue", value: 1_500_000, confidence: 0.96 },
            { key: "requestedAmount", value: 500_000, confidence: 0.96 }
          ],
          moneyMentions: [
            {
              sourceText: "1.5 млн",
              amount: 1_500_000,
              normalizedAmount: 1_500_000,
              currency: "KGS",
              roleCandidate: "vehicleValue",
              confidence: 0.96,
              start: 25,
              end: 32
            },
            {
              sourceText: "500к",
              amount: 500_000,
              normalizedAmount: 500_000,
              currency: "KGS",
              roleCandidate: "requestedAmount",
              confidence: 0.96,
              start: 40,
              end: 44
            }
          ]
        }) } }]
      })
    } as any;

    const provider = new RouterAiProvider(client);
    const result = await provider.extract({
      text: "Toyota Camry 2018, стоит 1.5 млн, нужно 500к",
      attachments: [],
      facts: {}
    });

    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "vehicleMake", value: "Toyota" }),
      expect.objectContaining({ key: "vehicleModel", value: "Camry" }),
      expect.objectContaining({ key: "vehicleYear", value: 2018 }),
      expect.objectContaining({ key: "vehicleValue", value: 1_500_000 }),
      expect.objectContaining({ key: "requestedAmount", value: 500_000 })
    ]));
  });

  it("backfills KGS money facts from RouterAI money mentions when facts are sparse", async () => {
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn().mockResolvedValue({
        model: "routerai-text",
        choices: [{ message: { content: JSON.stringify({
          language: "ru",
          moneyMentions: [
            {
              sourceText: "стоит 1500000",
              amount: 1_500_000,
              normalizedAmount: 1_500_000,
              currency: "KGS",
              roleCandidate: "vehicleValue",
              confidence: 0.94,
              start: 12,
              end: 24
            },
            {
              sourceText: "нужно 500000",
              amount: 500_000,
              normalizedAmount: 500_000,
              currency: "KGS",
              roleCandidate: "requestedAmount",
              confidence: 0.94,
              start: 25,
              end: 37
            }
          ]
        }) } }]
      })
    } as any;

    const provider = new RouterAiProvider(client);
    const result = await provider.extract({
      text: "Камри 2022 стоит 1500000, нужно 500000",
      attachments: [],
      facts: {}
    });

    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "vehicleValue", value: 1_500_000 }),
      expect.objectContaining({ key: "requestedAmount", value: 500_000 })
    ]));
  });

  it("inherits a shared foreign currency across two short RouterAI money mentions", async () => {
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn().mockResolvedValue({
        model: "routerai-text",
        choices: [{ message: { content: JSON.stringify({
          language: "ru",
          moneyMentions: [
            {
              sourceText: "20 тфыс долларов",
              amount: 20_000,
              normalizedAmount: 20_000,
              currency: "USD",
              roleCandidate: "vehicleValue",
              confidence: 0.95,
              start: 18,
              end: 34
            },
            {
              sourceText: "10",
              amount: 10_000,
              normalizedAmount: 10_000,
              currency: "KGS",
              roleCandidate: "requestedAmount",
              confidence: 0.86,
              start: 40,
              end: 42
            }
          ]
        }) } }]
      })
    } as any;

    const provider = new RouterAiProvider(client);
    const result = await provider.extract({
      text: "камри 2022 стоит 20 тфыс долларов надо 10",
      attachments: [],
      facts: {}
    });

    expect(result.moneyMentions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceText: "20 тфыс долларов", currency: "USD", roleCandidate: "vehicleValue" }),
      expect.objectContaining({ sourceText: "10", currency: "USD", roleCandidate: "requestedAmount" })
    ]));
    expect(result.facts).not.toEqual(expect.arrayContaining([expect.objectContaining({ key: "requestedAmount" })]));
  });

  it("calls RouterAI vision before local attachment inference when configured", async () => {
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn().mockResolvedValue({
        model: "routerai-vision",
        choices: [{ message: { content: JSON.stringify({
          type: "id_front",
          quality: "good",
          extractedFacts: [{ key: "fullName", value: "Иванов Иван Иванович", confidence: 0.91 }]
        }) } }]
      })
    } as any;

    const provider = new RouterAiProvider(client);
    const result = await provider.analyzeImage({
      attachment: {
        id: "att-1",
        fileName: "passport-front.txt",
        mimeType: "text/plain",
        textContent: "ID FRONT\nФИО: Иванов Иван Иванович"
      }
    });

    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      type: "id_front",
      quality: "good",
      extractedFacts: [{ key: "fullName", value: "Иванов Иван Иванович", confidence: 0.91 }]
    });
  });

  it("sends image pixels to RouterAI Vision as a data URI", async () => {
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ type: "id_front", quality: "good", extractedFacts: [] }) } }] })
    } as any;
    const provider = new RouterAiProvider(client);
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    await provider.analyzeImage({ attachment: { id: "id", fileName: "id.jpg", mimeType: "image/jpeg", contentBase64: jpegBytes.toString("base64") } });
    const request = client.createChatCompletion.mock.calls[0]?.[0];
    expect(request.messages[1].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpegBytes.toString("base64")}` } })
    ]));
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
      model: "stage1-response-plan-fast-path",
      promptVersion: "stage1-response-plan-v1"
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

  it("uses a deterministic response fast path when the plan already contains exact client-facing text", async () => {
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn()
    } as any;

    const provider = new RouterAiProvider(client);
    const result = await provider.generateResponse({
      facts: {},
      userText: "Здравствуйте",
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
        answers: [{ topic: "greeting", meaning: "Здравствуйте!", exactText: "Здравствуйте!" }],
        nextAction: "collect_vehicle",
        nextQuestions: ["Какая ориентировочная стоимость автомобиля?"],
        allowedFacts: {},
        allowedFinancialValues: [],
        requiredStatements: [],
        forbiddenStatements: [],
        language: "ru"
      }
    } as any);

    expect(client.createChatCompletion).not.toHaveBeenCalled();
    expect(result).toEqual({
      message: "Здравствуйте!\n\nКакая ориентировочная стоимость автомобиля?",
      model: "stage1-response-plan-fast-path",
      promptVersion: "stage1-response-plan-v1"
    });
  });
});
