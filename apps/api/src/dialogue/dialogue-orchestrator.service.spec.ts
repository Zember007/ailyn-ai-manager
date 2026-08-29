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

    const service = new DialogueOrchestratorService(ai, store, responsePlan, validator, settings, logs);

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
  });
});
