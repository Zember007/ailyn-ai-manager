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

  it("starts the money normalizer and currency clarification concurrently", async () => {
    let resolveClassifier!: (value: { decision: "accept" }) => void;
    let resolveNormalizer!: (value: []) => void;
    const classifier = new Promise<{ decision: "accept" }>((resolve) => { resolveClassifier = resolve; });
    const normalizer = new Promise<[]>((resolve) => { resolveNormalizer = resolve; });
    const application = { id: "application-1", facts: {}, contactId: "contact-1", stage: "COLLECTING_AMOUNT", status: "need_more_data" } as any;
    const conversation = {
      id: "conversation-1",
      channel: "web-test",
      application,
      messages: [{ author: "ai", body: "Какая сумма займа Вам необходима? Вы имели в виду 500 долларов, верно?", createdAt: "now" }]
    } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockResolvedValue({}), updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(),
      getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation),
      addAttachment: vi.fn(), createManagerNotification: vi.fn()
    } as any;
    const agent = {
      classifyPendingMoneyClarification: vi.fn().mockReturnValue(classifier),
      normalizeMoney: vi.fn().mockReturnValue(normalizer),
      run: vi.fn().mockResolvedValue({
        result: {
          reply: "Распознано.", hasMoney: true, needsKnowledgeLookup: false, language: "ru", intent: "new_loan", loanQuestionKind: "none",
          leadCardPatch: {}, cardSummary: "", dialogueState: { stage: "COLLECTING_AMOUNT", status: "need_more_data", nextAction: "continue" },
          targetEvent: null, managerUpdate: { kind: "none", changedFields: [] }, attachments: []
        }, reply: "Распознано.", model: "router-fast-model", promptVersion: "single-agent-v3"
      })
    } as any;
    const service = new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn().mockResolvedValue(undefined) } as any);

    const result = service.receiveBatch([{
      externalMessageId: "message-1", externalContactId: "contact-1", channel: "web-test", text: "долларов", attachments: [], timestamp: new Date()
    }]);

    await vi.waitFor(() => {
      expect(agent.classifyPendingMoneyClarification).toHaveBeenCalledOnce();
      expect(agent.normalizeMoney).toHaveBeenCalledOnce();
    });
    expect(agent.run).not.toHaveBeenCalled();

    resolveClassifier({ decision: "accept" });
    resolveNormalizer([]);
    await result;
  });

  it("uses the knowledge router and skips the full KB call for a routine turn", async () => {
    let resolveMain!: (value: any) => void;
    const mainTurn = new Promise<any>((resolve) => { resolveMain = resolve; });
    const application = { id: "application-1", facts: {}, contactId: "contact-1", stage: "COLLECTING_VALUE", status: "need_more_data" } as any;
    const conversation = { id: "conversation-1", channel: "web-test", application, messages: [] } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockResolvedValue({}), updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(),
      getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation),
      addAttachment: vi.fn(), createManagerNotification: vi.fn()
    } as any;
    const agent = {
      run: vi.fn().mockReturnValue(mainTurn),
      shouldLookupKnowledge: vi.fn().mockResolvedValue(false),
      answerWithKnowledge: vi.fn().mockResolvedValue({ reply: "", answerFound: false, model: "knowledge-model" })
    } as any;
    const service = new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn().mockResolvedValue(undefined) } as any);

    const result = service.receiveBatch([{
      externalMessageId: "message-1", externalContactId: "contact-1", channel: "web-test", text: "Здравствуйте", attachments: [], timestamp: new Date()
    }]);

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalledOnce();
      expect(agent.shouldLookupKnowledge).toHaveBeenCalledOnce();
    });
    expect(agent.answerWithKnowledge).not.toHaveBeenCalled();

    resolveMain({
      result: {
        reply: "Подскажите, пожалуйста, модель автомобиля.", hasMoney: false, needsKnowledgeLookup: false, language: "ru", intent: "new_loan", loanQuestionKind: "none",
        leadCardPatch: {}, cardSummary: "", dialogueState: { stage: "COLLECTING_VALUE", status: "need_more_data", nextAction: "continue" },
        targetEvent: null, managerUpdate: { kind: "none", changedFields: [] }, attachments: []
      }, reply: "Подскажите, пожалуйста, модель автомобиля.", model: "router-fast-model", promptVersion: "single-agent-v3"
    });
    await result;

    expect(agent.answerWithKnowledge).not.toHaveBeenCalled();
  });

  it("calls the full KB once only after the router selects a question", async () => {
    const application = { id: "application-1", facts: {}, contactId: "contact-1", stage: "COLLECTING_VALUE", status: "need_more_data" } as any;
    const conversation = { id: "conversation-1", channel: "web-test", application, messages: [] } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockResolvedValue({}), updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(),
      getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation),
      addAttachment: vi.fn(), createManagerNotification: vi.fn()
    } as any;
    const agent = {
      shouldLookupKnowledge: vi.fn().mockResolvedValue(true),
      answerWithKnowledge: vi.fn().mockResolvedValue({ reply: "Да, для посетителей доступен Wi‑Fi.", answerFound: true, questionUnderstood: true, shouldUseReply: true, model: "knowledge-model" }),
      run: vi.fn().mockResolvedValue({
        result: {
          reply: "Подскажите, пожалуйста, модель автомобиля.", hasMoney: false, needsKnowledgeLookup: false, language: "ru", intent: "new_loan", loanQuestionKind: "none",
          leadCardPatch: {}, cardSummary: "", dialogueState: { stage: "COLLECTING_VALUE", status: "need_more_data", nextAction: "continue" },
          targetEvent: null, managerUpdate: { kind: "none", changedFields: [] }, attachments: []
        }, reply: "Подскажите, пожалуйста, модель автомобиля.", model: "router-fast-model", promptVersion: "single-agent-v4"
      })
    } as any;
    const service = new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn().mockResolvedValue(undefined) } as any);

    await service.receiveBatch([{
      externalMessageId: "message-1", externalContactId: "contact-1", channel: "web-test", text: "Wi-Fi есть?", attachments: [], timestamp: new Date()
    }]);

    expect(agent.shouldLookupKnowledge).toHaveBeenCalledOnce();
    expect(agent.answerWithKnowledge).toHaveBeenCalledOnce();
  });

  it("does not run the money normalizer for a bare year after the active year question", async () => {
    const application = { id: "application-1", facts: {}, contactId: "contact-1", stage: "COLLECTING_VEHICLE", status: "need_more_data" } as any;
    const conversation = {
      id: "conversation-1", channel: "web-test", application,
      messages: [
        { author: "ai", body: "Какая сумма займа Вам необходима?", createdAt: "earlier" },
        { author: "ai", body: "2028 год ещё не наступил. Уточните, пожалуйста, верный год выпуска автомобиля.", createdAt: "now" }
      ]
    } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockResolvedValue({}), updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(),
      getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation),
      addAttachment: vi.fn(), createManagerNotification: vi.fn()
    } as any;
    const agent = {
      normalizeMoney: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue({
        result: {
          reply: "Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?", hasMoney: false, needsKnowledgeLookup: false, language: "ru", intent: "new_loan", loanQuestionKind: "none",
          leadCardPatch: { vehicleYear: 2020 }, cardSummary: "", dialogueState: { stage: "ELIGIBILITY_CHECK", status: "need_more_data", nextAction: "continue" },
          targetEvent: null, managerUpdate: { kind: "none", changedFields: [] }, attachments: []
        }, reply: "Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?", model: "router-fast-model", promptVersion: "single-agent-v3"
      })
    } as any;
    const service = new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn().mockResolvedValue(undefined) } as any);

    await service.receiveBatch([{
      externalMessageId: "message-1", externalContactId: "contact-1", channel: "web-test", text: "2020", attachments: [], timestamp: new Date()
    }]);

    expect(agent.normalizeMoney).not.toHaveBeenCalled();
  });

  it("never invokes knowledge twice when this turn changes lead facts", async () => {
    const application = { id: "application-1", facts: { reportedInvalidVehicleYear: 2028 }, contactId: "contact-1", stage: "COLLECTING_VEHICLE", status: "need_more_data" } as any;
    const conversation = {
      id: "conversation-1", channel: "web-test", application,
      messages: [{ author: "ai", body: "2028 год ещё не наступил. Уточните, пожалуйста, верный год выпуска автомобиля.", createdAt: "now" }]
    } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockResolvedValue({}), updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(),
      getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation),
      addAttachment: vi.fn(), createManagerNotification: vi.fn()
    } as any;
    const agent = {
      run: vi.fn().mockResolvedValue({
        result: {
          reply: "Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?", hasMoney: false, needsKnowledgeLookup: false, language: "ru", intent: "new_loan", loanQuestionKind: "none",
          leadCardPatch: { vehicleYear: 2020, reportedInvalidVehicleYear: null }, cardSummary: "", dialogueState: { stage: "ELIGIBILITY_CHECK", status: "need_more_data", nextAction: "continue" },
          targetEvent: null, managerUpdate: { kind: "none", changedFields: [] }, attachments: []
        }, reply: "Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?", model: "router-fast-model", promptVersion: "single-agent-v3"
      }),
      shouldLookupKnowledge: vi.fn().mockResolvedValue(false),
      answerWithKnowledge: vi.fn().mockResolvedValue({ reply: "", answerFound: false, model: "knowledge-model" })
    } as any;
    const service = new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn().mockResolvedValue(undefined) } as any);

    await service.receiveBatch([{
      externalMessageId: "message-1", externalContactId: "contact-1", channel: "web-test", text: "2020", attachments: [], timestamp: new Date()
    }]);

    expect(agent.shouldLookupKnowledge).toHaveBeenCalledOnce();
    expect(agent.answerWithKnowledge).not.toHaveBeenCalled();
  });
});
