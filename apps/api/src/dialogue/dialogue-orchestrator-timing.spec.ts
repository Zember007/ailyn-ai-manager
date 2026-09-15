import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DialogueOrchestratorService } from "./dialogue-orchestrator.service.js";

describe("DialogueOrchestratorService timing logs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs the total duration, model, and successful outcome for a dialogue turn", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const application = { id: "application-1", facts: {}, contactId: "contact-1", stage: "COLLECTING_VALUE", status: "need_more_data" } as any;
    const conversation = { id: "conversation-1", messages: [], application, channel: "web-test" } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockResolvedValue({}),
      updateFacts: vi.fn().mockResolvedValue([]),
      saveAgentState: vi.fn().mockResolvedValue(undefined),
      getApplication: vi.fn().mockResolvedValue(application),
      getConversation: vi.fn().mockResolvedValue(conversation),
      addAttachment: vi.fn().mockResolvedValue(undefined),
      createManagerNotification: vi.fn().mockResolvedValue(false)
    } as any;
    const agent = {
      run: vi.fn().mockResolvedValue({
        result: {
          reply: "Подскажите, пожалуйста, модель автомобиля.",
          hasMoney: false,
          needsKnowledgeLookup: false,
          language: "ru",
          intent: "new_loan",
          loanQuestionKind: "none",
          leadCardPatch: {},
          cardSummary: "",
          dialogueState: { stage: "COLLECTING_VALUE", status: "need_more_data", nextAction: "continue_application" },
          targetEvent: null,
          managerUpdate: { kind: "none", changedFields: [] },
          attachments: []
        },
        reply: "Подскажите, пожалуйста, модель автомобиля.",
        model: "router-fast-model",
        promptVersion: "single-agent-v3"
      })
    } as any;
    const service = new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn().mockResolvedValue(undefined) } as any);

    await service.receiveBatch([{
      externalMessageId: "message-1",
      externalContactId: "contact-1",
      channel: "web-test",
      text: "Toyota Camry",
      attachments: [],
      timestamp: new Date("2026-09-15T10:00:00.000Z")
    }]);

    expect(log).toHaveBeenCalledWith("Dialogue turn finished", expect.objectContaining({
      event: "dialogue.turn",
      channel: "web-test",
      conversationId: "conversation-1",
      model: "router-fast-model",
      messageCount: 1,
      outcome: "success",
      durationMs: expect.any(Number)
    }));
  });

  it("logs the total duration when a dialogue turn fails before a model is selected", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const service = new DialogueOrchestratorService(
      {} as any,
      { getOrCreateConversation: vi.fn().mockRejectedValue(new Error("database unavailable")) } as any,
      {} as any,
      {} as any
    );

    await expect(service.receiveBatch([{
      externalMessageId: "message-1",
      externalContactId: "contact-1",
      channel: "web-test",
      text: "Toyota Camry",
      attachments: [],
      timestamp: new Date("2026-09-15T10:00:00.000Z")
    }])).rejects.toThrow("database unavailable");

    expect(log).toHaveBeenCalledWith("Dialogue turn finished", expect.objectContaining({
      event: "dialogue.turn",
      channel: "web-test",
      model: "not_reached",
      messageCount: 1,
      outcome: "error",
      durationMs: expect.any(Number),
      error: "Error: database unavailable"
    }));
  });
});
