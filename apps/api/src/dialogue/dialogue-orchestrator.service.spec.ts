import { describe, expect, it, vi } from "vitest";
import { DialogueOrchestratorService } from "./dialogue-orchestrator.service.js";

describe("DialogueOrchestratorService", () => {
  it("returns a refreshed conversation snapshot after persisting the inbound and ai reply", async () => {
    const initialConversation = {
      id: "conv-1",
      externalContactId: "web-client-1",
      externalConversationId: "web-conversation-1",
      channel: "web-test",
      messages: [],
      application: undefined
    };
    const refreshedConversation = {
      ...initialConversation,
      messages: [
        { id: "msg-client-1", author: "client", body: "Здравствуйте", createdAt: "2026-08-29T00:00:00.000Z", attachmentIds: [], attachments: [] },
        { id: "msg-ai-1", author: "ai", body: "Здравствуйте. Уточните модель автомобиля.", createdAt: "2026-08-29T00:00:01.000Z", attachmentIds: [], attachments: [] }
      ],
      application: {
        id: "app-1",
        stage: "COLLECTING_VEHICLE",
        status: "need_more_data",
        facts: {},
        factHistory: []
      }
    };
    const application = {
      id: "app-1",
      stage: "NEW",
      status: "need_more_data",
      facts: {},
      factHistory: [],
      contactId: "contact-1",
      conversationId: "conv-1"
    };
    const ai = {
      getProvider: () => ({
        extract: vi.fn().mockResolvedValue({
          language: "ru",
          intents: [],
          questions: [],
          facts: [],
          changedFacts: [],
          attachments: [],
          promptInjectionDetected: false,
          clarificationNeeded: false
        }),
        generateResponse: vi.fn().mockResolvedValue({
          message: "Здравствуйте. Уточните модель автомобиля.",
          model: "local-stage1-fallback",
          promptVersion: "stage1-local-v1"
        }),
        analyzeImage: vi.fn()
      })
    } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({
        conversation: initialConversation,
        application,
        isNew: false
      }),
      addMessage: vi
        .fn()
        .mockResolvedValueOnce({ id: "msg-client-1", createdAt: "2026-08-29T00:00:00.000Z" })
        .mockResolvedValueOnce({ id: "msg-ai-1", createdAt: "2026-08-29T00:00:01.000Z" }),
      createNewApplication: vi.fn(),
      updateFacts: vi.fn(),
      getApplication: vi
        .fn()
        .mockResolvedValueOnce({
          ...application,
          stage: "COLLECTING_VEHICLE",
          status: "need_more_data"
        })
        .mockResolvedValueOnce(refreshedConversation.application),
      saveDecision: vi.fn(),
      addAttachment: vi.fn(),
      getConversation: vi.fn().mockResolvedValue(refreshedConversation)
    } as any;
    const responsePlan = {
      build: vi.fn().mockReturnValue({
        answers: [],
        nextAction: "ask_vehicle",
        nextQuestions: ["Уточните, пожалуйста, модель автомобиля."],
        allowedFacts: {},
        allowedFinancialValues: [],
        requiredStatements: [],
        forbiddenStatements: [],
        language: "ru"
      })
    } as any;
    const validator = {
      validate: vi.fn().mockReturnValue({
        passed: true,
        errors: [],
        finalMessage: "Здравствуйте. Уточните модель автомобиля."
      })
    } as any;
    const settings = {
      getBusinessRuleSettings: vi.fn().mockResolvedValue({
        latestArrivalTime: "18:00",
        minimumLoan: 50000
      })
    } as any;
    const logs = {
      log: vi.fn(),
      debug: vi.fn(),
      error: vi.fn()
    } as any;

    const deferredIntegrations = {
      convertToSom: vi.fn()
    } as any;

    const service = new DialogueOrchestratorService(ai, store, responsePlan, validator, settings, logs, deferredIntegrations);

    const result = await service.receive({
      externalMessageId: "web-in-1",
      channel: "web-test",
      externalContactId: "web-client-1",
      externalConversationId: "web-conversation-1",
      text: "Здравствуйте",
      attachments: [],
      timestamp: new Date("2026-08-29T00:00:00.000Z")
    });

    expect(store.getConversation).toHaveBeenCalledWith("conv-1");
    expect(result.conversation.messages).toHaveLength(2);
    expect(result.conversation.messages[1]?.author).toBe("ai");
    expect(result.application.stage).toBe("COLLECTING_VEHICLE");
    expect(result.conversation.application?.id).toBe("app-1");
    expect(responsePlan.build).toHaveBeenCalledWith(expect.objectContaining({ isFirstMessage: true }));
  });

  it("merges facts extracted from attachments into the application update payload", async () => {
    const initialConversation = {
      id: "conv-1",
      externalContactId: "web-client-1",
      externalConversationId: "web-conversation-1",
      channel: "web-test",
      messages: [],
      application: undefined
    };
    const application = {
      id: "app-1",
      stage: "COLLECTING_DOCUMENTS",
      status: "need_more_data",
      facts: {},
      factHistory: [],
      contactId: "contact-1",
      conversationId: "conv-1"
    };
    const ai = {
      getProvider: () => ({
        extract: vi.fn().mockResolvedValue({
          language: "ru",
          intents: [],
          questions: [],
          facts: [],
          changedFacts: [],
          attachments: [],
          promptInjectionDetected: false,
          clarificationNeeded: false
        }),
        generateResponse: vi.fn().mockResolvedValue({
          message: "Пришлите, пожалуйста, обратную сторону ID.",
          model: "local-stage1-fallback",
          promptVersion: "stage1-local-v1"
        }),
        analyzeImage: vi.fn().mockResolvedValue({
          type: "id_front",
          quality: "good",
          extractedFacts: [{ key: "fullName", value: "Иванов Иван Иванович", confidence: 0.8 }]
        })
      })
    } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({
        conversation: initialConversation,
        application,
        isNew: false
      }),
      addMessage: vi
        .fn()
        .mockResolvedValueOnce({ id: "msg-client-1", createdAt: "2026-08-29T00:00:00.000Z" })
        .mockResolvedValueOnce({ id: "msg-ai-1", createdAt: "2026-08-29T00:00:01.000Z" }),
      createNewApplication: vi.fn(),
      updateFacts: vi.fn(),
      getApplication: vi
        .fn()
        .mockResolvedValueOnce({
          ...application,
          stage: "COLLECTING_DOCUMENTS",
          status: "need_more_data"
        })
        .mockResolvedValueOnce({
          ...application,
          stage: "COLLECTING_DOCUMENTS",
          status: "need_more_data",
          facts: {
            documents: { id_front: "received" },
            fullName: "Иванов Иван Иванович"
          }
        }),
      saveDecision: vi.fn(),
      addAttachment: vi.fn(),
      getConversation: vi.fn().mockResolvedValue({
        ...initialConversation,
        application: {
          ...application,
          facts: {
            documents: { id_front: "received" },
            fullName: "Иванов Иван Иванович"
          }
        }
      })
    } as any;
    const responsePlan = {
      build: vi.fn().mockReturnValue({
        answers: [],
        nextAction: "collect_documents",
        nextQuestions: ["Пришлите, пожалуйста, обратную сторону ID."],
        allowedFacts: {},
        allowedFinancialValues: [],
        requiredStatements: [],
        forbiddenStatements: [],
        language: "ru"
      })
    } as any;
    const validator = {
      validate: vi.fn().mockReturnValue({
        passed: true,
        errors: [],
        finalMessage: "Пришлите, пожалуйста, обратную сторону ID."
      })
    } as any;
    const settings = {
      getBusinessRuleSettings: vi.fn().mockResolvedValue({
        latestArrivalTime: "18:00",
        minimumLoan: 50000
      })
    } as any;
    const logs = {
      log: vi.fn(),
      debug: vi.fn(),
      error: vi.fn()
    } as any;

    const deferredIntegrations = {
      convertToSom: vi.fn()
    } as any;

    const service = new DialogueOrchestratorService(ai, store, responsePlan, validator, settings, logs, deferredIntegrations);

    await service.receive({
      externalMessageId: "web-in-1",
      channel: "web-test",
      externalContactId: "web-client-1",
      externalConversationId: "web-conversation-1",
      text: "",
      attachments: [{ id: "att-1", fileName: "passport-front.txt", mimeType: "text/plain", textContent: "ФИО: Иванов Иван Иванович" }],
      timestamp: new Date("2026-08-29T00:00:00.000Z")
    });

    expect(store.updateFacts).toHaveBeenCalledWith(
      application,
      expect.objectContaining({
        fullName: "Иванов Иван Иванович",
        documents: expect.objectContaining({ id_front: "received" })
      })
    );
  });

  it("passes a recovery hint when the client answered but the pending fact still was not resolved", async () => {
    const initialConversation = {
      id: "conv-1",
      externalContactId: "web-client-1",
      externalConversationId: "web-conversation-1",
      channel: "web-test",
      messages: [
        { id: "msg-ai-prev", author: "ai", body: "Какая прописка у собственника автомобиля?", createdAt: "2026-08-29T00:00:00.000Z", attachmentIds: [], attachments: [] }
      ],
      application: undefined
    };
    const application = {
      id: "app-1",
      stage: "COLLECTING_RESIDENCE",
      status: "need_more_data",
      facts: {
        vehicleMake: "Toyota",
        vehicleModel: "Camry",
        vehicleYear: 2021,
        vehicleValue: 1_500_000,
        requestedAmount: 500_000,
        requestedProgram: "without_storage"
      },
      decision: { requiredFacts: ["residenceRegion"] },
      factHistory: [],
      contactId: "contact-1",
      conversationId: "conv-1"
    };
    const ai = {
      getProvider: () => ({
        extract: vi.fn().mockResolvedValue({
          language: "ru",
          intents: [],
          questions: [],
          facts: [],
          changedFacts: [],
          attachments: [],
          promptInjectionDetected: false,
          clarificationNeeded: false
        }),
        generateResponse: vi.fn().mockResolvedValue({
          message: "Я не до конца поняла прописку. Уточните, пожалуйста, в каком городе или области прописан собственник автомобиля?",
          model: "local-stage1-fallback",
          promptVersion: "stage1-local-v1"
        }),
        analyzeImage: vi.fn()
      })
    } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({
        conversation: initialConversation,
        application,
        isNew: false
      }),
      addMessage: vi
        .fn()
        .mockResolvedValueOnce({ id: "msg-client-1", createdAt: "2026-08-29T00:00:01.000Z" })
        .mockResolvedValueOnce({ id: "msg-ai-1", createdAt: "2026-08-29T00:00:02.000Z" }),
      createNewApplication: vi.fn(),
      updateFacts: vi.fn().mockResolvedValue([]),
      getApplication: vi
        .fn()
        .mockResolvedValueOnce(application)
        .mockResolvedValueOnce({ ...application, decision: { ...application.decision, requiredFacts: ["residenceRegion"] } }),
      saveDecision: vi.fn(),
      addAttachment: vi.fn(),
      getConversation: vi.fn().mockResolvedValue({
        ...initialConversation,
        messages: [
          ...initialConversation.messages,
          { id: "msg-client-1", author: "client", body: "городская", createdAt: "2026-08-29T00:00:01.000Z", attachmentIds: [], attachments: [] },
          { id: "msg-ai-1", author: "ai", body: "Я не до конца поняла прописку. Уточните, пожалуйста, в каком городе или области прописан собственник автомобиля?", createdAt: "2026-08-29T00:00:02.000Z", attachmentIds: [], attachments: [] }
        ],
        application
      })
    } as any;
    const responsePlan = {
      build: vi.fn().mockReturnValue({
        answers: [],
        nextAction: "collect_residence",
        nextQuestions: ["Я не до конца поняла прописку. Уточните, пожалуйста, в каком городе или области прописан собственник автомобиля?"],
        allowedFacts: {},
        allowedFinancialValues: [],
        requiredStatements: [],
        forbiddenStatements: [],
        language: "ru",
        trace: {}
      })
    } as any;
    const validator = {
      validate: vi.fn().mockReturnValue({
        passed: true,
        errors: [],
        finalMessage: "Я не до конца поняла прописку. Уточните, пожалуйста, в каком городе или области прописан собственник автомобиля?"
      })
    } as any;
    const settings = {
      getBusinessRuleSettings: vi.fn().mockResolvedValue({
        latestArrivalTime: "18:00",
        minimumLoan: 50000
      })
    } as any;
    const logs = {
      log: vi.fn(),
      debug: vi.fn(),
      error: vi.fn()
    } as any;

    const deferredIntegrations = {
      convertToSom: vi.fn()
    } as any;

    const service = new DialogueOrchestratorService(ai, store, responsePlan, validator, settings, logs, deferredIntegrations);

    await service.receive({
      externalMessageId: "web-in-1",
      channel: "web-test",
      externalContactId: "web-client-1",
      externalConversationId: "web-conversation-1",
      text: "городская",
      attachments: [],
      timestamp: new Date("2026-08-29T00:00:01.000Z")
    });

    expect(responsePlan.build).toHaveBeenCalledWith(expect.objectContaining({
      recovery: {
        unresolvedFacts: ["residenceRegion"],
        reason: "unrecognized_reply"
      }
    }));
  });

  it("does not keep document recovery active after the dialogue legitimately moved to family status", async () => {
    const initialConversation = {
      id: "conv-1",
      externalContactId: "web-client-1",
      externalConversationId: "web-conversation-1",
      channel: "web-test",
      messages: [
        { id: "msg-ai-prev", author: "ai", body: "Пришлите, пожалуйста, фото документов.", createdAt: "2026-08-29T00:00:00.000Z", attachmentIds: [], attachments: [] }
      ],
      application: undefined
    };
    const application = {
      id: "app-1",
      stage: "COLLECTING_DOCUMENTS",
      status: "need_more_data",
      facts: {
        vehicleMake: "Toyota",
        vehicleModel: "Camry",
        vehicleYear: 2018,
        vehicleValue: 1_500_000,
        requestedAmount: 500_000,
        requestedProgram: "without_storage",
        residenceRegion: "Бишкек",
        residenceCategory: "BISHKEK"
      },
      decision: { requiredFacts: ["id_front", "id_back", "vehicle_registration_front", "vehicle_registration_back"] },
      factHistory: [],
      contactId: "contact-1",
      conversationId: "conv-1"
    };
    const ai = {
      getProvider: () => ({
        extract: vi.fn().mockResolvedValue({
          language: "ru",
          intents: [],
          questions: [],
          facts: [{ key: "declinedDocuments", value: true, confidence: 0.9 }],
          changedFacts: [{ key: "declinedDocuments", newValue: true }],
          attachments: [],
          promptInjectionDetected: false,
          clarificationNeeded: false
        }),
        generateResponse: vi.fn().mockResolvedValue({
          message: "Подскажите, пожалуйста, собственник автомобиля состоит в браке, никогда не состоял в браке или в разводе?",
          model: "stage1-response-plan-fast-path",
          promptVersion: "stage1-response-plan-v1"
        }),
        analyzeImage: vi.fn()
      })
    } as any;
    const updatedApplication = {
      ...application,
      stage: "COLLECTING_FAMILY_STATUS",
      status: "need_more_data",
      facts: {
        ...application.facts,
        declinedDocuments: true
      },
      decision: {
        requiredFacts: ["familyStatus"],
        stage: "COLLECTING_FAMILY_STATUS",
        status: "need_more_data",
        nextAction: "collect_family_status",
        blockedRules: [],
        rulesApplied: [],
        calculatedLimits: { withoutStorage: 600_000 },
        eligiblePrograms: ["without_storage"],
        requiredStatements: [],
        forbiddenStatements: []
      }
    };
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({
        conversation: initialConversation,
        application,
        isNew: false
      }),
      addMessage: vi
        .fn()
        .mockResolvedValueOnce({ id: "msg-client-1", createdAt: "2026-08-29T00:00:01.000Z" })
        .mockResolvedValueOnce({ id: "msg-ai-1", createdAt: "2026-08-29T00:00:02.000Z" }),
      createNewApplication: vi.fn(),
      updateFacts: vi.fn().mockResolvedValue(["declinedDocuments"]),
      getApplication: vi
        .fn()
        .mockResolvedValueOnce(updatedApplication)
        .mockResolvedValueOnce(updatedApplication),
      saveDecision: vi.fn(),
      addAttachment: vi.fn(),
      getConversation: vi.fn().mockResolvedValue({
        ...initialConversation,
        messages: [
          ...initialConversation.messages,
          { id: "msg-client-1", author: "client", body: "Не могу сейчас отправить фото документов", createdAt: "2026-08-29T00:00:01.000Z", attachmentIds: [], attachments: [] },
          { id: "msg-ai-1", author: "ai", body: "Подскажите, пожалуйста, собственник автомобиля состоит в браке, никогда не состоял в браке или в разводе?", createdAt: "2026-08-29T00:00:02.000Z", attachmentIds: [], attachments: [] }
        ],
        application: updatedApplication
      })
    } as any;
    const responsePlan = {
      build: vi.fn().mockReturnValue({
        answers: [],
        nextAction: "collect_family_status",
        nextQuestions: ["Подскажите, пожалуйста, собственник автомобиля состоит в браке, никогда не состоял в браке или в разводе?"],
        allowedFacts: {},
        allowedFinancialValues: [600_000],
        requiredStatements: [],
        forbiddenStatements: [],
        language: "ru",
        trace: {}
      })
    } as any;
    const validator = {
      validate: vi.fn().mockReturnValue({
        passed: true,
        errors: [],
        finalMessage: "Подскажите, пожалуйста, собственник автомобиля состоит в браке, никогда не состоял в браке или в разводе?"
      })
    } as any;
    const settings = {
      getBusinessRuleSettings: vi.fn().mockResolvedValue({
        latestArrivalTime: "18:00",
        minimumLoan: 50000
      })
    } as any;
    const logs = {
      log: vi.fn(),
      debug: vi.fn(),
      error: vi.fn()
    } as any;

    const deferredIntegrations = {
      convertToSom: vi.fn()
    } as any;

    const service = new DialogueOrchestratorService(ai, store, responsePlan, validator, settings, logs, deferredIntegrations);

    await service.receive({
      externalMessageId: "web-in-1",
      channel: "web-test",
      externalContactId: "web-client-1",
      externalConversationId: "web-conversation-1",
      text: "Не могу сейчас отправить фото документов",
      attachments: [],
      timestamp: new Date("2026-08-29T00:00:01.000Z")
    });

    expect(responsePlan.build).toHaveBeenCalledWith(expect.objectContaining({
      recovery: undefined
    }));
  });

  it("converts a foreign requested amount, avoids redundant recovery, and stores FX trace metadata", async () => {
    const initialConversation = {
      id: "conv-1",
      externalContactId: "web-client-1",
      externalConversationId: "web-conversation-1",
      channel: "web-test",
      messages: [],
      application: undefined
    };
    const application = {
      id: "app-1",
      stage: "COLLECTING_VEHICLE",
      status: "need_more_data",
      facts: {},
      factHistory: [],
      contactId: "contact-1",
      conversationId: "conv-1"
    };
    const ai = {
      getProvider: () => ({
        extract: vi.fn().mockResolvedValue({
          language: "ru",
          intents: [],
          questions: [],
          facts: [
            { key: "vehicleMake", value: "Toyota", confidence: 0.9 },
            { key: "vehicleModel", value: "Camry", confidence: 0.9 },
            { key: "vehicleYear", value: 2010, confidence: 0.9 },
            { key: "vehicleValue", value: 1_600_000, confidence: 0.9 }
          ],
          moneyMentions: [
            { sourceText: "10 тыс долларов", amount: 10_000, normalizedAmount: 10_000, currency: "USD", roleCandidate: "requestedAmount", confidence: 0.96, start: 28, end: 44 }
          ],
          changedFacts: [],
          attachments: [],
          promptInjectionDetected: false,
          clarificationNeeded: false
        }),
        generateResponse: vi.fn().mockResolvedValue({
          message: "По текущему курсу 10 тыс долларов — это ориентировочно 874 500 сом. Подскажите, пожалуйста, Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?",
          model: "stage1-response-plan-fast-path",
          promptVersion: "stage1-response-plan-v1"
        }),
        analyzeImage: vi.fn()
      })
    } as any;
    const updatedApplication = {
      ...application,
      facts: {
        vehicleMake: "Toyota",
        vehicleModel: "Camry",
        vehicleYear: 2010,
        vehicleValue: 1_600_000,
        requestedAmount: 874_500
      }
    };
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({
        conversation: initialConversation,
        application,
        isNew: false
      }),
      addMessage: vi
        .fn()
        .mockResolvedValueOnce({ id: "msg-client-1", createdAt: "2026-08-31T10:33:17.000Z" })
        .mockResolvedValueOnce({ id: "msg-ai-1", createdAt: "2026-08-31T10:33:57.000Z" }),
      createNewApplication: vi.fn(),
      updateFacts: vi.fn().mockResolvedValue(["vehicleMake", "vehicleModel", "vehicleYear", "vehicleValue", "requestedAmount"]),
      getApplication: vi
        .fn()
        .mockResolvedValueOnce(updatedApplication)
        .mockResolvedValueOnce({
          ...updatedApplication,
          decision: {
            requiredFacts: ["requestedProgram"]
          }
        }),
      saveDecision: vi.fn(),
      addAttachment: vi.fn(),
      getConversation: vi.fn().mockResolvedValue({
        ...initialConversation,
        messages: [
          { id: "msg-client-1", author: "client", body: "камри 2010 года надо 10 тыс долларов стоит 20 тыс", createdAt: "2026-08-31T10:33:17.000Z", attachmentIds: [], attachments: [] },
          { id: "msg-ai-1", author: "ai", body: "По текущему курсу 10 тыс долларов — это ориентировочно 874 500 сом. Подскажите, пожалуйста, Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?", createdAt: "2026-08-31T10:33:57.000Z", attachmentIds: [], attachments: [] }
        ],
        application: updatedApplication
      })
    } as any;
    const responsePlan = {
      build: vi.fn().mockReturnValue({
        answers: [{ topic: "fx_equivalent", meaning: "По текущему курсу 10 тыс долларов — это ориентировочно 874 500 сом.", exactText: "По текущему курсу 10 тыс долларов — это ориентировочно 874 500 сом." }],
        nextAction: "collect_residence",
        nextQuestions: ["Подскажите, пожалуйста, Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?"],
        allowedFacts: {},
        allowedFinancialValues: [],
        requiredStatements: [],
        forbiddenStatements: [],
        language: "ru",
        trace: { kbKeys: ["fx_equivalent"] }
      })
    } as any;
    const validator = {
      validate: vi.fn().mockReturnValue({
        passed: true,
        errors: [],
        finalMessage: "По текущему курсу 10 тыс долларов — это ориентировочно 874 500 сом. Подскажите, пожалуйста, Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?"
      })
    } as any;
    const settings = {
      getBusinessRuleSettings: vi.fn().mockResolvedValue({
        currentYear: 2026,
        latestArrivalTime: "18:00",
        minimumLoan: 50000
      })
    } as any;
    const logs = {
      log: vi.fn(),
      debug: vi.fn(),
      error: vi.fn()
    } as any;
    const deferredIntegrations = {
      convertToSom: vi.fn().mockResolvedValue({
        available: true,
        value: 874_500,
        currency: "USD",
        rate: 87.45,
        nominal: 1,
        source: "NBKR",
        sourceUrl: "https://www.nbkr.kg/XML/daily.xml",
        effectiveDate: "2026-08-31"
      })
    } as any;

    const service = new DialogueOrchestratorService(ai, store, responsePlan, validator, settings, logs, deferredIntegrations);

    await service.receive({
      externalMessageId: "web-in-1",
      channel: "web-test",
      externalContactId: "web-client-1",
      externalConversationId: "web-conversation-1",
      text: "камри 2010 года надо 10 тыс долларов стоит 20 тыс",
      attachments: [],
      timestamp: new Date("2026-08-31T10:33:17.000Z")
    });

    expect(deferredIntegrations.convertToSom).toHaveBeenCalledWith({ amount: 10_000, currency: "USD" });
    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({
      requestedAmount: 874_500
    }));
    expect(responsePlan.build).toHaveBeenCalledWith(expect.objectContaining({
      recovery: undefined,
      fxConversions: [expect.objectContaining({
        role: "requestedAmount",
        somValue: 874_500,
        source: "NBKR",
        effectiveDate: "2026-08-31"
      })]
    }));
    expect(store.addMessage).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      metadata: expect.objectContaining({
        trace: expect.objectContaining({
          moneyMentions: expect.arrayContaining([expect.objectContaining({ sourceText: "10 тыс долларов" })]),
          fxConversions: expect.arrayContaining([expect.objectContaining({ somValue: 874_500 })])
        })
      })
    }));
  });
});
