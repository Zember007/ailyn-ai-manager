import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AgentTurnService, OLDER_VEHICLE_PROGRAM_NOTICE } from "./agent-turn.service.js";
import { agentStageInstructions } from "./agent-stage-instructions.js";
import { DialogueOrchestratorService, composeReply, resolveForeignCurrencyFacts, resolveNormalizedMoneyFacts } from "./dialogue-orchestrator.service.js";
import { generatedDocumentationChunks } from "./documentation-chunks.generated.js";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
process.env.REDIS_URL ??= "redis://localhost:6379";

const validResult = {
  reply: "Подскажите, пожалуйста, модель и год выпуска автомобиля.", hasMoney: false, needsKnowledgeLookup: false, language: "ru", intent: "new_loan", leadCardPatch: { vehicleMake: "Toyota", vehicleYear: 2020 }, cardSummary: "Toyota 2020, ожидаются остальные данные.",
  dialogueState: { stage: "COLLECTING_VALUE", status: "need_more_data", nextAction: "Запросить стоимость" }, targetEvent: null,
  managerUpdate: { kind: "none", changedFields: [] }, attachments: []
};
const firstContactGreeting = "Здравствуйте! Меня зовут Айлин. Я менеджер по оформлению новых займов автоломбарда «Молодой». Информируем Вас, что мы не выдаем займ под залог автомобиля с регионом 10.";
const withFirstContactGreeting = (reply: string) => `${firstContactGreeting}\n\n${reply}`;
const vehicleStageQuestion = "Подскажите, пожалуйста, модель и год выпуска автомобиля и ориентировочную стоимость автомобиля.";
const amountStageQuestion = "Какая сумма займа Вам необходима?";

async function runMockedBatchedAgentTurn(input: { facts: Record<string, unknown>; texts: string[]; result: any }) {
  const application = { id: "app", facts: input.facts, contactId: "contact", stage: "COLLECTING_DOCUMENTS", status: "need_more_data" } as any;
  const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
  const store = {
    getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
    addMessage: vi.fn().mockImplementation(async (_conversation: unknown, message: any) => ({ id: message.metadata.externalMessageId, author: message.author, body: message.body, createdAt: "now" })),
    updateFacts: vi.fn().mockResolvedValue(Object.keys(input.result.leadCardPatch)),
    saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn()
  } as any;
  const agent = { run: vi.fn().mockResolvedValue({ result: input.result, reply: input.result.reply, model: "one", promptVersion: "v1" }) } as any;
  const output = await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
    .receiveBatch(input.texts.map((text, index) => ({ externalMessageId: `message-${index + 1}`, channel: "web-test", externalContactId: "c", text, attachments: [], timestamp: new Date("2026-09-05T12:00:00.000Z") })));

  expect(agent.run).toHaveBeenCalledTimes(1);
  expect(agent.run).toHaveBeenCalledWith(expect.objectContaining({
    text: input.texts.join("\n"),
    currentTurnMessages: input.texts.map((text, index) => ({ index: index + 1, text }))
  }));
  expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ ...input.facts, ...input.result.leadCardPatch, language: input.result.language }));
  expect(store.addMessage).toHaveBeenLastCalledWith(conversation, expect.objectContaining({ author: "ai", body: input.result.reply }));
  expect(output.reply).toBe(input.result.reply);
  return { agent, store, output };
}

describe("single-agent dialogue", () => {
  it("does not append a programme question while a currency clarification is pending", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "10 тысяч сом, верно?",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Какая сумма займа Вам необходима?", createdAt: "now" } as any],
      facts: { vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 2_360_000 } as any,
      settings: {}, text: "тысяч 10", attachments: []
    });

    expect(output.reply).toBe("10 тысяч сом, верно?");
    expect(output.reply).not.toContain("Вас интересует займ без изъятия");
  });

  it("announces the residence limit once before the guarantor question", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Каракол — это другой регион Кыргызстана.",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.", createdAt: "now" } as any],
      facts: { vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 2_360_000, requestedAmount: 100_000, requestedProgram: "without_storage" } as any,
      settings: {}, text: "каракол", attachments: []
    });

    expect(output.reply).toContain("В связи с тем, что Вы прописаны за пределами Чуйской области, по программе без изъятия Вам доступно до 200 000 сом.");
    expect(output.reply).toContain("И Вам потребуется поручитель:");
    expect(output.reply.match(/по программе без изъятия[^.]*до 200 000 сом/giu)).toHaveLength(1);
  });

  it("uses a dedicated model to classify money clarification agreement, currency, and rejection", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ decision: "accept", currency: "USD" }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ decision: "reject", currency: null }) } }] }) } as any;
    const service = new AgentTurnService(client);
    const messages = [{ author: "ai", body: "10 тысяч сом, верно?", createdAt: "now" }] as any;

    await expect(service.classifyPendingMoneyClarification({ text: "долларов", messages })).resolves.toEqual({ decision: "accept", currency: "USD" });
    await expect(service.classifyPendingMoneyClarification({ text: "нет", messages })).resolves.toEqual({ decision: "reject" });
    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("does not classify an ordinary amount question after a foreign-currency vehicle price", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn() } as any;
    const result = await new AgentTurnService(client).classifyPendingMoneyClarification({
      text: "тысяч 10",
      messages: [{ author: "ai", body: "По текущему курсу НБКР: стоимость автомобиля 27 000 долларов США — 2 360 000 сом. Какая сумма займа Вам необходима?", createdAt: "now" } as any]
    });

    expect(result).toBeUndefined();
    expect(client.createChatCompletion).not.toHaveBeenCalled();
    expect(agentStageInstructions.application).toContain("10 000 сом, верно?");
  });

  it("does not accept a classifier-invented currency for a plain confirmation", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ decision: "accept", currency: "KZT" }) } }] }) } as any;
    const result = await new AgentTurnService(client).classifyPendingMoneyClarification({
      text: "да",
      messages: [{ author: "ai", body: "15 000 сом, верно?", createdAt: "now" } as any]
    });

    expect(result).toEqual({ decision: "accept" });
  });

  it("asks for the amount again when the money clarification model rejects it", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(validResult) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "10 тысяч сом, верно?", createdAt: "now" } as any],
      facts: { vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 2_360_000 } as any,
      settings: {}, text: "нет", moneyClarificationDecision: "reject", attachments: []
    });

    expect(output.reply).toBe("Минимальная сумма займа — 50 000 сом. Назовите, пожалуйста, сумму не меньше 50 000 сом.");
    expect(output.reply).not.toContain("Вас интересует займ без изъятия");
  });

  it("uses the money clarification classifier currency before asking for a programme", async () => {
    const application = { id: "app", facts: { vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 2_360_000 }, contactId: "contact", stage: "COLLECTING_PROGRAM", status: "need_more_data" } as any;
    const conversation = {
      id: "conversation", application, channel: "web-test",
      messages: [
        { author: "ai", body: "Какая сумма займа Вам необходима?", createdAt: "one" },
        { author: "client", body: "тысяч 10", createdAt: "two" },
        { author: "ai", body: "10 тысяч сом, верно?", createdAt: "three" }
      ]
    } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockResolvedValue({ id: "message", author: "client", body: "долларов", createdAt: "now" }),
      updateFacts: vi.fn().mockResolvedValue(["requestedAmount"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application),
      getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn()
    } as any;
    const agent = {
      classifyPendingMoneyClarification: vi.fn().mockResolvedValue({ decision: "accept", currency: "USD" }),
      normalizeMoney: vi.fn().mockResolvedValue([{ field: "requestedAmount", amount: 10_000, currency: "KGS", confidence: 0.99 }]),
      run: vi.fn().mockResolvedValue({ result: { ...validResult, reply: "Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?", leadCardPatch: {} }, reply: "Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?", model: "one", promptVersion: "v1" })
    } as any;
    const integrations = { convertToSom: vi.fn().mockResolvedValue({ available: true, value: 870_000, currency: "USD", rate: 87, nominal: 1, source: "NBKR", effectiveDate: "2026-09-09" }) } as any;

    const output = await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any, integrations)
      .receive({ externalMessageId: "currency", channel: "web-test", externalContactId: "contact", text: "долларов", attachments: [], timestamp: new Date() });

    expect(agent.classifyPendingMoneyClarification).toHaveBeenCalledTimes(1);
    expect(agent.normalizeMoney).toHaveBeenCalledTimes(1);
    expect(agent.run).toHaveBeenCalledWith(expect.objectContaining({
      facts: expect.objectContaining({ requestedAmount: 870_000, requestedAmountSourceCurrency: "USD" }),
      currencyConversions: [expect.objectContaining({ role: "requestedAmount", amount: 10_000, currency: "USD", somValue: 870_000 })]
    }));
    expect(output.reply).toContain("Необходимая сумма займа: 10 000 долларов США — ориентировочно 870 000 сом.");
    expect(output.reply).toContain("Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?");
  });

  it("assigns a bare amount to the requested loan after the amount question and rejects zero or a fabricated programme", async () => {
    const application = { id: "app", facts: { vehicleModel: "Camry", vehicleYear: 2015, vehicleValue: 1_740_000 }, contactId: "contact" } as any;
    const conversation = {
      id: "conversation", application, channel: "web-test",
      messages: [{ author: "ai", body: "Какая сумма займа Вам необходима?", createdAt: "before" }]
    } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockResolvedValue({ id: "m", author: "client", body: "5 тыщ", createdAt: "now" }),
      updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application),
      getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn()
    } as any;
    const agent = {
      normalizeMoney: vi.fn().mockResolvedValue([{ field: "vehicleValue", amount: 0, currency: "KGS", confidence: 1 }]),
      run: vi.fn().mockResolvedValue({ result: validResult, reply: validResult.reply, model: "workflow", promptVersion: "v1" })
    } as any;
    const service = new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any);

    await service.receive({ externalMessageId: "m", channel: "web-test", externalContactId: "contact", text: "5 тыщ", attachments: [], timestamp: new Date() });

    expect(agent.run).toHaveBeenCalledWith(expect.objectContaining({
      facts: expect.objectContaining({ requestedAmount: 5_000, vehicleValue: 1_740_000 })
    }));
    expect(agent.run.mock.calls[0][0].facts.requestedProgram).toBeUndefined();
  });

  it("generates and stores one private complete-dialogue summary after the visit is booked", async () => {
    // Booking itself, rather than the completion of every optional workflow
    // stage, is the summary trigger.
    const facts = {} as any;
    const application = { id: "app", facts, contactId: "contact", stage: "SCHEDULING_VISIT", status: "need_more_data" } as any;
    const conversation = {
      id: "conversation", contactId: "contact", channel: "web-test", application,
      messages: [{ id: "old-client", author: "client", body: "Camry 2022", attachmentIds: [], attachments: [], createdAt: "before" }]
    } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockResolvedValue({ id: "message", author: "ai", body: "saved", createdAt: "now" }),
      updateFacts: vi.fn().mockImplementation(async (_application: any, patch: any) => {
        application.facts = { ...application.facts, ...patch };
        return Object.keys(patch);
      }),
      saveAgentState: vi.fn(), getApplication: vi.fn().mockImplementation(async () => application),
      getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn(),
      claimDialogueSummaryGeneration: vi.fn().mockResolvedValue(true),
      saveDialogueSummary: vi.fn().mockImplementation(async (_id: string, summary: string) => { application.dialogueSummary = summary; })
    } as any;
    const agent = {
      run: vi.fn().mockResolvedValue({
        result: { ...validResult, reply: "Запись предварительная.", leadCardPatch: { visitRequested: true, visitDate: "2026-09-09", visitTime: "17:00" }, targetEvent: "visit" },
        reply: "Запись предварительная.", model: "workflow", promptVersion: "v1"
      }),
      summarizeBookedDialogue: vi.fn().mockResolvedValue("Camry 2022; запись на 09.09 в 17:00.")
    } as any;
    const service = new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any);
    const inbound = { externalMessageId: "visit", channel: "web-test", externalContactId: "contact", externalConversationId: "conversation", text: "завтра в 5", attachments: [], timestamp: new Date("2026-09-08T12:00:00.000Z") } as any;

    const first = await service.receive(inbound);
    await service.receive({ ...inbound, externalMessageId: "after-visit", text: "спасибо" });

    expect(agent.summarizeBookedDialogue).toHaveBeenCalledTimes(1);
    expect(agent.summarizeBookedDialogue).toHaveBeenCalledWith(expect.objectContaining({
      facts: expect.not.objectContaining({ dialogueSummary: expect.anything() }),
      messages: expect.arrayContaining([
        expect.objectContaining({ author: "client", body: "Camry 2022" }),
        expect.objectContaining({ author: "client", body: "завтра в 5" }),
        expect.objectContaining({ author: "ai", body: expect.stringContaining("Запись") })
      ])
    }));
    expect(store.claimDialogueSummaryGeneration).toHaveBeenCalledTimes(1);
    expect(store.saveDialogueSummary).toHaveBeenCalledWith("app", "Camry 2022; запись на 09.09 в 17:00.");
    expect(first.application.dialogueSummary).toBe("Camry 2022; запись на 09.09 в 17:00.");
  });

  it("passes the ordered batch and deterministic pricing to the agent", async () => {
    const application = { id: "app", facts: { vehicleValue: 1_900_000, residenceRegion: "Бишкек" }, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockImplementation(async (_conversation: unknown, message: any) => ({ id: message.metadata.externalMessageId, author: "client", body: message.body, createdAt: "now" })), updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const agent = { run: vi.fn().mockResolvedValue({ result: validResult, reply: validResult.reply, model: "one", promptVersion: "v1" }) } as any;

    await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receiveBatch([
        { externalMessageId: "one", channel: "web-test", externalContactId: "c", text: "Камри", attachments: [], timestamp: new Date() },
        { externalMessageId: "two", channel: "web-test", externalContactId: "c", text: "2022 года", attachments: [], timestamp: new Date() },
        { externalMessageId: "three", channel: "web-test", externalContactId: "c", attachments: [], timestamp: new Date() }
      ]);

    expect(agent.run).toHaveBeenCalledWith(expect.objectContaining({
      text: "Камри\n2022 года",
      currentTurnMessages: [{ index: 1, text: "Камри" }, { index: 2, text: "2022 года" }, { index: 3, text: "" }],
      pricing: expect.objectContaining({ minimumLoan: 50_000, clientFacingMaximumField: "publicMax", withoutStorage: { available: true, rawMax: 600_000, publicMax: 600_000 } })
    }));
  });

  it("persists every model state-patch fact from a batched turn", async () => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockImplementation(async (_conversation: unknown, message: any) => ({ id: message.metadata.externalMessageId, author: "client", body: message.body, createdAt: "now" })), updateFacts: vi.fn().mockResolvedValue(["vehicleMake", "vehicleYear", "requestedProgram"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const modelResult = { ...validResult, leadCardPatch: { vehicleMake: "Toyota", vehicleYear: 2022, requestedProgram: "parking" as const } };
    const agent = { run: vi.fn().mockResolvedValue({ result: modelResult, reply: modelResult.reply, model: "one", promptVersion: "v1" }) } as any;

    await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receiveBatch([
        { externalMessageId: "one", channel: "web-test", externalContactId: "c", text: "Toyota", attachments: [], timestamp: new Date() },
        { externalMessageId: "two", channel: "web-test", externalContactId: "c", text: "2022", attachments: [], timestamp: new Date() },
        { externalMessageId: "three", channel: "web-test", externalContactId: "c", text: "со стоянкой", attachments: [], timestamp: new Date() }
      ]);

    expect(agent.run).toHaveBeenCalledWith(expect.objectContaining({ currentTurnMessages: [{ index: 1, text: "Toyota" }, { index: 2, text: "2022" }, { index: 3, text: "со стоянкой" }] }));
    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ vehicleMake: "Toyota", vehicleYear: 2022, requestedProgram: "parking" }));
  });

  it("A: answers the parking question and persists the parking-program switch from one ordered batch", async () => {
    const result = {
      ...validResult,
      reply: "По программе со стоянкой ставка составляет 2,4% в месяц, а хранение — 130 сом в день.",
      leadCardPatch: { requestedProgram: "parking" as const }
    };

    const { store } = await runMockedBatchedAgentTurn({
      facts: { vehicleMake: "Toyota", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "without_storage", residenceRegion: "Бишкек" },
      texts: ["Какая ставка и сколько стоит стоянка?", "Тогда выбираю программу со стоянкой."],
      result
    });

    expect(result.reply).toContain("2,4%");
    expect(result.reply).toContain("130 сом");
    expect(store.updateFacts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestedProgram: "parking" }));
  });

  it("B: keeps both answers from two client questions in the single agent reply", async () => {
    const result = {
      ...validResult,
      reply: "По программе без изъятия предварительно доступно до 600 000 сом, срок займа — до 12 месяцев.",
      leadCardPatch: {}
    };

    await runMockedBatchedAgentTurn({
      facts: { vehicleMake: "Toyota", vehicleYear: 2022, vehicleValue: 1_500_000, requestedAmount: 300_000, requestedProgram: "without_storage", residenceRegion: "Бишкек" },
      texts: ["Какая максимальная сумма?", "А какой максимальный срок?"],
      result
    });

    expect(result.reply).toContain("600 000 сом");
    expect(result.reply).toContain("12 месяцев");
  });

  it("C: answers the rate question and persists the agent's 400k amount correction", async () => {
    const result = {
      ...validResult,
      reply: "Ставка по программе со стоянкой составляет 2,4% в месяц. Исправила необходимую сумму на 400 000 сом.",
      leadCardPatch: { requestedAmount: 400_000 }
    };

    const { store } = await runMockedBatchedAgentTurn({
      facts: { vehicleMake: "Toyota", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "parking", residenceRegion: "Бишкек" },
      texts: ["Какая ставка по займу?", "Исправьте сумму: нужно 400 000 сом."],
      result
    });

    expect(result.reply).toContain("2,4%");
    expect(result.reply).toContain("400 000 сом");
    expect(store.updateFacts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestedAmount: 400_000 }));
  });

  it("D: answers the documents question and persists the agent's married family correction", async () => {
    const result = {
      ...validResult,
      reply: "Для оформления нужны фото ID и свидетельства о регистрации ТС с обеих сторон. Отметила, что Вы состоите в браке.",
      leadCardPatch: { familyStatus: "married" as const }
    };

    const { store } = await runMockedBatchedAgentTurn({
      facts: { vehicleMake: "Toyota", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "parking", residenceRegion: "Бишкек" },
      texts: ["Какие документы нужно отправить?", "Исправьте семейное положение: я в браке."],
      result
    });

    expect(result.reply).toContain("ID");
    expect(result.reply).toContain("свидетельства о регистрации ТС");
    expect(store.updateFacts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ familyStatus: "married" }));
  });

  it("E: persists all three agent-led changes from the ordered batch", async () => {
    const result = {
      ...validResult,
      reply: "Обновила сумму, программу и семейное положение. Продолжим оформление по программе со стоянкой.",
      leadCardPatch: { requestedAmount: 450_000, requestedProgram: "parking" as const, familyStatus: "married" as const }
    };

    const { store } = await runMockedBatchedAgentTurn({
      facts: { vehicleMake: "Toyota", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "without_storage", residenceRegion: "Бишкек", familyStatus: "single" },
      texts: ["Нужно 450 000 сом.", "Выбираю программу со стоянкой.", "И я состою в браке."],
      result
    });

    expect(store.updateFacts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestedAmount: 450_000, requestedProgram: "parking", familyStatus: "married" }));
  });

  it("F: keeps without_storage when parking is hypothetical and the final message selects without_storage", async () => {
    const result = {
      ...validResult,
      reply: "По программе со стоянкой предварительно доступно больше, но для заявки оставляю выбранной программу без изъятия.",
      leadCardPatch: { requestedProgram: "without_storage" as const }
    };

    const { store } = await runMockedBatchedAgentTurn({
      facts: { vehicleMake: "Toyota", vehicleYear: 2022, vehicleValue: 1_500_000, requestedAmount: 300_000, requestedProgram: "parking", residenceRegion: "Бишкек" },
      texts: ["А если выбрать программу со стоянкой, сколько будет доступно?", "Но окончательно оставляю без изъятия."],
      result
    });

    expect(result.reply).toContain("со стоянкой");
    expect(store.updateFacts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestedProgram: "without_storage" }));
  });

  it("persists the model dialogue state without stage correction", async () => {
    const application = { id: "app", facts: { vehicleMake: "Toyota", vehicleYear: 2020, vehicleValue: 1_000_000 }, contactId: "contact", stage: "COLLECTING_VALUE", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "message", author: "client", body: "", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const modelResult = { ...validResult, reply: "Модельный ответ остаётся без шаблонной замены.", leadCardPatch: {}, dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "continue" as const, nextAction: "request_documents" } };
    const agent = { run: vi.fn().mockResolvedValue({ result: modelResult, reply: modelResult.reply, model: "one", promptVersion: "v1" }) } as any;

    await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "one", channel: "web-test", externalContactId: "c", text: "", attachments: [], timestamp: new Date() });

    expect(store.saveAgentState).toHaveBeenCalledWith(application, expect.objectContaining(modelResult.dialogueState));
    expect(store.addMessage).toHaveBeenLastCalledWith(conversation, expect.objectContaining({ author: "ai", body: modelResult.reply }));
  });

  it("normalizes explicit foreign currency before the dialogue agent", async () => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "нужно 6к долларов", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue(["requestedAmount"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const agent = {
      run: vi.fn().mockResolvedValue({ result: { ...validResult, hasMoney: false, leadCardPatch: {} }, reply: "Подскажите стоимость автомобиля.", model: "one", promptVersion: "v1" }),
      normalizeMoney: vi.fn().mockResolvedValue([{ field: "requestedAmount", amount: 6_000, currency: "USD", confidence: 0.99 }])
    } as any;
    const integrations = { convertToSom: vi.fn().mockResolvedValue({ available: true, value: 524_700, currency: "USD", rate: 87.45, nominal: 1, source: "NBKR", effectiveDate: "2026-09-04" }) } as any;

    await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any, integrations)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "нужно 6к долларов", attachments: [], timestamp: new Date() });

    expect(agent.normalizeMoney).toHaveBeenCalledTimes(1);
    expect(agent.normalizeMoney.mock.invocationCallOrder[0]).toBeLessThan(agent.run.mock.invocationCallOrder[0]);
    expect(agent.run).toHaveBeenCalledWith(expect.objectContaining({
      facts: expect.objectContaining({ requestedAmount: 520_000, requestedAmountSourceCurrency: "USD" }),
      currencyConversions: [expect.objectContaining({ currency: "USD", somValue: 520_000 })]
    }));
    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ requestedAmount: 520_000, requestedAmountSourceCurrency: "USD" }));
  });

  it("converts a corrected foreign vehicle price with a conversational typo", async () => {
    const application = { id: "app", facts: { vehicleValue: 2_000_000, requestedAmount: 1_000_000, vehicleModel: "Camry", vehicleYear: 2022, requestedProgram: "without_storage" }, contactId: "contact", stage: "COLLECTING_RESIDENCE", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue(["vehicleValue"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const agent = { run: vi.fn().mockResolvedValue({ result: { ...validResult, hasMoney: true, leadCardPatch: { vehicleValue: 2_000_000 } }, reply: "Подскажите, пожалуйста, сколько ориентировочно стоит автомобиль в сомах?", model: "one", promptVersion: "v1" }), normalizeMoney: vi.fn().mockResolvedValue([]) } as any;
    const integrations = { convertToSom: vi.fn().mockResolvedValue({ available: true, value: 1_748_000, currency: "USD", rate: 87.4, nominal: 1, source: "NBKR", effectiveDate: "2026-09-07" }) } as any;

    await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any, integrations)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "А вообще стоймость немного перепутал, наверно 20к долларов", attachments: [], timestamp: new Date() });

    expect(agent.normalizeMoney).toHaveBeenCalledTimes(1);
    expect(integrations.convertToSom).toHaveBeenCalledWith({ amount: 20_000, currency: "USD" });
    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ vehicleValue: 1_740_000, vehicleValueSourceCurrency: "USD" }));
  });

  it("converts a foreign amount after the client confirms the preceding role clarification", async () => {
    const application = { id: "app", facts: { vehicleModel: "Camry", vehicleYear: 2022 }, contactId: "contact", stage: "COLLECTING_VALUE", status: "need_more_data" } as any;
    const conversation = {
      id: "conversation",
      messages: [
        { id: "old-client", author: "client", body: "z levf. ult-nj 15k euros", createdAt: "now" },
        { id: "old-ai", author: "ai", body: "Поняла. 15 000 евро — это ориентировочная стоимость автомобиля?", createdAt: "now" }
      ],
      application,
      channel: "web-test"
    } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "да", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue(["vehicleValue"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const agent = { run: vi.fn().mockResolvedValue({ result: { ...validResult, hasMoney: false, leadCardPatch: {} }, reply: "Поняла, записала стоимость.", model: "one", promptVersion: "v1" }), normalizeMoney: vi.fn() } as any;
    const integrations = { convertToSom: vi.fn().mockResolvedValue({ available: true, value: 1_311_000, currency: "EUR", rate: 87.4, nominal: 1, source: "NBKR", effectiveDate: "2026-09-07" }) } as any;

    const output = await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any, integrations)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "да", attachments: [], timestamp: new Date() });

    expect(agent.normalizeMoney).not.toHaveBeenCalled();
    expect(integrations.convertToSom).toHaveBeenCalledWith({ amount: 15_000, currency: "EUR" });
    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ vehicleValue: 1_310_000, vehicleValueSourceCurrency: "EUR" }));
    expect(output.reply).toContain("15 000 евро");
  });

  it("gives the dialogue agent the converted vehicle value before it chooses the next question", async () => {
    const application = {
      id: "app",
      facts: { vehicleModel: "Camry", vehicleYear: 2022, requestedAmount: 1_000_000, requestedProgram: "without_storage" },
      contactId: "contact", stage: "COLLECTING_VALUE", status: "need_more_data"
    } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockResolvedValue({ id: "message", author: "client", body: "стоит наверное 5к долларов", createdAt: "now" }),
      updateFacts: vi.fn().mockResolvedValue(["vehicleValue"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn()
    } as any;
    const staleQuestion = "Подскажите, пожалуйста, ориентировочную стоимость автомобиля.";
    const agent = {
      run: vi.fn(async (input) => {
        expect(input.facts).toEqual(expect.objectContaining({ vehicleValue: 430_000, vehicleValueSourceCurrency: "USD" }));
        return {
          result: { ...validResult, hasMoney: false, leadCardPatch: {} },
          reply: "Спасибо, учла. Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.",
          model: "workflow-model", promptVersion: "v1"
        };
      }),
      normalizeMoney: vi.fn().mockResolvedValue([])
    } as any;
    const integrations = { convertToSom: vi.fn().mockResolvedValue({ available: true, value: 437_000, currency: "USD", rate: 87.4, nominal: 1, source: "NBKR", effectiveDate: "2026-09-07" }) } as any;

    const output = await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any, integrations)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "стоит наверное 5к долларов", attachments: [], timestamp: new Date() });

    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ vehicleValue: 430_000, vehicleValueSourceCurrency: "USD" }));
    expect(output.reply).toContain("Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.");
    expect(output.reply).not.toContain(staleQuestion);
  });

  it.each([
    ["долларов", "USD"],
    ["евро", "EUR"],
    ["тенге", "KZT"],
    ["рублей", "RUB"]
  ] as const)("normalizes every supported non-KGS currency: %s", async (currencyWord, currency) => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: `нужно 6к ${currencyWord}`, createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue(["requestedAmount"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const agent = {
      run: vi.fn().mockResolvedValue({ result: { ...validResult, hasMoney: false, leadCardPatch: {} }, reply: "Подскажите стоимость автомобиля.", model: "one", promptVersion: "v1" }),
      normalizeMoney: vi.fn().mockResolvedValue([{ field: "requestedAmount", amount: 6_000, currency, confidence: 0.99 }])
    } as any;
    const integrations = { convertToSom: vi.fn().mockResolvedValue({ available: true, value: 524_700, currency, rate: 87.45, nominal: 1, source: "NBKR", effectiveDate: "2026-09-04" }) } as any;

    await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any, integrations)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: `нужно 6к ${currencyWord}`, attachments: [], timestamp: new Date() });

    expect(agent.normalizeMoney).toHaveBeenCalledTimes(1);
    expect(integrations.convertToSom).toHaveBeenCalledWith({ amount: 6_000, currency });
    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ requestedAmount: 520_000, requestedAmountSourceCurrency: currency }));
  });

  it("persists both foreign-currency prices even when hasMoney is false", async () => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "камри стоит 20к долларов, нужно 100к сом", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue(["vehicleValue", "requestedAmount"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const agent = {
      run: vi.fn().mockResolvedValue({ result: { ...validResult, hasMoney: false, leadCardPatch: { vehicleModel: "Camry" } }, reply: "Выберите программу.", model: "one", promptVersion: "v1" }),
      normalizeMoney: vi.fn().mockResolvedValue([
        { field: "vehicleValue", amount: 20_000, currency: "USD", confidence: 0.99 },
        { field: "requestedAmount", amount: 100_000, currency: "KGS", confidence: 0.99 }
      ])
    } as any;
    const integrations = { convertToSom: vi.fn().mockResolvedValue({ available: true, value: 1_748_000, currency: "USD", rate: 87.4, nominal: 1, source: "NBKR", effectiveDate: "2026-09-05" }) } as any;

    await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any, integrations)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "камри стоит 20к долларов, нужно 100к сом", attachments: [], timestamp: new Date() });

    expect(agent.normalizeMoney).toHaveBeenCalledTimes(1);
    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ vehicleValue: 1_740_000, requestedAmount: 100_000, vehicleValueSourceCurrency: "USD" }));
  });

  it("persists and converts explicit client prices when the LLM normalizer returns no values", async () => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "камри 22 года стоит 20к долларов, нужно 100к сом", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue(["vehicleValue", "requestedAmount"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const agent = {
      run: vi.fn().mockResolvedValue({ result: { ...validResult, hasMoney: true, leadCardPatch: { vehicleModel: "Camry", vehicleYear: 2022 } }, reply: "Стоимость и сумма зафиксированы.", model: "one", promptVersion: "v1" }),
      normalizeMoney: vi.fn().mockResolvedValue([])
    } as any;
    const integrations = { convertToSom: vi.fn().mockImplementation(async ({ amount, currency }: { amount: number; currency: string }) => ({ available: true, value: currency === "USD" ? amount * 87.4 : amount, currency, rate: 87.4, nominal: 1, source: "NBKR", effectiveDate: "2026-09-05" })) } as any;

    const result = await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any, integrations)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "камри 22 года стоит 20к долларов, нужно 100к сом", attachments: [], timestamp: new Date() });

    expect(agent.run).toHaveBeenCalledWith(expect.objectContaining({
      facts: expect.objectContaining({ vehicleValue: 1_740_000, vehicleValueSourceCurrency: "USD", requestedAmount: 100_000 })
    }));
    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ vehicleValue: 1_740_000, vehicleValueSourceCurrency: "USD", requestedAmount: 100_000 }));
    expect(result.reply).toContain("20 000 долларов США — ориентировочно 1 740 000 сом");
  });

  it("does not use the deterministic fallback to guess an unbound amount", async () => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "1 млн", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const result = {
      ...validResult,
      hasMoney: true,
      leadCardPatch: {},
      reply: "Подскажите, это ориентировочная стоимость автомобиля или желаемая сумма займа?"
    };
    const agent = {
      run: vi.fn().mockResolvedValue({ result, reply: result.reply, model: "one", promptVersion: "v1" }),
      normalizeMoney: vi.fn().mockResolvedValue([])
    } as any;

    await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "1 млн", attachments: [], timestamp: new Date() });

    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.not.objectContaining({ vehicleValue: expect.anything(), requestedAmount: expect.anything() }));
    expect(store.addMessage).toHaveBeenLastCalledWith(conversation, expect.objectContaining({ author: "ai", body: result.reply }));
  });

  it("does not normalize money after an ordinary agent turn", async () => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "да", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const agent = { run: vi.fn().mockResolvedValue({ result: validResult, reply: validResult.reply, model: "one", promptVersion: "v1" }), normalizeMoney: vi.fn() } as any;

    await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "да", attachments: [], timestamp: new Date() });

    expect(agent.normalizeMoney).not.toHaveBeenCalled();
  });

  it("waits for money normalization and FX resolution before running the dialogue agent", async () => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "message", author: "client", body: "", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue(["requestedAmount"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const calls: string[] = [];
    let releaseNormalizer: (() => void) | undefined;
    const normalizerGate = new Promise<void>((resolve) => { releaseNormalizer = resolve; });
    const agent = {
      normalizeMoney: vi.fn(async () => {
        calls.push("normalize:start");
        await normalizerGate;
        calls.push("normalize:done");
        return [{ field: "requestedAmount", amount: 6_000, currency: "USD", confidence: 0.99 }];
      }),
      run: vi.fn(async (input) => {
        calls.push("run");
        expect(input.facts).toEqual(expect.objectContaining({ requestedAmount: 520_000, requestedAmountSourceCurrency: "USD" }));
        expect(input.currencyConversions).toEqual([expect.objectContaining({ currency: "USD", somValue: 520_000 })]);
        return { result: { ...validResult, leadCardPatch: {} }, reply: validResult.reply, model: "one", promptVersion: "v1" };
      })
    } as any;
    const integrations = { convertToSom: vi.fn().mockResolvedValue({ available: true, value: 524_700, currency: "USD", rate: 87.45, nominal: 1, source: "NBKR", effectiveDate: "2026-09-04" }) } as any;

    const output = new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any, integrations)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "нужно 6к долларов", attachments: [], timestamp: new Date() });

    await vi.waitFor(() => expect(calls).toEqual(["normalize:start"]));
    expect(agent.run).not.toHaveBeenCalled();
    releaseNormalizer?.();
    await output;
    expect(calls).toEqual(["normalize:start", "normalize:done", "run"]);
  });

  it("does not run the dialogue agent or persist messages after money-normalizer cancellation", async () => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn(), updateFacts: vi.fn(), saveAgentState: vi.fn(), getApplication: vi.fn(), getConversation: vi.fn(), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const controller = new AbortController();
    const agent = {
      normalizeMoney: vi.fn(async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }),
      run: vi.fn()
    } as any;

    await expect(new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receiveBatch([{ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "нужно 600к", attachments: [], timestamp: new Date() }], { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(agent.run).not.toHaveBeenCalled();
    expect(store.addMessage).not.toHaveBeenCalled();
  });

  it("normalizes a KGS amount when the agent sets hasMoney", async () => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "200 тыщ", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue(["requestedAmount"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const agent = { run: vi.fn().mockResolvedValue({ result: { ...validResult, hasMoney: true, leadCardPatch: { requestedAmount: 200_000 } }, reply: "Записала сумму 200 000 сом.", model: "one", promptVersion: "v1" }), normalizeMoney: vi.fn().mockResolvedValue([{ field: "requestedAmount", amount: 200_000, currency: "KGS", confidence: 0.99 }]) } as any;

    await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "200 тыщ", attachments: [], timestamp: new Date() });

    expect(agent.normalizeMoney).toHaveBeenCalledTimes(1);
    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ requestedAmount: 200_000 }));
  });

  it("routes an atypical question to the dedicated knowledge agent and never persists routing metadata", async () => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "а вы датчики на машину ставите", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const agent = { run: vi.fn().mockResolvedValue({
      result: { ...validResult, leadCardPatch: { ...validResult.leadCardPatch, knowledgeRequest: { required: true, reason: "missing_approved_answer" } } },
      reply: vehicleStageQuestion,
      model: "workflow-model",
      promptVersion: "v1"
    }), answerWithKnowledge: vi.fn().mockResolvedValue({
      reply: "Да, на автомобиль устанавливаем GPS/трекер (датчик).",
      answerFound: true,
      model: "knowledge-model"
    }) } as any;

    const output = await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "а вы датчики на машину ставите", attachments: [], timestamp: new Date() });

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(agent.answerWithKnowledge).toHaveBeenCalledWith(expect.objectContaining({
      text: "а вы датчики на машину ставите",
      workflowFollowUp: vehicleStageQuestion
    }));
    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.not.objectContaining({ knowledgeRequest: expect.anything() }));
    expect(output.reply).toBe(`Да, на автомобиль устанавливаем GPS/трекер (датчик).\n\n${vehicleStageQuestion}`);
  });

  it("preserves a server visit question after the knowledge-model answer", async () => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "SCHEDULING_VISIT", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockResolvedValue({ id: "message", author: "client", body: "А Wi-Fi есть?", createdAt: "now" }),
      updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn()
    } as any;
    const visitQuestion = "Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?";
    const agent = {
      run: vi.fn().mockResolvedValue({
        result: { ...validResult, leadCardPatch: { knowledgeRequest: { required: true, reason: "missing_approved_answer" } } },
        reply: visitQuestion, model: "workflow-model", promptVersion: "v1"
      }),
      answerWithKnowledge: vi.fn().mockResolvedValue({ reply: "Да, для посетителей доступен Wi‑Fi.", answerFound: true, model: "knowledge-model" })
    } as any;

    const output = await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "А Wi-Fi есть?", attachments: [], timestamp: new Date() });

    expect(agent.answerWithKnowledge).toHaveBeenCalledWith(expect.objectContaining({ workflowFollowUp: visitQuestion }));
    expect(output.reply).toBe(`Да, для посетителей доступен Wi‑Fi.\n\n${visitQuestion}`);
  });

  it("normalizes both monetary roles through the model contract", async () => {
    process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ values: [
      { field: "vehicleValue", amount: 21_000, currency: "USD", confidence: 0.99 },
      { field: "requestedAmount", amount: 10_000, currency: "USD", confidence: 0.99 }
    ] }) } }] }) } as any;
    const logs = { log: vi.fn(), warn: vi.fn() } as any;
    const result = await new AgentTurnService(client, logs).normalizeMoney({ text: "камри 2023 стоит 21 к долларов надо 10", facts: {}, messages: [], conversationId: "conversation-1" });
    expect(result).toEqual([
      { field: "vehicleValue", amount: 21_000, currency: "USD", confidence: 0.99 },
      { field: "requestedAmount", amount: 10_000, currency: "USD", confidence: 0.99 }
    ]);
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
    expect(logs.log).toHaveBeenCalledWith("dialogue.money-normalizer", "Money normalizer response parsed", expect.objectContaining({
      conversationId: "conversation-1",
      metadata: expect.objectContaining({
        rawModelResponse: expect.stringContaining('"vehicleValue"'),
        acceptedValues: result
      })
    }));
  });

  it("rejects a duplicate vehicle value for one explicit loan amount", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ values: [
      { field: "requestedAmount", amount: 1_000_000, currency: "KGS", confidence: 0.99 },
      { field: "vehicleValue", amount: 1_000_000, currency: "KGS", confidence: 0.99 }
    ] }) } }] }) } as any;

    const result = await new AgentTurnService(client).normalizeMoney({
      text: "камри 2022 г 1 млн дадите?", facts: {}, messages: []
    });

    expect(result).toEqual([
      { field: "requestedAmount", amount: 1_000_000, currency: "KGS", confidence: 0.99 }
    ]);
  });

  it("persists the complete invalid money-normalizer response for diagnosis", async () => {
    const rawModelResponse = "x".repeat(5_000);
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: rawModelResponse } }] }) } as any;
    const logs = { log: vi.fn(), warn: vi.fn() } as any;

    const result = await new AgentTurnService(client, logs).normalizeMoney({ text: "нужно 100 тысяч", facts: {}, messages: [], conversationId: "conversation-1" });

    expect(result).toEqual([]);
    expect(logs.warn).toHaveBeenCalledWith("dialogue.money-normalizer", "Money normalizer returned invalid JSON", expect.objectContaining({
      metadata: expect.objectContaining({ rawModelResponse })
    }));
  });

  it("gives money normalization only the current message and immediate offer context", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ values: [] }) } }] }) } as any;
    await new AgentTurnService(client).normalizeMoney({ text: "без изъятия", facts: { requestedAmount: 874_488 } as any, messages: [{ author: "client", body: "30 тыс долларов надо 10", createdAt: "now" } as any] });
    expect(JSON.parse(client.createChatCompletion.mock.calls[0][0].messages[1].content)).toEqual({ currentMessage: "без изъятия", lastAssistantMessage: "" });
  });

  it("serializes current-turn messages, pricing, and the compatibility currentMessage", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(validResult) } }] }) } as any;
    await new AgentTurnService(client).run({
      messages: [], facts: {}, settings: {}, text: "второе сообщение",
      currentTurnMessages: [{ index: 1, text: "первое сообщение" }, { index: 2, text: "второе сообщение" }],
      pricing: { minimumLoan: 50_000, clientFacingMaximumField: "publicMax", withoutStorage: { available: false, rawMax: null, publicMax: null, reason: "residence_unknown" }, parking: { available: false, rawMax: null, publicMax: null, monthlyRate: 2.4, dailyParkingFee: 130, reason: "residence_unknown" } },
      attachments: []
    });

    const context = JSON.parse(client.createChatCompletion.mock.calls[0][0].messages[1].content[0].text);
    expect(context.currentMessage).toBe("второе сообщение");
    expect(context.currentTurnMessages).toEqual([{ index: 1, text: "первое сообщение" }, { index: 2, text: "второе сообщение" }]);
    expect(context.pricing.minimumLoan).toBe(50_000);
  });

  it("sends only the recent twelve-message history tail to the main agent", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(validResult) } }] }) } as any;
    const history = Array.from({ length: 15 }, (_, index) => ({ author: "client", body: `сообщение ${index + 1}`, createdAt: `2026-09-05T12:${String(index).padStart(2, "0")}:00` })) as any;

    await new AgentTurnService(client).run({ messages: history, facts: {}, settings: {}, text: "новое сообщение", attachments: [] });

    const context = JSON.parse(client.createChatCompletion.mock.calls[0][0].messages[1].content[0].text);
    expect(context.history).toHaveLength(8);
    expect(context.history[0].text).toBe("сообщение 8");
    expect(context.history.at(-1).text).toBe("сообщение 15");
  });

  it("marks a selected programme as a locked known fact during residence collection", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(validResult) } }] }) } as any;

    await new AgentTurnService(client).run({
      messages: [],
      facts: { vehicleModel: "Camry", vehicleYear: 2010, vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "without_storage" } as any,
      settings: {}, text: "Токмок", attachments: []
    });

    const context = JSON.parse(client.createChatCompletion.mock.calls[0][0].messages[1].content[0].text);
    expect(context.knownLeadCardFields).toContain("requestedProgram");
    expect(context.relevantStages).toContain("residence");
    expect(context).not.toHaveProperty("stageInstructions");
    expect(context.pricing.withoutStorage).toMatchObject({ available: true, publicMax: 400_000 });
    expect(context.pricing.residence).toEqual({ category: "BISHKEK_CHUY", residenceRegion: "Чуйская область" });
  });

  it("normalizes a model-reported misspelled locality from residenceText", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      leadCardPatch: { residenceText: "чтолпон ата" }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "parking" } as any,
      settings: {}, text: "чтолпон ата", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({
      residenceText: "Чолпон-Ата",
      residenceRegion: "Другой регион Кыргызстана",
      residenceCategory: "OTHER_KG",
      residenceNeedsClarification: false
    });
  });

  it("does not accept an invented residence outside an explicit registration answer", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Поручитель обязателен для программы без изъятия в Вашем регионе.",
      leadCardPatch: {
        requestedAmount: 200_000,
        residenceText: "Каракол",
        residenceRegion: "Другой регион Кыргызстана",
        residenceCategory: "OTHER_KG",
        residenceNeedsClarification: false
      }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?", createdAt: "now" } as any],
      facts: { vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 2_360_000, requestedAmount: 870_000, requestedProgram: "without_storage" } as any,
      settings: {}, text: "давай 200", attachments: []
    });

    expect(output.result?.leadCardPatch.residenceText).toBeUndefined();
    expect(output.result?.leadCardPatch.residenceRegion).toBeUndefined();
    expect(output.result?.leadCardPatch.residenceCategory).toBeUndefined();
    expect(output.reply).toContain("Вашу прописку");
    expect(output.reply).not.toMatch(/поручител/iu);
  });

  it("uses a second model only to stabilize a locality before the catalogue assigns its region", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, leadCardPatch: { residenceText: "чалупон ата", residenceRegion: "Чуйская область", residenceCategory: "BISHKEK_CHUY" } }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ locality: "Чолпон-Ата", category: "BISHKEK_CHUY" }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, Ваш город, село или область по прописке.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "parking" } as any,
      settings: {}, text: "чалупон ата", attachments: []
    });

    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(output.result?.leadCardPatch).toMatchObject({
      residenceText: "Чолпон-Ата",
      residenceRegion: "Другой регион Кыргызстана",
      residenceCategory: "OTHER_KG"
    });
  });

  it("persists a short misspelled locality reply even when the model omits its patch", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Чолпон-Ата относится к другому региону Кыргызстана.",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "parking" } as any,
      settings: {}, text: "чтолпон ата", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({
      residenceText: "чтолпон ата",
      residenceRegion: "Другой регион Кыргызстана",
      residenceCategory: "OTHER_KG",
      residenceNeedsClarification: false
    });
    expect(output.reply).not.toMatch(/пропис/iu);
  });

  it("uses the server catalogue for Bosteri instead of a model's false Chuy classification", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Бостери относится к Чуйской области.",
      leadCardPatch: { residenceRegion: "Чуйская область", residenceCategory: "BISHKEK_CHUY" }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000, requestedAmount: 300_000, requestedProgram: "without_storage" } as any,
      settings: {}, text: "бостери", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ residenceText: "Бостери", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", residenceNeedsClarification: false });
  });

  it("asks for Chuy confirmation and blocks pricing when the server catalogue cannot resolve a locality", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Это Чуйская область.",
      leadCardPatch: { residenceRegion: "Чуйская область", residenceCategory: "BISHKEK_CHUY" }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000, requestedAmount: 300_000, requestedProgram: "without_storage" } as any,
      settings: {}, text: "неизвестный аил", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ residenceText: "неизвестный аил", residenceNeedsClarification: true });
    expect(output.result?.leadCardPatch.residenceCategory).toBeUndefined();
    expect(output.reply).toBe("Уточните, пожалуйста: это в Чуйской области?");
    expect(output.reply).not.toContain("доступно до");
  });

  it("accepts a Chuy category only after the semantic classifier confirms the clarification", async () => {
    const mainResponse = { choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: { residenceRegion: "Чуйская область", residenceCategory: "BISHKEK_CHUY" } }) } }] } as any;
    const classifierResponse = { choices: [{ message: { content: JSON.stringify({ decision: "accept" }) } }] } as any;
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValueOnce(mainResponse).mockResolvedValueOnce(classifierResponse) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, это в Чуйской области?", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000, requestedAmount: 300_000, requestedProgram: "without_storage", residenceText: "неизвестный аил", residenceNeedsClarification: true } as any,
      settings: {}, text: "точно", attachments: []
    });

    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(output.result?.leadCardPatch).toMatchObject({ residenceRegion: "Чуйская область", residenceCategory: "BISHKEK_CHUY", residenceNeedsClarification: false });
  });

  it("keeps residence unresolved when the semantic classifier is undecided", async () => {
    const mainResponse = { choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: { residenceRegion: "Чуйская область", residenceCategory: "BISHKEK_CHUY" } }) } }] } as any;
    const classifierResponse = { choices: [{ message: { content: JSON.stringify({ decision: "undecided" }) } }] } as any;
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValueOnce(mainResponse).mockResolvedValueOnce(classifierResponse) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, это в Чуйской области?", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000, requestedAmount: 300_000, requestedProgram: "without_storage", residenceText: "неизвестный аил", residenceNeedsClarification: true } as any,
      settings: {}, text: "не знаю", attachments: []
    });

    expect(output.result?.leadCardPatch.residenceCategory).toBeUndefined();
    expect(output.result?.leadCardPatch.residenceNeedsClarification).toBe(true);
    expect(output.reply).toBe("Уточните, пожалуйста: это в Чуйской области?");
  });

  it("keeps an unknown vehicle value in the workflow instead of routing it to knowledge", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "К сожалению, у меня нет утверждённой информации по этому вопросу.",
      leadCardPatch: { knowledgeRequest: { required: true, reason: "missing_approved_answer" } }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, ориентировочную стоимость автомобиля.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2015 }, settings: {}, text: "не знаю", attachments: []
    });

    expect(output.result?.leadCardPatch.knowledgeRequest).toBeUndefined();
    expect(output.reply).toBe("Для предварительного расчёта нужна хотя бы ориентировочная стоимость автомобиля.\n\nПодскажите, пожалуйста, ориентировочную стоимость автомобиля.");
  });

  it("does not send answered FAQ history to the agent or knowledge routing", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Обычно оформление занимает 1 час.",
      leadCardPatch: { knowledgeRequest: { required: true, reason: "missing_approved_answer" } }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [
        { author: "client", body: "Сколько длится оформление?", createdAt: "earlier" } as any,
        { author: "ai", body: "Обычно оформление занимает 1 час.\n\nПодскажите, пожалуйста, ориентировочную стоимость автомобиля.", createdAt: "now" } as any
      ],
      facts: { vehicleModel: "Camry", vehicleYear: 2015 }, settings: {}, text: "могу прикинуть, секунду", attachments: []
    });

    expect(output.result?.leadCardPatch.knowledgeRequest).toBeUndefined();
    expect(output.reply).toBe("Хорошо, подождём.\n\nПодскажите, пожалуйста, ориентировочную стоимость автомобиля.");
    const context = JSON.parse((client.createChatCompletion.mock.calls[0][0].messages[1].content as Array<{ text: string }>)[0].text);
    expect(context.history).toEqual([{ author: "ai", text: "Подскажите, пожалуйста, ориентировочную стоимость автомобиля.", createdAt: "now" }]);
  });

  it("removes a repeated full-residence question after Cholpon-Ata is normalized", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Чолпон-Ата относится к другому региону Кыргызстана. Чтобы продолжить расчёт, подскажите, пожалуйста, прописку полностью — город или область?",
      leadCardPatch: { residenceText: "чтолпон ата" }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Чтобы рассчитать максимум, подскажите, пожалуйста, прописку.", createdAt: "now" } as any],
      facts: { vehicleModel: "Королла", vehicleYear: 2022, vehicleValue: 2_620_000 } as any,
      settings: {}, text: "чтолпон ата", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({
      residenceCategory: "OTHER_KG",
      residenceRegion: "Другой регион Кыргызстана",
      residenceNeedsClarification: false
    });
    expect(output.reply).toBe("Чолпон-Ата относится к другому региону Кыргызстана.\n\nКакая сумма займа Вам необходима?");
  });

  it("removes any later residence-question wording after Cholpon-Ata is normalized", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Чолпон-Ата относится к другому региону Кыргызстана. Чтобы рассчитать максимум, мне ещё нужна прописка: Бишкек, Чуйская область или другой регион Кыргызстана?",
      leadCardPatch: { residenceText: "чтолпон ата" }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Где Вы прописаны?", createdAt: "now" } as any],
      facts: { vehicleModel: "Королла", vehicleYear: 2022, vehicleValue: 2_620_000 } as any,
      settings: {}, text: "чтолпон ата", attachments: []
    });

    expect(output.reply).toBe("Чолпон-Ата относится к другому региону Кыргызстана.\n\nКакая сумма займа Вам необходима?");
  });

  it("replaces a disguised residence re-check with the next incomplete guarantor stage", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Хорошо, уменьшаю до 200 000 сом и программа без изъятия. Подскажите, автомобиль у Вас в Бишкеке или в другом регионе Кыргызстана?",
      hasMoney: true,
      leadCardPatch: { requestedAmount: 200_000, requestedProgram: "without_storage" }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Вы можете уменьшить сумму или выбрать стоянку.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_740_000,
        requestedAmount: 1_000_000, requestedProgram: "parking",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG",
        residenceNeedsClarification: false
      } as any,
      settings: {}, text: "Давай уменьшим до 200 и программу без изъятия", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ requestedAmount: 200_000, requestedProgram: "without_storage" });
    expect(output.reply).toBe("Хорошо, уменьшаю до 200 000 сом и программа без изъятия.\n\nПо программе без изъятия доступно до 200 000 сом.\n\nДля вашей прописки требуется поручитель\n- возраст от 25 лет\n- проживает в г. Бишкек или Чуйской области\n- должен лично присутствовать при выдаче займа и иметь с собой ID (паспорт)\nУ Вас есть такой поручитель?");
  });

  it("returns server-calculated maximums instead of repeating residence after it is known", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Чтобы рассчитать максимум, мне нужна ещё только Ваша прописка.",
      leadCardPatch: {}
    }) } }] }) } as any;
    const pricing = {
      minimumLoan: 50_000,
      clientFacingMaximumField: "publicMax" as const,
      withoutStorage: { available: true, rawMax: 200_000, publicMax: 200_000 },
      parking: { available: true, rawMax: 1_310_000, publicMax: 1_310_000, monthlyRate: 2.4, dailyParkingFee: 130 }
    };

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Вас интересует займ без изъятия или со стоянкой?", createdAt: "now" } as any],
      facts: { vehicleModel: "Королла", vehicleYear: 2022, vehicleValue: 2_620_000, residenceText: "чтолпон ата", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", residenceNeedsClarification: false } as any,
      settings: {}, text: "сколько денег по максимуму дадитеэ", pricing, attachments: []
    });

    expect(output.reply).toBe("Без изъятия: от 50 000 сом до 200 000 сом\nСо стоянкой: от 50 000 сом до 1 310 000 сом");
  });

  it.each(["максимальная", "по максимуму"])('answers the maximum-choice reply "%s" with the selected programme limit', async (text) => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Хорошо.", leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: amountStageQuestion, createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000, requestedProgram: "without_storage", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" } as any,
      settings: {}, text, attachments: []
    });

    expect(output.reply).toContain("По программе без изъятия доступно до 600 000 сом.");
    expect(output.reply).not.toContain(amountStageQuestion);
  });

  it("accepts the minimum-choice reply as the minimum loan amount", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Хорошо.", leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: amountStageQuestion, createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000, requestedProgram: "without_storage", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" } as any,
      settings: {}, text: "минимальная", attachments: []
    });

    expect(output.result?.leadCardPatch.requestedAmount).toBe(50_000);
    expect(output.reply).toContain("Минимальная сумма займа — 50 000 сом.");
    expect(output.reply).not.toContain(amountStageQuestion);
  });

  it("confirms a below-minimum requested amount before choosing a programme", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      hasMoney: true,
      reply: "Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?",
      leadCardPatch: { requestedAmount: 15_000, requestedProgram: "without_storage" }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: amountStageQuestion, createdAt: "now" } as any],
      facts: { vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 2_360_000 } as any,
      settings: {}, text: "тысяч 15", attachments: []
    });

    expect(output.result?.leadCardPatch.requestedAmount).toBeUndefined();
    expect(output.result?.leadCardPatch.requestedProgram).toBeUndefined();
    expect(output.reply).toBe("15 000 сом, верно?");
  });

  it("asks one money-role question and turns an explicit requested role into an amount question", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Подскажите, это ориентировочная стоимость автомобиля или желаемая сумма займа? Какая сумма займа Вам необходима?",
      leadCardPatch: {}
    }) } }] }) } as any;
    const agent = new AgentTurnService(client);
    const ambiguous = await agent.run({ messages: [], facts: {}, settings: {}, text: "тысяч 10", attachments: [] });
    const requested = await agent.run({ messages: [{ author: "ai", body: ambiguous.reply, createdAt: "now" } as any], facts: {}, settings: {}, text: "желаемая сумма", attachments: [] });

    expect(ambiguous.reply).toBe("Подскажите, это ориентировочная стоимость автомобиля или желаемая сумма займа?");
    expect(requested.reply).toBe("Какая сумма займа Вам необходима?");
  });

  it("blocks a confirmed below-minimum amount and asks for a valid amount", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      hasMoney: true,
      reply: "Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?",
      leadCardPatch: { requestedAmount: 15_000, requestedProgram: "without_storage" }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "15 000 сом, верно?", createdAt: "now" } as any],
      facts: { vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 2_360_000 } as any,
      settings: {}, text: "да", moneyClarificationDecision: "accept", minimumRequestedAmountCandidate: 15_000, attachments: []
    });

    expect(output.result?.leadCardPatch.requestedAmount).toBeUndefined();
    expect(output.reply).toBe("Минимальная сумма займа — 50 000 сом. Назовите, пожалуйста, сумму не меньше 50 000 сом.");
  });

  it("converts a currency correction after a below-minimum confirmation before continuing", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Поняла.",
      leadCardPatch: { requestedProgram: "without_storage" }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "15 000 сом, верно?", createdAt: "now" } as any],
      facts: { vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 2_360_000, requestedAmount: 1_305_000, requestedAmountSourceCurrency: "USD" } as any,
      settings: {}, text: "долларов", moneyClarificationDecision: "accept", attachments: []
    });

    expect(output.result?.leadCardPatch.requestedAmount).toBe(1_300_000);
    expect(output.reply).not.toContain("50 000 сом, верно");
    expect(output.reply).toContain("Вас интересует займ без изъятия автомобиля");
  });

  it("keeps an amount reply from creating an ungrounded residence clarification", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, hasMoney: true, reply: "Клиент указал сумму займа 800 тыс.",
      leadCardPatch: { requestedAmount: 800_000, residenceText: "800 тыс", residenceNeedsClarification: true }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: amountStageQuestion, createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000, requestedProgram: "without_storage" } as any,
      settings: {}, text: "800 тыс", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ requestedAmount: 800_000 });
    expect(output.result?.leadCardPatch.residenceNeedsClarification).toBeUndefined();
    expect(output.reply).toContain("Вашу прописку");
    expect(output.reply).not.toContain("это в Чуйской области?");
  });

  it.each([
    ["parking", "Программа со стоянкой (авто на парковке): ставка 2,4% в месяц + стоимость парковки 130 сом/сутки; сумма до 2 000 000 сом."],
    ["without_storage", "Программа БЕЗ ИЗЪЯТИЯ (авто остаётся у клиента): ставка определяется индивидуально после осмотра; сумма до 600 000 сом."]
  ] as const)("returns the approved rate answer for %s without adding a visit question", async (requestedProgram, expectedReply) => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Ставка без изъятия 2% в месяц. На какой день Вам удобно приехать?",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Предыдущий ответ", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000,
        requestedAmount: 500_000, requestedProgram,
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        documentsProvided: true, declinedCarPhoto: true, familyStatus: "single"
      } as any,
      settings: {}, text: "А какие проценты?", attachments: []
    });

    expect(output.reply).toBe(expectedReply);
  });

  it("accepts tomorrow at 6 as the final 18:00 visit slot without repeating office hours", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Завтра в 6 не получится. Офис работает с понедельника по пятницу с 11:00 до 19:00.",
      leadCardPatch: {}
    }) } }] }) } as any;
    const visitPrompt = "Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?";

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: visitPrompt, createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000,
        requestedAmount: 500_000, requestedProgram: "parking",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        documentsProvided: true, declinedCarPhoto: true, familyStatus: "single"
      } as any,
      settings: { timezone: "Asia/Bishkek", address: "Адрес офиса нужно подтвердить в настройках", twoGisUrl: "", googleMapsUrl: "" }, text: "завтра в 6", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ visitRequested: true, visitTime: "18:00" });
    expect(output.reply).toContain("в 18:00");
    expect(output.reply).toContain("Адрес: Б. Молодой Гвардии, 22, Бишкек");
    expect(output.reply).toContain("2ГИС: https://go.2gis.com/Y34m4");
    expect(output.reply).toContain("Google Maps: https://maps.app.goo.gl/9xiWLVvdyRgn3Sx4A");
    expect(output.reply).not.toContain("Офис работает");
  });

  it("answers a maximum-loan question and asks for its missing vehicle fact", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      hasMoney: true,
      reply: "Подскажите стоимость автомобиля.",
      leadCardPatch: { vehicleModel: "Camry", vehicleYear: 2022, requestedAmount: 1_000_000 }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Чем могу помочь?", createdAt: "now" } as any],
      facts: {}, settings: {}, text: "камри 2022 г 1 млн дадите?", attachments: []
    });

    expect(output.reply).toBe("Максимальная сумма зависит от автомобиля, выбранной программы и прописки.\n\nПодскажите, пожалуйста, ориентировочную стоимость автомобиля.");
  });

  it("answers a maximum-loan question and asks for the earliest remaining stage", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      hasMoney: true,
      reply: "Максимальная сумма зависит от автомобиля, выбранной программы и прописки.",
      leadCardPatch: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000 }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, модель и год выпуска автомобиля и ориентировочную стоимость автомобиля.", createdAt: "now" } as any],
      facts: { requestedProgram: "without_storage" } as any,
      settings: {}, text: "камри 2022 г 1 млн дадите?", attachments: []
    });

    expect(output.reply).toBe("Максимальная сумма зависит от автомобиля, выбранной программы и прописки.\n\nКакая сумма займа Вам необходима?");
  });

  it("blocks the next stage when the selected programme does not cover the requested amount", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Продолжаем оформление.",
      leadCardPatch: { requestedProgram: "without_storage" }
    }) } }] }) } as any;
    const pricing = {
      minimumLoan: 50_000, clientFacingMaximumField: "publicMax" as const,
      withoutStorage: { available: true, rawMax: 200_000, publicMax: 200_000 },
      parking: { available: true, rawMax: 1_250_000, publicMax: 1_250_000, monthlyRate: 2.4, dailyParkingFee: 130 }
    };

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Вас интересует займ без изъятия или со стоянкой?", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_500_000, requestedAmount: 1_000_000, residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG" } as any,
      settings: {}, text: "без изъятия", pricing, attachments: []
    });

    expect(output.reply).toBe("По программе без изъятия доступно до 200 000 сом. Сумма 1 000 000 сом по этой программе не проходит. Со стоянкой при текущей стоимости автомобиля доступно до 1 250 000 сом. Могу продолжить либо на сумму до 200 000 сом без изъятия, либо перейти на программу со стоянкой и рассмотреть сумму до 1 250 000 сом.");
    expect(output.reply).not.toContain("поручител");
  });

  it("offers parking as a higher valid maximum even when it cannot fully cover the request", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Поняла, Вам всё-таки нужно 600 000 сом. По этой программе для Вашей прописки такой лимит без поручителя не проходит.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Продолжаем оформление.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 600_000, requestedProgram: "without_storage", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG" } as any,
      pricing: { minimumLoan: 50_000, clientFacingMaximumField: "publicMax" as const, withoutStorage: { available: true, rawMax: 200_000, publicMax: 200_000 }, parking: { available: true, rawMax: 500_000, publicMax: 500_000, monthlyRate: 2.4, dailyParkingFee: 130 } },
      settings: {}, text: "нужно всё-таки 600", attachments: []
    });

    expect(output.reply).toContain("Со стоянкой при текущей стоимости автомобиля доступно до 500 000 сом");
    expect(output.reply).toContain("600 000 сом также не проходит");
    expect(output.reply).toContain("перейти на программу со стоянкой и рассмотреть сумму до 500 000 сом");
    expect(output.reply).not.toContain("без поручителя");
  });

  it("does not accept an invented foreign currency for a compact thousand amount", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ values: [{ field: "requestedAmount", amount: 600_000, currency: "KZT", confidence: 0.9 }] }) } }] }) } as any;
    const result = await new AgentTurnService(client).normalizeMoney({ text: "на 600к", facts: {}, messages: [] });
    expect(result).toEqual([{ field: "requestedAmount", amount: 600_000, currency: "KGS", confidence: 0.9 }]);
  });

  it("does not persist a notary fee from Ailyn's message as the client's loan amount", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      hasMoney: false,
      leadCardPatch: { requestedAmount: 1_500, familyStatus: "married" }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Согласие можно оформить у нотариуса в нашем здании за 1500 сом.", createdAt: "now" } as any],
      facts: {}, settings: {}, text: "да", attachments: []
    });

    expect(output.result?.leadCardPatch).toEqual(expect.objectContaining({ familyStatus: "married" }));
    expect(output.result?.leadCardPatch.requestedAmount).toBeUndefined();
  });

  it("accepts a KGS amount recognized by the main agent without the normalizer", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      hasMoney: true,
      leadCardPatch: { requestedAmount: 200_000 }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "200 тыщ", attachments: [] });

    expect(output.result?.leadCardPatch.requestedAmount).toBe(200_000);
  });

  it("accepts the without-storage public limit when use of the car rejects parking", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      hasMoney: false,
      leadCardPatch: { requestedProgram: "without_storage", requestedAmount: 600_000 }
    }) } }] }) } as any;
    const pricing = {
      minimumLoan: 50_000, clientFacingMaximumField: "publicMax" as const,
      withoutStorage: { available: true, rawMax: 600_000, publicMax: 600_000 },
      parking: { available: true, rawMax: 800_000, publicMax: 800_000, monthlyRate: 2.4, dailyParkingFee: 130 }
    };

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Можем уменьшить сумму до 600 000 сом или перейти на стоянку?", createdAt: "now" } as any],
      facts: { requestedProgram: "without_storage", requestedAmount: 700_000 } as any,
      settings: {}, text: "мне надо ездить на машине", pricing, attachments: []
    });

    expect(output.result?.leadCardPatch).toEqual(expect.objectContaining({ requestedProgram: "without_storage", requestedAmount: 600_000 }));
  });

  it("keeps the shared thousand multiplier and explains both converted roles", async () => {
    const integrations = { convertToSom: vi.fn().mockImplementation(async ({ amount, currency }: { amount: number; currency: string }) => ({ available: true, value: amount * 87, currency, rate: 87, nominal: 1, source: "NBKR", sourceUrl: "https://example.test", effectiveDate: "2026-09-03" })) } as any;
    const result = await resolveNormalizedMoneyFacts([
      { field: "vehicleValue", amount: 30_000, currency: "USD", confidence: 1 },
      { field: "requestedAmount", amount: 10_000, currency: "USD", confidence: 1 }
    ], integrations);
    expect(result.facts).toMatchObject({ vehicleValue: 2_610_000, requestedAmount: 870_000 });
    expect(result.clientText).toContain("Стоимость автомобиля: 30 000 долларов США — ориентировочно 2 610 000 сом.");
    expect(result.clientText).toContain("Необходимая сумма займа: 10 000 долларов США — ориентировочно 870 000 сом.");
  });

  it("persists and presents a conversion when the client named only one price", async () => {
    const integrations = { convertToSom: vi.fn().mockResolvedValue({ available: true, value: 524_700, currency: "USD", rate: 87.45, nominal: 1, source: "NBKR", effectiveDate: "2026-09-04" }) } as any;
    const result = await resolveNormalizedMoneyFacts([
      { field: "requestedAmount", amount: 6_000, currency: "USD", confidence: 1 }
    ], integrations);

    expect(result.facts).toMatchObject({ requestedAmount: 520_000, requestedAmountSourceCurrency: "USD" });
    expect(result.clientText).toBe("По текущему курсу НБКР:\n• Необходимая сумма займа: 6 000 долларов США — ориентировочно 520 000 сом.");
  });

  it("does not repeat a conversion for a price already stored in the lead", async () => {
    const integrations = { convertToSom: vi.fn().mockResolvedValue({ available: true, value: 1_748_976, currency: "USD", rate: 87.45, nominal: 1, source: "NBKR", effectiveDate: "2026-09-04" }) } as any;
    const result = await resolveNormalizedMoneyFacts([
      { field: "vehicleValue", amount: 20_000, currency: "USD", confidence: 1 }
    ], integrations, { vehicleValue: 1_748_976 } as any);

    expect(result).toEqual({ facts: {}, conversions: [], clientText: undefined });
  });

  it("keeps the requested amount when the model binds yes to a parking-program offer", async () => {
    process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    const facts = {
      vehicleMake: "Toyota", vehicleYear: 2022, vehicleValue: 1_749_000,
      requestedAmount: 874_488, requestedProgram: "without_storage",
      residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
    } as any;
    const modelResult = {
      ...validResult,
      reply: "По программе со стоянкой предварительно доступно до 900 000 сом. Пожалуйста, отправьте фото ID и СТС с обеих сторон.",
      leadCardPatch: { requestedProgram: "parking", requestedAmount: 874_488 },
      preliminaryLimit: 900_000,
      dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "collect_documents" }
    };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(modelResult) } }] }) } as any;

    const output = await new AgentTurnService(client).run({ messages: [{ author: "ai", body: "Можно рассмотреть программу со стоянкой. Подходит ли Вам этот вариант?", createdAt: "now" } as any], facts, settings: {}, text: "да", attachments: [] });

    expect(output.result?.leadCardPatch).toEqual(expect.objectContaining({ requestedProgram: "parking", requestedAmount: 870_000 }));
    expect(output.reply).toContain("программе со стоянкой");
  });

  it("persists a yes answer to the single guarantor-availability question", async () => {
    process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Спасибо. Продолжим оформление.",
      leadCardPatch: { guarantorAvailable: true },
      dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "collect_documents" }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, есть ли у Вас поручитель? Он должен быть от 25 лет, с пропиской в Бишкеке или Чуйской области, присутствовать лично и иметь ID.", createdAt: "now" } as any],
      facts: { requestedProgram: "without_storage", residenceCategory: "OTHER_KG" } as any,
      settings: {}, text: "да", attachments: []
    });

    expect(output.result?.leadCardPatch.guarantorAvailable).toBe(true);
    expect(output.reply).not.toContain("есть ли у Вас поручитель");
  });

  it("adds every guarantor requirement before a bare first guarantor question", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Поняла. Есть ли у Вас поручитель?",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Предыдущий этап завершён.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_740_000, requestedAmount: 200_000, requestedProgram: "without_storage", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG" } as any,
      settings: {}, text: "продолжаем", attachments: []
    });

    expect(output.reply).toBe("Поняла.\n\nДля вашей прописки требуется поручитель\n- возраст от 25 лет\n- проживает в г. Бишкек или Чуйской области\n- должен лично присутствовать при выдаче займа и иметь с собой ID (паспорт)\nУ Вас есть такой поручитель?");
  });

  it("persists a short yes to the last guarantor question without relying on the model", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Поняла. Есть ли у Вас поручитель?",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Для займа без изъятия нужен поручитель. Подскажите, пожалуйста, есть ли у Вас поручитель?", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_740_000, requestedAmount: 200_000, requestedProgram: "without_storage", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG" } as any,
      settings: {}, text: "ДА", attachments: []
    });

    expect(output.result?.leadCardPatch.guarantorAvailable).toBe(true);
    expect(output.reply).toBe("Поняла.\n\nПожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.");
  });

  it("answers a spouse-visit question as spouse consent, not as a guarantor question", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Поняла. Если для визита потребуется поручитель, он должен быть с ID и лично присутствовать при выдаче займа.",
      leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Для вашей прописки требуется поручитель. У Вас есть такой поручитель?", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 100_000, requestedProgram: "without_storage", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG" } as any,
      settings: {}, text: "А жена нужна при визите?", attachments: []
    });

    expect(output.reply).toContain("Возьмите с собой супругу (супруга) для нотариального оформления согласия.");
    expect(output.reply).toContain("Если согласие у Вас будет на руках, присутствие супруги (супруга) необязательно.");
    expect(output.reply).not.toContain("Если для визита потребуется поручитель");
  });

  it("offers parking after a clear guarantor refusal and switches the programme after acceptance", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] }) } as any;
    const facts = {
      vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_740_000,
      requestedAmount: 200_000, requestedProgram: "without_storage",
      residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
    } as any;
    const requirement = "Для вашей прописки требуется поручитель\n- возраст от 25 лет\n- проживает в г. Бишкек или Чуйской области\n- должен лично присутствовать при выдаче займа и иметь с собой ID (паспорт)\nУ Вас есть такой поручитель?";

    const refused = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: requirement, createdAt: "now" } as any],
      facts, settings: {}, text: "нет", attachments: []
    });
    expect(refused.result?.leadCardPatch).toMatchObject({ guarantorAvailable: false, guarantorAlternativeDeclined: false });
    expect(refused.reply).toBe("Поняла.\n\nПоручитель обязателен для программы без изъятия в Вашем регионе. Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?");

    const acceptedParking = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Поручитель обязателен для программы без изъятия в Вашем регионе. Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?", createdAt: "now" } as any],
      facts: { ...facts, guarantorAvailable: false, guarantorAlternativeDeclined: false }, settings: {}, text: "да", attachments: []
    });
    expect(acceptedParking.result?.leadCardPatch).toMatchObject({ requestedProgram: "parking", guarantorAlternativeDeclined: false });
    expect(acceptedParking.reply).toContain("Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.");
    expect(acceptedParking.reply).not.toContain("поручитель");
  });

  it("answers a colloquial maximum-loan question in the same reply that accepts parking", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ decision: "accept", question: "сколько бабок дадите" }) } }] })
    } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Поручитель обязателен для программы без изъятия в Вашем регионе. Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?", createdAt: "now" } as any],
      facts: { vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 2_360_000, requestedAmount: 200_000, requestedProgram: "without_storage", residenceText: "Каракол", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", guarantorAvailable: false } as any,
      pricing: { minimumLoan: 50_000, clientFacingMaximumField: "publicMax", withoutStorage: { available: true, rawMax: 200_000, publicMax: 200_000 }, parking: { available: true, rawMax: 1_180_000, publicMax: 1_180_000 } },
      settings: {}, text: "ок а сколько бабок дадите", attachments: []
    });

    expect(output.result?.leadCardPatch.requestedProgram).toBe("parking");
    expect(output.reply).toContain("Со стоянкой: от 50 000 сом до 1 180 000 сом");
    expect(output.reply).not.toContain("Уточните, пожалуйста");
  });

  it("does not mix the guarantor stage into an unresolved amount-limit choice", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "И Вам потребуется поручитель: возраст от 25 лет. У Вас есть такой поручитель?",
      leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Предыдущий ответ", createdAt: "now" } as any],
      facts: { vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 2_360_000, requestedAmount: 1_520_000, requestedProgram: "without_storage", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG" } as any,
      pricing: { minimumLoan: 50_000, clientFacingMaximumField: "publicMax", withoutStorage: { available: true, rawMax: 200_000, publicMax: 200_000 }, parking: { available: true, rawMax: 1_180_000, publicMax: 1_180_000 } },
      settings: {}, text: "без изъятия", attachments: []
    });

    expect(output.reply).toContain("Сумма 1 520 000 сом по этой программе не проходит.");
    expect(output.reply).toContain("Могу продолжить либо на сумму до 200 000 сом");
    expect(output.reply).not.toContain("поручител");
  });

  it.each(["без", "без из", "без изъятия"])('normalizes the short without-storage programme reply %s', async (text) => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ program: "without_storage", hasOtherStageAnswer: false, question: null }) } }] })
    } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?", createdAt: "now" } as any],
      facts: { vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 2_360_000, requestedAmount: 1_520_000 } as any,
      settings: {}, text, attachments: []
    });

    expect(output.result?.leadCardPatch.requestedProgram).toBe("without_storage");
    expect(output.reply).toContain("Вашу прописку");
    expect(output.reply).not.toContain("Вас интересует займ без изъятия");
  });

  it("does not reopen a recognized residence as a Chuy clarification after guarantor refusal", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "И Вам потребуется поручитель:\n- возраст от 25 лет\n- проживает в г. Бишкек или Чуйской области\n- должен лично присутствовать при выдаче займа и иметь с собой ID (паспорт)\nУ Вас есть такой поручитель?", createdAt: "now" } as any],
      facts: { vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 2_360_000, requestedAmount: 200_000, requestedProgram: "without_storage", residenceText: "Каракол", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", residenceNeedsClarification: true } as any,
      settings: {}, text: "нет", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", guarantorAvailable: false });
    expect(output.reply).toContain("Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?");
    expect(output.reply).not.toContain("это в Чуйской области");
  });

  it("uses the model classifier for a rewritten parking question before falling back to a short yes", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ decision: "accept" }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Уточните, пожалуйста: Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_740_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG",
        guarantorAvailable: false, guarantorAlternativeDeclined: false
      } as any,
      settings: {}, text: "да", attachments: []
    });

    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(client.createChatCompletion.mock.calls[1][0].messages[0].content)
      .toContain("согласен ли он перейти на программу со стоянкой вместо поручителя");
    expect(output.result?.leadCardPatch).toMatchObject({ requestedProgram: "parking", guarantorAlternativeDeclined: false });
  });

  it("uses the model classifier for a rewritten parking question before falling back to a short no", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ decision: "reject" }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Уточните, пожалуйста: Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_740_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG",
        guarantorAvailable: false, guarantorAlternativeDeclined: false
      } as any,
      settings: {}, text: "нет", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ requestedProgram: "without_storage", guarantorAlternativeDeclined: true });
    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(client.createChatCompletion.mock.calls[1][0].messages[0].content)
      .toContain("согласен ли он перейти на программу со стоянкой вместо поручителя");
  });

  it("uses the semantic classifier first for non-template guarantor decisions", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ decision: "accept" }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ decision: "accept" }) } }] }) } as any;
    const facts = {
      vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_740_000,
      requestedAmount: 200_000, requestedProgram: "without_storage",
      residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
    } as any;
    const service = new AgentTurnService(client);

    const guarantor = await service.run({
      messages: [{ author: "ai", body: "Для вашей прописки требуется поручитель. У Вас есть такой поручитель?", createdAt: "now" } as any],
      facts, settings: {}, text: "своего человека приведу", attachments: []
    });
    const parking = await service.run({
      messages: [{ author: "ai", body: "Поручитель обязателен для программы без изъятия в Вашем регионе. Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?", createdAt: "now" } as any],
      facts: { ...facts, guarantorAvailable: false }, settings: {}, text: "это мне подходит", attachments: []
    });

    expect(guarantor.result?.leadCardPatch).toMatchObject({ guarantorAvailable: true, guarantorAlternativeDeclined: false });
    expect(parking.result?.leadCardPatch).toMatchObject({ requestedProgram: "parking", guarantorAlternativeDeclined: false });
    expect(client.createChatCompletion).toHaveBeenCalledTimes(4);
  });

  it("always advances an incomplete workflow after answering a client question", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Ставка определяется индивидуально.", leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Какая сумма займа Вам необходима?", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 200_000, requestedProgram: "without_storage", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" } as any,
      settings: {}, text: "какие проценты", attachments: []
    });

    expect(output.reply).toContain("ставка определяется индивидуально");
    expect(output.reply).toContain("Пожалуйста, отправьте фото ID");
  });

  it.each([
    ["где у вас стоянка", "Парковка находится недалеко от нашего офиса и находится под охраной. Точный адрес парковки не сообщается."],
    ["авто в кредите", "К сожалению, мы не сможем оформить займ, если автомобиль в кредите."],
    ["А вещи надо забрать из авто?", "Вещи в автомобиле можно оставить или забрать — на Ваше усмотрение."],
    ["А по доверенности можно займ оформить?", "Нет, оформить займ по доверенности нельзя: собственник автомобиля должен лично присутствовать при осмотре и выдаче займа."],
    ["Можно оформить нотариальную доверенность на сотрудника?", "Да, оформление нотариальной доверенности может быть одним из условий выдачи займа. Более подробно порядок оформления и условия Вы сможете уточнить во время визита в офис у менеджера."]
  ])("never lets the workflow model invent a factual answer to %s", async (text, approvedAnswer) => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Это зависит от условий, уточним позднее.", leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text, attachments: [] });

    expect(output.reply).toContain(approvedAnswer);
    expect(output.reply).not.toContain("Это зависит от условий");
    // Even exact FAQ matches are sent to the knowledge expert: it adapts the
    // approved answer to the client's wording and current context.
    expect(output.result?.leadCardPatch.knowledgeRequest).toMatchObject({ required: true });
  });

  it("never sends the obsolete name for the vehicle registration certificate", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Пришлите техпаспорт автомобиля.", leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "что нужно для оформления", attachments: [] });

    expect(output.reply).not.toMatch(/тех\.?\s*паспорт/iu);
    expect(output.reply).toContain("свидетельство о регистрации ТС");
  });

  it("keeps a notarial power of attorney for a company employee out of the loan-by-proxy refusal", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ reply: "Нет.", answerFound: true }) } }] }) } as any;
    const reply = await new AgentTurnService(client).answerWithKnowledge({
      messages: [], facts: {}, settings: {}, text: "А нотиральное довернность можно оформить на сотрудника?", workflowFollowUp: ""
    });

    expect(reply?.reply).toBe("Да, оформление нотариальной доверенности может быть одним из условий выдачи займа. Более подробно порядок оформления и условия Вы сможете уточнить во время визита в офис у менеджера.");
  });

  it("uses the exact approved conditioner answer instead of an unrelated knowledge-model reply", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ reply: "Да, для наших клиентов есть чай и кофе.", answerFound: true }) } }] }) } as any;
    const reply = await new AgentTurnService(client).answerWithKnowledge({
      messages: [], facts: {}, settings: {}, text: "Есть кондиционер?", workflowFollowUp: ""
    });

    expect(reply?.reply).toBe("Да.");
  });

  it("uses only the exact currency-exchange answer instead of a bundled nearby-services reply", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ reply: "Нотариус находится в нашем здании. Ближайший банкомат — в 5–6 минутах ходьбы, обмен валют — примерно в 5–10 минутах пешком.", answerFound: true }) } }] }) } as any;
    const reply = await new AgentTurnService(client).answerWithKnowledge({
      messages: [], facts: {}, settings: {}, text: "Есть обмен валют?", workflowFollowUp: ""
    });

    expect(reply?.reply).toBe("Да, есть недалеко от нас. Примерно 5–10 минут пешком.");
  });

  it("uses the approved one-hour answer for a misspelled processing-duration question", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ reply: "Оформление обычно занимает около 30–40 минут.", answerFound: true }) } }] }) } as any;
    const reply = await new AgentTurnService(client).answerWithKnowledge({
      messages: [], facts: {}, settings: {}, text: "Сколько длится оформлениу", workflowFollowUp: ""
    });

    expect(reply?.reply).toBe("Обычно оформление занимает 1 час. Присланные Вами документы помогут нам сократить время выдачи денег.");
  });

  it("asks about remaining questions after a booked visit and closes honestly after no", async () => {
    const facts = {
      vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 200_000, requestedProgram: "parking",
      residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY", documentsProvided: true,
      documents: { car_photo: "received" }, familyStatus: "single", visitRequested: true, visitDate: "2026-09-09", visitTime: "17:00"
    } as any;
    const firstClient = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Запись подтверждена.", leadCardPatch: {} }) } }] }) } as any;
    const closedClient = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ decision: "reject" }) } }] }) } as any;
    const followUp = await new AgentTurnService(firstClient).run({ messages: [], facts, settings: {}, text: "спасибо", attachments: [] });
    const closed = await new AgentTurnService(closedClient).run({ messages: [{ author: "ai", body: "Есть ли у Вас ещё вопросы?", createdAt: "now" } as any], facts, settings: {}, text: "нет, всё понятно", attachments: [] });

    expect(followUp.reply).toContain("Есть ли у Вас ещё вопросы?");
    expect(closed.result?.leadCardPatch.clientClosed).toBe(true);
    expect(closed.reply).toBe("Спасибо за обращение. Ожидайте звонка менеджера, он подтвердит время визита.");
  });

  it("treats a promise to find a guarantor as acceptance and never acknowledges an undecided reply", async () => {
    const facts = {
      vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_740_000,
      requestedAmount: 200_000, requestedProgram: "without_storage",
      residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
    } as any;
    const question = "Для вашей прописки требуется поручитель. У Вас есть такой поручитель?";
    const acceptedClient = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ decision: "accept" }) } }] }) } as any;
    const undecidedClient = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ decision: "undecided" }) } }] }) } as any;

    const accepted = await new AgentTurnService(acceptedClient).run({ messages: [{ author: "ai", body: question, createdAt: "now" } as any], facts, settings: {}, text: "найду", attachments: [] });
    const undecided = await new AgentTurnService(undecidedClient).run({ messages: [{ author: "ai", body: question, createdAt: "now" } as any], facts, settings: {}, text: "потом", attachments: [] });

    expect(accepted.result?.leadCardPatch.guarantorAvailable).toBe(true);
    expect(undecided.result?.leadCardPatch.guarantorAvailable).toBeUndefined();
    expect(undecided.reply).toBe("Уточните, пожалуйста: У Вас есть такой поручитель?");
    expect(undecided.reply).not.toContain("Поняла");
  });

  it("returns to the mandatory guarantor requirement when parking is declined", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Поручитель обязателен для программы без изъятия в Вашем регионе. Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_740_000, requestedAmount: 200_000, requestedProgram: "without_storage", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", guarantorAvailable: false, guarantorAlternativeDeclined: false } as any,
      settings: {}, text: "нет", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ guarantorAvailable: false, guarantorAlternativeDeclined: true });
    expect(output.reply).toContain("И Вам потребуется поручитель:");
    expect(output.reply).toContain("У Вас есть такой поручитель?");
  });

  it("announces the selected public maximum after the final required fact is received", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, hasMoney: true, reply: "Поняла.", leadCardPatch: { requestedAmount: 200_000 }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Какая сумма займа Вам необходима?", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000, requestedProgram: "without_storage", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" } as any,
      settings: {}, text: "200 тысяч", attachments: []
    });

    expect(output.reply).toBe("Поняла.\n\nПо программе без изъятия доступно до 600 000 сом.\n\nПожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.");
  });

  it("offers only a reduction when the selected parking programme cannot cover the requested amount", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Продолжаем.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000, requestedAmount: 1_100_000, requestedProgram: "parking", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" } as any,
      pricing: { minimumLoan: 50_000, clientFacingMaximumField: "publicMax" as const, withoutStorage: { available: true, rawMax: 600_000, publicMax: 600_000 }, parking: { available: true, rawMax: 1_000_000, publicMax: 1_000_000, monthlyRate: 2.4, dailyParkingFee: 130 } },
      settings: {}, text: "продолжаем", attachments: []
    });

    expect(output.reply).toBe("Поняла.\n\nПо программе со стоянкой доступно до 1 000 000 сом. Сумма 1 100 000 сом по этой программе не проходит. Могу продолжить на сумму до 1 000 000 сом.");
    expect(output.reply).not.toContain("перейти на программу");
  });

  it("closes the guarantor stage when a short locality correction changes residence to Chuy", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "В Токмоке для программы без изъятия нужен поручитель. Есть ли у Вас поручитель?",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, есть ли у Вас поручитель?", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_740_000, requestedAmount: 200_000, requestedProgram: "without_storage", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG" } as any,
      settings: {}, text: "токмок", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ residenceRegion: "Чуйская область", residenceCategory: "BISHKEK_CHUY" });
    expect(output.reply).toBe("По программе без изъятия доступно до 600 000 сом.\n\nПожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.");
  });

  it("does not activate the guarantor stage before the vehicle value and loan amount are known", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(validResult) } }] }) } as any;

    await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите стоимость автомобиля.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, requestedProgram: "without_storage", residenceCategory: "OTHER_KG" } as any,
      settings: {}, text: "чтолпон ата", attachments: []
    });

    const context = JSON.parse((client.createChatCompletion.mock.calls[0][0].messages[1].content as Array<{ type: string; text?: string }>)[0].text ?? "{}");
    expect(context.guarantorRequirement).toEqual({ required: false, reason: "not_applicable" });
  });

  it("does not allow a model to schedule a visit before the document stage", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "На какой день и время Вам удобно подъехать?",
      leadCardPatch: { visitRequested: true, visitDate: "2026-09-08", visitTime: "17:00" },
      dialogueState: { stage: "SCHEDULING_VISIT", status: "need_more_data", nextAction: "schedule_visit" }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Продолжаем оформление.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000,
        requestedAmount: 500_000, requestedProgram: "parking",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY"
      } as any,
      settings: {}, text: "хочу приехать завтра", attachments: []
    });

    expect(output.result?.leadCardPatch).not.toHaveProperty("visitRequested");
    expect(output.result?.leadCardPatch).not.toHaveProperty("visitDate");
    expect(output.reply).toBe("Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.");
  });

  it("treats a clear refusal of documents as a completed optional stage", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Без документов оформление дальше не продолжим. Отправьте их, когда будут под рукой.",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 430_000,
        requestedAmount: 1_000_000, requestedProgram: "without_storage",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      settings: {}, text: "нет с собой", attachments: []
    });

    expect(output.result?.leadCardPatch.declinedDocuments).toBe(true);
    expect(output.reply).toBe("Хорошо, документы можно отправить позже.\n\nПожалуйста, отправьте 2–3 фотографии автомобиля.");
    expect(output.reply).not.toContain("не продолжим");
  });

  it("moves from a declined car-photo request to the family stage", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Без фотографий автомобиля продолжить нельзя.",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте 2–3 фотографии автомобиля.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 430_000,
        requestedAmount: 1_000_000, requestedProgram: "without_storage",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG",
        declinedDocuments: true
      } as any,
      settings: {}, text: "их нет", attachments: []
    });

    expect(output.result?.leadCardPatch.declinedCarPhoto).toBe(true);
    expect(output.reply).toBe("Хорошо, фотографии автомобиля можно отправить позже.\n\nПодскажите, пожалуйста, Ваше семейное положение — Вы в браке, в разводе или не в браке.");
    expect(output.reply).not.toContain("нельзя");
  });

  it("binds a short inability to find files to the current car-photo request, not closed documents", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Поняла, не нашли документы — продолжаем без них.",
      leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте 2–3 фотографии автомобиля.", createdAt: "now" } as any],
      facts: { documentsProvided: true, declinedDocuments: true } as any,
      settings: {}, text: "не найду", attachments: []
    });

    expect(output.result?.leadCardPatch.declinedCarPhoto).toBe(true);
    expect(output.reply).toContain("фотографии автомобиля можно отправить позже");
    expect(output.reply).not.toContain("не нашли документы");
  });

  it("does not treat a family-status reply as a second refusal of already-declined car photos", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Хорошо, фотографии автомобиля можно отправить позже. Поняла.",
      leadCardPatch: { familyStatus: "single" }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Хорошо, фотографии автомобиля можно отправить позже. Подскажите, пожалуйста, Ваше семейное положение — Вы в браке, в разводе или не в браке.", createdAt: "now" } as any],
      facts: { documentsProvided: true, declinedDocuments: true, declinedCarPhoto: true } as any,
      settings: {}, text: "неа", attachments: []
    });

    expect(output.result?.leadCardPatch.familyStatus).toBe("single");
    expect(output.reply).not.toContain("фотографии автомобиля можно отправить позже");
  });

  it("does not repeat marital status after a client says they are married", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Поняла, спасибо.", leadCardPatch: { familyStatus: "married" }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, Ваше семейное положение.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 430_000, requestedAmount: 1_000_000, requestedProgram: "without_storage", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", declinedDocuments: true, declinedCarPhoto: true } as any,
      settings: {}, text: "Я в браке", attachments: []
    });

    expect(output.result?.leadCardPatch.familyStatus).toBe("married");
    expect(output.reply).toBe("Поняла, спасибо.\n\nДля оформления потребуется нотариальное согласие супруга или супруги. Его можно оформить у любого нотариуса или у нотариуса в нашем здании; ориентировочная стоимость — 1500 сом. Вам удобно оформить согласие при визите в офис?");
    expect(output.reply).not.toContain("семейное положение");
  });

  it("branches from divorce status to car purchase timing and certificate guidance", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла, в разводе. Нотариальное согласие бывшего супруга не требуется.", leadCardPatch: { familyStatus: "divorced" } }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: { vehicleBoughtDuringMarriage: true } }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: { familyStatus: "married" } }) } }] })
    } as any;
    const facts = { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 430_000, requestedAmount: 1_000_000, requestedProgram: "without_storage", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", declinedDocuments: true, declinedCarPhoto: true } as any;
    const service = new AgentTurnService(client);
    const divorced = await service.run({ messages: [{ author: "ai", body: "Подскажите семейное положение.", createdAt: "now" } as any], facts, settings: {}, text: "Я в разводе", attachments: [] });
    const boughtInMarriage = await service.run({ messages: [{ author: "ai", body: "Нотариальное согласие бывшего супруга или супруги не требуется. Подскажите, пожалуйста, автомобиль был приобретён во время брака или после развода?", createdAt: "now" } as any], facts: { ...facts, familyStatus: "divorced" }, settings: {}, text: "Автомобиль куплен в браке", attachments: [] });
    const shortPurchaseTimingAnswer = await service.run({ messages: [{ author: "ai", body: "Нотариальное согласие бывшего супруга или супруги не требуется. Подскажите, пожалуйста, автомобиль был приобретён во время брака или после развода?", createdAt: "now" } as any], facts: { ...facts, familyStatus: "divorced" }, settings: {}, text: "в браке", attachments: [] });

    expect(divorced.reply).toBe("Нотариальное согласие бывшего супруга или супруги не требуется. Подскажите, пожалуйста, автомобиль был приобретён во время брака или после развода?");
    expect(boughtInMarriage.result?.leadCardPatch.vehicleBoughtDuringMarriage).toBe(true);
    expect(boughtInMarriage.reply).toBe("В таком случае, пожалуйста, возьмите с собой оригинал свидетельства о расторжении брака. Если удобно, заранее пришлите его фотографию — это ускорит рассмотрение заявки.\n\nОфис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?");
    expect(shortPurchaseTimingAnswer.result?.leadCardPatch).toMatchObject({ familyStatus: "divorced", vehicleBoughtDuringMarriage: true });
    expect(shortPurchaseTimingAnswer.reply).toContain("оригинал свидетельства о расторжении брака");
    expect(shortPurchaseTimingAnswer.reply).not.toContain("нотариальное согласие супруга или супруги");
  });

  it("closes the married sub-stage when office consent is declined and reminds about the original", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Для оформления потребуется нотариальное согласие супруга или супруги. Вам удобно оформить согласие при визите в офис?", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 430_000, requestedAmount: 1_000_000, requestedProgram: "without_storage", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", declinedDocuments: true, declinedCarPhoto: true, familyStatus: "married" } as any,
      settings: {}, text: "нет", attachments: []
    });

    expect(output.result?.leadCardPatch.spouseConsentAtOffice).toBe(false);
    expect(output.reply).toBe("Тогда, пожалуйста, возьмите с собой оригинал нотариального согласия супруга или супруги.\n\nОфис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?");
  });

  it("accepts ok as consent to arrange the spouse's notarized consent in the office", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Для оформления потребуется нотариальное согласие супруга или супруги. Его можно оформить у любого нотариуса или у нотариуса в нашем здании; ориентировочная стоимость — 1500 сом. Вам удобно оформить согласие при визите в офис?", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 430_000, requestedAmount: 100_000, requestedProgram: "without_storage", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY", declinedDocuments: true, declinedCarPhoto: true, familyStatus: "married" } as any,
      settings: {}, text: "ок", attachments: []
    });

    expect(output.result?.leadCardPatch.spouseConsentAtOffice).toBe(true);
    expect(output.reply).not.toContain("Вам удобно оформить согласие");
    expect(output.reply).toContain("На какой день и время Вам удобно подъехать?");
  });

  it("keeps the model's semantic consent decision when the client avoids keyword replies", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: { spouseConsentAtOffice: true } }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Для оформления потребуется нотариальное согласие супруга или супруги. Вам удобно оформить согласие при визите в офис?", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 430_000, requestedAmount: 100_000, requestedProgram: "without_storage", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY", declinedDocuments: true, declinedCarPhoto: true, familyStatus: "married" } as any,
      settings: {}, text: "это моя тема, точно возьму", attachments: []
    });

    expect(output.result?.leadCardPatch.spouseConsentAtOffice).toBe(true);
    expect(output.reply).not.toContain("Вам удобно оформить согласие");
  });

  it("uses the semantic fallback model for a colloquial approval the main model left undecided", async () => {
    const mainResponse = { choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] } as any;
    const classifierResponse = { choices: [{ message: { content: JSON.stringify({ decision: "accept" }) } }] } as any;
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValueOnce(mainResponse).mockResolvedValueOnce(classifierResponse) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Для оформления потребуется нотариальное согласие супруга или супруги. Вам удобно оформить согласие при визите в офис?", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 430_000, requestedAmount: 100_000, requestedProgram: "without_storage", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY", declinedDocuments: true, declinedCarPhoto: true, familyStatus: "married" } as any,
      settings: {}, text: "это топ", attachments: []
    });

    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(output.result?.leadCardPatch.spouseConsentAtOffice).toBe(true);
    expect(output.reply).not.toContain("Вам удобно оформить согласие");
  });

  it("keeps office consent undecided for a meaningless reply and asks the same question again", async () => {
    const mainResponse = { choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] } as any;
    const classifierResponse = { choices: [{ message: { content: JSON.stringify({ decision: "undecided" }) } }] } as any;
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValueOnce(mainResponse).mockResolvedValueOnce(classifierResponse) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Для оформления потребуется нотариальное согласие супруга или супруги. Вам удобно оформить согласие при визите в офис?", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 430_000, requestedAmount: 100_000, requestedProgram: "without_storage", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY", declinedDocuments: true, declinedCarPhoto: true, familyStatus: "married" } as any,
      settings: {}, text: "абракадабра", attachments: []
    });

    expect(output.result?.leadCardPatch.spouseConsentAtOffice).toBeUndefined();
    expect(output.reply).toBe("Уточните, пожалуйста: Вам удобно оформить согласие при визите в офис?");
    expect(output.reply).not.toContain("Поняла");
  });

  it("keeps the married stage open and gives remote-consent guidance when the spouse is away", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: { familyStatus: "married" } }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите семейное положение.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 430_000, requestedAmount: 1_000_000, requestedProgram: "without_storage", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", declinedDocuments: true, declinedCarPhoto: true } as any,
      settings: {}, text: "Я в браке, но супруг в отъезде", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ familyStatus: "married", spouseAway: true });
    expect(output.reply).toBe("Поняла.\n\nСупруг или супруга может оформить нотариальное согласие у любого нотариуса по месту нахождения и отправить Вам оригинал. Напишите, пожалуйста, когда согласие будет у Вас — после этого продолжим оформление.");
    expect(output.reply).not.toContain("На какой день");
  });

  it("does not require a divorce certificate when the car was bought after divorce", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: { vehicleBoughtDuringMarriage: false } }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Нотариальное согласие бывшего супруга или супруги не требуется. Подскажите, пожалуйста, автомобиль был приобретён во время брака или после развода?", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 430_000, requestedAmount: 1_000_000, requestedProgram: "without_storage", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", declinedDocuments: true, declinedCarPhoto: true, familyStatus: "divorced" } as any,
      settings: {}, text: "Купил после развода", attachments: []
    });

    expect(output.result?.leadCardPatch.vehicleBoughtDuringMarriage).toBe(false);
    expect(output.reply).toBe("В таком случае свидетельство о расторжении брака не потребуется.\n\nОфис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?");
  });

  it("uses one multimodal workflow call with compact stage knowledge", async () => {
    process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ model: "one-model", choices: [{ message: { content: JSON.stringify(validResult) } }] }) } as any;
    const service = new AgentTurnService(client);
    const facts = { fullName: "Иван", vehicleMake: "Toyota", documents: { id_front: "received" }, visitRequested: true, visitDate: "2026-09-04" } as any;
    const output = await service.run({ messages: [{ author: "client", body: "Старая реплика", createdAt: "2026-01-01" } as any], facts, settings: { parkingInterestRate: 2.4 }, text: "Toyota 2020", attachments: [{ id: "photo", mimeType: "image/jpeg", contentBase64: "abc" }] });
    expect(output.result).toMatchObject({ ...validResult, reply: withFirstContactGreeting(vehicleStageQuestion), leadCardPatch: { ...validResult.leadCardPatch, ...facts } });
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
    const request = client.createChatCompletion.mock.calls[0][0];
    expect(request.model).toBe(process.env.ROUTERAI_TEXT_MODEL ?? "routerai-text-model-not-configured");
    expect(request.response_format).toEqual({ type: "json_object" });
    expect(JSON.stringify(request.messages)).toContain("Старая реплика");
    const context = JSON.parse((request.messages[1].content as Array<{ type: string; text?: string }>)[0].text ?? "{}");
    expect(context.leadCard).toEqual(facts);
    expect(context.history).toEqual([{ author: "client", text: "Старая реплика", createdAt: "2026-01-01" }]);
    expect(context.knowledge.length).toBeLessThanOrEqual(2);
    expect(context).not.toHaveProperty("commonKnowledge");
    expect(context).not.toHaveProperty("stageInstructions");
    expect(context.relevantStages).toContain("application");
    expect(request.messages[1].content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image_url" })]));
  });

  it("uses the configured knowledge model with the complete approved corpus", async () => {
    const previousModel = process.env.ROUTERAI_KNOWLEDGE_MODEL;
    process.env.ROUTERAI_KNOWLEDGE_MODEL = "knowledge-test-model";
    try {
      const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ model: "knowledge-test-model", choices: [{ message: { content: JSON.stringify({ reply: "Да, GPS устанавливаем.", answerFound: true }) } }] }) } as any;
      const service = new AgentTurnService(client);
      const output = await service.answerWithKnowledge({ messages: [], facts: {}, text: "датчики ставите?", workflowFollowUp: "Подскажите модель автомобиля." });

      expect(output).toEqual({ reply: "Да, GPS устанавливаем.", answerFound: true, model: "knowledge-test-model" });
      const request = client.createChatCompletion.mock.calls[0][0];
      expect(request.model).toBe("knowledge-test-model");
      const context = JSON.parse(request.messages[1].content);
      expect(context.knowledge.length).toBeGreaterThanOrEqual(generatedDocumentationChunks.length);
      expect(context.workflowFollowUp).toBe("Подскажите модель автомобиля.");
    } finally {
      if (previousModel === undefined) delete process.env.ROUTERAI_KNOWLEDGE_MODEL;
      else process.env.ROUTERAI_KNOWLEDGE_MODEL = previousModel;
    }
  });

  it("provides a server-built working-day calendar for a visit request", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(validResult) } }] }) } as any;
    const service = new AgentTurnService(client);
    await service.run({ messages: [], facts: {}, settings: { timezone: "Asia/Bishkek" }, text: "завтра в 2", attachments: [] });

    const context = JSON.parse((client.createChatCompletion.mock.calls[0][0].messages[1].content as Array<{ type: string; text?: string }>)[0].text ?? "{}");
    expect(context.visitCalendar.officeHours).toContain("ПН–ПТ");
    expect(context.visitCalendar.dates).toEqual(expect.arrayContaining([expect.objectContaining({ weekday: "суббота", working: false }), expect.objectContaining({ weekday: "воскресенье", working: false })]));
  });

  it("ignores derived or unknown fields inside the lead card patch", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, preliminaryLimit: 200000, leadCardPatch: { residenceRegion: "OTHER_KG", preliminaryLimit: 200000, arbitrary: true } }) } }] }) } as any;
    const logs = { warn: vi.fn().mockResolvedValue(undefined) } as any;
    const output = await new AgentTurnService(client, logs).run({ conversationId: "conversation-1", messages: [], facts: {}, settings: {}, text: "test", attachments: [] });
    expect(output.result).toEqual(expect.objectContaining({ leadCardPatch: { residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", residenceNeedsClarification: false } }));
    expect(output.result?.preliminaryLimit).toBe(200_000);
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it("repairs safe shorthand in a main-agent JSON response instead of falling back", async () => {
    const shorthand = {
      ...validResult,
      reply: "По программе без изъятия автомобиль остаётся у Вас.",
      leadCardPatch: { program: "without_storage" },
      cardSummary: {},
      dialogueState: "application",
      targetEvent: "application_next_question",
      managerUpdate: null
    };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(shorthand) } }] }) } as any;

    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "нужен займ без изъятия", attachments: [] });

    expect(output.reply).toBe(`${withFirstContactGreeting(shorthand.reply)}\n\n${vehicleStageQuestion}`);
    expect(output.result).toMatchObject({
      leadCardPatch: { requestedProgram: "without_storage" },
      cardSummary: "",
      dialogueState: { stage: "COLLECTING_VEHICLE", status: "need_more_data", nextAction: "continue_application" },
      targetEvent: null,
      managerUpdate: { kind: "none", changedFields: [] }
    });
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("does not let a FAQ reply jump from an incomplete vehicle stage to residence", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Да, для посетителей доступен Wi‑Fi. Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите автомобиль.", createdAt: "now" } as any],
      facts: { requestedAmount: 1_000_000, requestedProgram: "without_storage" } as any,
      settings: {}, text: "А у вас в офисе есть вайфай?", attachments: []
    });

    expect(output.reply).toBe("Да, для посетителей доступен Wi‑Fi.\n\nПодскажите, пожалуйста, модель и год выпуска автомобиля и ориентировочную стоимость автомобиля.");
  });

  it("appends the earliest server-owned stage question after an ordinary FAQ answer", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Да, в офис можно приехать на такси.",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Спасибо, стоимость автомобиля приняла.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000 } as any,
      settings: {}, text: "Можно приехать на такси?", attachments: []
    });

    expect(output.reply).toBe(`Да, в офис можно приехать на такси.\n\n${amountStageQuestion}`);
  });

  it("replaces a model-authored later-stage question with the canonical earliest question", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана?",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Стоимость автомобиля принята.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000 } as any,
      settings: {}, text: "продолжаем", attachments: []
    });

    expect(output.reply).toBe(amountStageQuestion);
    expect(output.reply).not.toContain("прописку");
  });

  it("answers an office question before repeating the outstanding amount-limit choice", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "В офисе есть зона ожидания, Wi‑Fi, вода и кулер; при необходимости поможем зарядить телефон.",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "По программе со стоянкой доступно до 870 000 сом. Подскажите, пожалуйста, сумму займа не выше 870 000 сом.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000,
        requestedAmount: 1_000_000, requestedProgram: "parking",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      pricing: { minimumLoan: 50_000, clientFacingMaximumField: "publicMax", parking: { available: true, rawMax: 870_000, publicMax: 870_000 }, withoutStorage: { available: true, rawMax: 200_000, publicMax: 200_000 } },
      settings: {}, text: "А какие удобства в офисе?", attachments: []
    });

    expect(output.result?.leadCardPatch.knowledgeRequest).toEqual({ required: true, reason: "missing_approved_answer" });
    expect(output.reply).toBe("В офисе есть зона ожидания, Wi‑Fi, вода и кулер; при необходимости поможем зарядить телефон.\n\nПо программе со стоянкой доступно до 870 000 сом. Сумма 1 000 000 сом по этой программе не проходит. Могу продолжить на сумму до 870 000 сом.");
  });

  it("replaces a repeated completed vehicle-value question with the next incomplete stage", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Подскажите, пожалуйста, сколько ориентировочно стоит автомобиль в сомах?",
      leadCardPatch: { vehicleValue: 2_000_000 }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите стоимость автомобиля.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000, requestedAmount: 1_000_000, requestedProgram: "without_storage" } as any,
      settings: {}, text: "Стоимость перепутал: 20к долларов", attachments: []
    });

    expect(output.reply).toBe("Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.");
  });

  it("never exposes Ailyn as a bot", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Да, я бот Айлин.",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "Ты бот?", attachments: [] });

    expect(output.reply).toBe("Я Айлин — виртуальный помощник по вопросам оформления новых займов. Если у Вас уже оформлен займ, пожалуйста, позвоните по телефону +996 502 108 108 или напишите в WhatsApp +996 776 108 108. Наши специалисты проверят информацию по Вашему договору и помогут решить Ваш вопрос.");
  });

  it("retries a malformed multimodal photo turn and persists the first valid retry", async () => {
    const malformed = { choices: [{ message: { content: JSON.stringify({ ...validResult, dialogueState: { ...validResult.dialogueState, stage: "not-a-stage" } }) } }] };
    const valid = { model: "one-model", choices: [{ message: { content: JSON.stringify(validResult) } }] };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValueOnce(malformed).mockResolvedValueOnce(valid) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "", attachments: [{ id: "id-front", mimeType: "image/jpeg", contentBase64: "abc" }] });
    expect(output.result).toMatchObject({ ...validResult, reply: withFirstContactGreeting(vehicleStageQuestion) });
    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    for (const [request] of client.createChatCompletion.mock.calls) {
      expect(request.messages[1].content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image_url" })]));
    }
    expect(client.createChatCompletion.mock.calls[1][0].messages[0].content).toContain("ПОВТОРНАЯ ПОПЫТКА");
  });

  it("retries a fetch failure without inline image data", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(validResult) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "", attachments: [{ id: "id-front", mimeType: "image/jpeg", contentBase64: "abc" }] });
    expect(output.result).toBeDefined();
    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(client.createChatCompletion.mock.calls[0][0].messages[1].content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image_url" })]));
    expect(client.createChatCompletion.mock.calls[1][0].messages[1].content).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "image_url" })]));
  });

  it("accepts attachments locally instead of sending a system fallback when RouterAI remains unavailable", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockRejectedValue(new TypeError("fetch failed")) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "", attachments: [{ id: "id-front", mimeType: "image/jpeg", contentBase64: "abc" }] });
    expect(output.model).toBe("local-attachment-recovery");
    expect(output.reply).toContain("Фотографии получили");
    expect(output.reply).not.toContain("не удалось обработать");
    expect(output.result?.attachments).toEqual([{ attachmentId: "id-front", type: "unknown", status: "received" }]);
  });

  it("uses the cheap normalizer after the main agent exhausts format attempts", async () => {
    const repaired = { ...validResult, leadCardPatch: { vehicleMake: "Toyota", vehicleYear: 2020 } };
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn()
        .mockResolvedValueOnce({ choices: [{ message: { content: "not json" } }] })
        .mockResolvedValueOnce({ choices: [{ message: { content: "not json" } }] })
        .mockResolvedValueOnce({ choices: [{ message: { content: "not json" } }] })
        .mockResolvedValueOnce({ model: "cheap-normalizer", choices: [{ message: { content: JSON.stringify(repaired) } }] })
    } as any;
    const pricing = { minimumLoan: 50_000, clientFacingMaximumField: "publicMax" as const, withoutStorage: { available: false as const, rawMax: null, publicMax: null, reason: "residence_unknown" as const }, parking: { available: false as const, rawMax: null, publicMax: null, monthlyRate: 2.4, dailyParkingFee: 130, reason: "residence_unknown" as const } };
    const currentTurnMessages = [{ index: 1, text: "Toyota" }, { index: 2, text: "2020" }];
    const history = Array.from({ length: 9 }, (_, index) => ({ author: "client", body: `вопрос ${index + 1}`, createdAt: "now" } as any));
    const output = await new AgentTurnService(client).run({ messages: history, facts: {}, settings: {}, text: "Toyota 2020", currentTurnMessages, pricing, attachments: [] });
    expect(output.reply).toBe(withFirstContactGreeting(vehicleStageQuestion));
    expect(output.model).toBe("cheap-normalizer");
    expect(output.promptVersion).toContain("normalizer");
    expect(client.createChatCompletion).toHaveBeenCalledTimes(4);
    expect(client.createChatCompletion.mock.calls[3][0].model).toBe("openai/gpt-4o-mini");
    const repairContext = JSON.parse(client.createChatCompletion.mock.calls[3][0].messages[1].content);
    expect(repairContext.currentTurnMessages).toEqual(currentTurnMessages);
    expect(repairContext.pricing).toEqual(pricing);
    expect(repairContext.history).toHaveLength(9);
  });

  it("preserves the model patch but replaces its programme question with the server stage", async () => {
    const response = {
      ...validResult,
      reply: "Спасибо. Можно рассмотреть вариант со стоянкой?",
      leadCardPatch: { requestedProgram: "without_storage" as const },
      preliminaryLimit: 2_000_000
    };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(response) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: { requestedProgram: "without_storage" }, settings: {}, text: "тогда со стоянкой", attachments: [] });

    expect(output.reply).toBe(`${withFirstContactGreeting("Спасибо.")}\n\n${vehicleStageQuestion}`);
    expect(output.result).toMatchObject({ reply: `${withFirstContactGreeting("Спасибо.")}\n\n${vehicleStageQuestion}`, preliminaryLimit: 2_000_000, leadCardPatch: { requestedProgram: "without_storage" } });
  });

  it("uses a semantic keep-car choice even when the model placed its routing field in leadCardPatch", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Поняла, тогда продолжим без изъятия.",
      leadCardPatch: { requestedProgram: "without_storage", limitChoice: "keep_car" }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "По программе без изъятия доступно до 600 000 сом. Сумма 700 000 сом по этой программе не проходит. Со стоянкой доступно до 2 000 000 сом. Могу продолжить либо на сумму до 600 000 сом без изъятия, либо перейти на программу со стоянкой.", createdAt: "now" } as any],
      facts: { requestedProgram: "without_storage", requestedAmount: 700_000 } as any,
      pricing: { minimumLoan: 50_000, clientFacingMaximumField: "publicMax", withoutStorage: { available: true, rawMax: 600_000, publicMax: 600_000 }, parking: { available: true, rawMax: 2_000_000, publicMax: 2_000_000 } },
      settings: {}, text: "мне нужна машина", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ requestedProgram: "without_storage", requestedAmount: 600_000 });
    expect(output.reply).toMatch(/продолжим по программе без изъятия на сумму 600 000 сом\./iu);
    expect(output.reply).not.toContain("Могу продолжить либо");
  });

  it("treats a bare refusal after the parking alternative as keeping the car at the without-storage limit", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Поняла.",
      limitChoice: "undecided",
      leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "По программе без изъятия доступно до 600 000 сом. Сумма 870 000 сом по этой программе не проходит. Со стоянкой доступно до 1 310 000 сом. Могу продолжить либо на сумму до 600 000 сом без изъятия, либо перейти на программу со стоянкой.", createdAt: "now" } as any],
      facts: { requestedProgram: "without_storage", requestedAmount: 870_000 } as any,
      pricing: { minimumLoan: 50_000, clientFacingMaximumField: "publicMax", withoutStorage: { available: true, rawMax: 600_000, publicMax: 600_000 }, parking: { available: true, rawMax: 1_310_000, publicMax: 1_310_000 } },
      settings: {}, text: "нет", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ requestedProgram: "without_storage", requestedAmount: 600_000 });
    expect(output.reply).toMatch(/продолжим по программе без изъятия на сумму 600 000 сом\./iu);
    expect(output.reply).not.toContain("Могу продолжить либо");
  });

  it("uses server-confirmed registration and the model's semantic interpretation for guarantor and family answers", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Продолжаем оформление, пришлите документы.", leadCardPatch: { requestedProgram: "without_storage", residenceText: "Каракол", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", residenceNeedsClarification: false }, dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "collect_documents" } }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, leadCardPatch: { guarantorAvailable: true } }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ decision: "accept" }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, leadCardPatch: { familyStatus: "married" } }) } }] })
    } as any;
    const service = new AgentTurnService(client);
    const region = await service.run({ messages: [{ author: "ai", body: "Подскажите, пожалуйста, Ваша прописка: Бишкек, Чуйская область или другой регион Кыргызстана?", createdAt: "now" } as any], facts: { requestedProgram: "without_storage" }, settings: {}, text: "Каракол", attachments: [] });
    const guarantor = await service.run({ messages: [{ author: "ai", body: "Есть ли у Вас поручитель?", createdAt: "now" } as any], facts: {}, settings: {}, text: "поручителя смогу привести", attachments: [] });
    const family = await service.run({ messages: [{ author: "ai", body: "Состоите ли Вы в браке?", createdAt: "now" } as any], facts: {}, settings: {}, text: "мы официально женаты", attachments: [] });

    expect(region.result?.leadCardPatch).toEqual(expect.objectContaining({ residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", residenceNeedsClarification: false }));
    expect(region.reply).not.toContain("Ваша прописка");
    expect(guarantor.result?.leadCardPatch.guarantorAvailable).toBe(true);
    expect(family.result?.leadCardPatch.familyStatus).toBe("married");
    expect(client.createChatCompletion).toHaveBeenCalledTimes(4);
  });

  it("does not repeat the residence question after the client names an other-region city", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Пожалуйста, отправьте фото ID и СТС с двух сторон.", leadCardPatch: { requestedProgram: "without_storage", residenceText: "Каракол", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", residenceNeedsClarification: false }, dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "collect_documents" } }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [{ author: "ai", body: "Подскажите, пожалуйста, Ваша прописка: Бишкек, Чуйская область или другой регион Кыргызстана.", createdAt: "now" } as any], facts: { vehicleMake: "Toyota", vehicleYear: 2020, vehicleValue: 1_000_000, requestedAmount: 200_000, requestedProgram: "without_storage" }, settings: {}, text: "Каракол", attachments: [] });

    expect(output.result?.leadCardPatch).toEqual(expect.objectContaining({ residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", residenceNeedsClarification: false }));
    expect(output.reply).not.toContain("Ваша прописка");
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("uses the client-named oblast instead of the model's other_region label", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Поняла, у Вас прописка в другом регионе Кыргызстана.",
      leadCardPatch: { residenceRegion: "other_region" }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 600_000, requestedProgram: "without_storage" } as any,
      settings: {}, text: "Ошская область", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({
      residenceRegion: "Другой регион Кыргызстана",
      residenceCategory: "OTHER_KG",
      residenceNeedsClarification: false
    });
    expect(output.reply).not.toContain("Вашу прописку");
    expect(output.reply).toContain("Сумма 600 000 сом по этой программе не проходит.");
  });

  it("keeps a model acknowledgement when the client says documents were already sent", async () => {
    const facts = {
      vehicleMake: "Toyota", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000,
      requestedProgram: "parking", residenceRegion: "Бишкек",
      documents: { id_front: "received", id_back: "received", vehicle_registration_front: "received", vehicle_registration_back: "received" }
    } as any;
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Извините, вижу, документы уже получены.", leadCardPatch: { familyStatus: "single" }, dialogueState: { stage: "COLLECTING_FAMILY_STATUS", status: "need_more_data", nextAction: "collect_family_status" } }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте фото ID / паспорта и СТС с двух сторон.", createdAt: "now" } as any],
      facts, settings: {}, text: "уже отправил", attachments: []
    });
    expect(output.reply).toMatch(/^Извините, вижу, документы уже получены\./u);
    expect(output.reply).not.toMatch(/отправьте.+(?:ID|СТС)/iu);
  });

  it("accepts a plain Chuy residence answer on the first model response", async () => {
    const withReadableResidence = {
      ...validResult,
      leadCardPatch: { residenceRegion: "Чуйская область", residenceCategory: "Чуйская область" },
      dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "Запросить документы" }
    };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(withReadableResidence) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [{ author: "ai", body: "Уточните прописку", createdAt: "2026-09-02" } as any], facts: { requestedProgram: "without_storage" }, settings: {}, text: "Чуйская область", attachments: [] });
    expect(output.result?.leadCardPatch).toEqual(expect.objectContaining({ residenceRegion: "Чуйская область", residenceCategory: "BISHKEK_CHUY" }));
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("preserves a repeated greeting supplied by the model", async () => {
    const repeatedGreeting = { ...validResult, reply: "Здравствуйте! Я Айлин, менеджер. Запись предварительная, менеджер её подтвердит." };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(repeatedGreeting) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [{ author: "ai", body: "Предыдущий ответ", createdAt: "2026-09-02" } as any], facts: {}, settings: {}, text: "завтра в 12", attachments: [] });
    expect(output.reply).toBe(`${repeatedGreeting.reply}\n\n${vehicleStageQuestion}`);
    expect(output.result?.reply).toBe(output.reply);
  });

  it("removes an unasked assistance offer after a bare first-contact greeting", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Привет! Как я могу помочь вам с новым займом?", leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "хай", attachments: [] });

    expect(output.reply).not.toMatch(/как\s+я\s+могу\s+помочь/iu);
    expect(output.reply).toContain("Подскажите, пожалуйста, модель и год выпуска автомобиля и ориентировочную стоимость автомобиля.");
  });

  it("repairs a shortened first-contact introduction to the approved greeting", async () => {
    const shortenedGreeting = { ...validResult, reply: "Здравствуйте! Я Айлин, помогу с оформлением нового займа. Подскажите модель автомобиля." };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(shortenedGreeting) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "здравствуйте", attachments: [] });

    expect(output.reply).toBe(withFirstContactGreeting(vehicleStageQuestion));
  });

  it("keeps the approved first-contact introduction once when the model repeats its title", async () => {
    const duplicatedGreeting = { ...validResult, reply: "Здравствуйте! Меня зовут Айлин. Я менеджер по оформлению новых займов автоломбарда «Молодой». Я менеджер по оформлению новых займов автоломбарда «Молодой». Подскажите модель автомобиля." };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(duplicatedGreeting) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "здравствуйте", attachments: [] });

    expect(output.reply).toBe(withFirstContactGreeting(vehicleStageQuestion));
  });

  it("removes a model greeting after the server has already greeted the client", async () => {
    const repeatedGreeting = { ...validResult, reply: "Здравствуйте! Меня зовут Айлин. Я менеджер по оформлению новых займов автоломбарда «Молодой». Информируем Вас, что мы не выдаем займ под залог автомобиля с регионом 10. Пока подожду Вашего сообщения." };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(repeatedGreeting) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: withFirstContactGreeting(vehicleStageQuestion), createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2015 }, settings: {}, text: "позже", attachments: []
    });

    expect(output.reply).toBe("Пока подожду Вашего сообщения.\n\nПодскажите, пожалуйста, ориентировочную стоимость автомобиля.");
    expect(output.reply).not.toContain("Здравствуйте!");
  });

  it("adds office hours before asking the client for a visit day and time", async () => {
    const visitQuestion = { ...validResult, reply: "Хорошо, оформим согласие при визите. На какой день и время Вам удобно подъехать?" };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(visitQuestion) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Предыдущий этап завершён", createdAt: "2026-09-02" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000,
        requestedAmount: 500_000, requestedProgram: "parking",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        documentsProvided: true, declinedCarPhoto: true, familyStatus: "single"
      } as any,
      settings: {}, text: "да", attachments: []
    });

    expect(output.reply).toBe("Хорошо, оформим согласие при визите.\n\nОфис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?");
  });

  it("does not repeat the residence question after residence is stored in the lead", async () => {
    const repeatedResidenceQuestion = { ...validResult, reply: "Хорошо, продолжаем по программе без изъятия. Подскажите, пожалуйста, Ваша прописка — Бишкек, Чуйская область или другой регион Кыргызстана?" };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(repeatedResidenceQuestion) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [{ author: "ai", body: "Выберите программу", createdAt: "2026-09-02" } as any], facts: { residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", requestedProgram: "without_storage" }, settings: {}, text: "без изъятия", attachments: [] });

    expect(output.reply).toBe("Хорошо, продолжаем по программе без изъятия.\n\nПодскажите, пожалуйста, модель и год выпуска автомобиля и ориентировочную стоимость автомобиля.");
  });

  it("removes a disguised regional-routing question after Tokmok has completed residence", async () => {
    const response = { ...validResult, reply: "Прописку приняла, спасибо. Подскажите, пожалуйста, куда сейчас направлять заявку: в Чуйскую область/Бишкек или в другую область?", leadCardPatch: {} };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(response) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите прописку.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_740_000, requestedAmount: 200_000, requestedProgram: "parking", residenceRegion: "Чуйская область", residenceCategory: "BISHKEK_CHUY" } as any,
      settings: {}, text: "Прописан в токмок", attachments: []
    });

    expect(output.reply).toBe("Прописку приняла, спасибо.\n\nПожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.");
  });

  it("removes a repeated registered-region question after Cholpon-Ata is already categorized", async () => {
    const response = { ...validResult, reply: "Спасибо. Подскажите, пожалуйста, Вы зарегистрированы в Бишкеке, Чуйской области или в другом регионе Кыргызстана?", leadCardPatch: {} };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(response) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите прописку.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_740_000, requestedAmount: 200_000, requestedProgram: "parking", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", residenceNeedsClarification: false } as any,
      settings: {}, text: "Я прописан в чтолпон ата", attachments: []
    });

    expect(output.reply).toBe("Спасибо.\n\nПожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.");
  });

  it("adds the next stage after a bare acknowledgement of a saved vehicle value", async () => {
    const response = { ...validResult, reply: "Спасибо.", hasMoney: true, leadCardPatch: { vehicleValue: 2_000_000 } };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(response) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Чтобы рассчитать максимум, подскажите стоимость автомобиля.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022 } as any,
      settings: {}, text: "где-то 2млн", attachments: []
    });

    expect(output.result?.leadCardPatch.vehicleValue).toBe(2_000_000);
    expect(output.reply).toBe("Спасибо.\n\nКакая сумма займа Вам необходима?");
  });

  it("does not treat an ambiguous request for a car as a parking-program choice", async () => {
    const response = { ...validResult, reply: "Если Вам нужна программа с изъятием автомобиля, тогда можем рассмотреть займ со стоянкой. По ней доступно до 1 000 000 сом.", leadCardPatch: {} };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(response) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "мне нужен авто", attachments: [] });

    expect(output.reply).toBe(withFirstContactGreeting("Вы хотите получить займ под залог своего автомобиля?"));
    expect(output.reply).not.toContain("стоянк");
    expect(output.reply).not.toContain("1 000 000");
  });

  it("replaces a model no-information fallback with an exact approved FAQ answer", async () => {
    const genericFallback = {
      ...validResult,
      reply: "К сожалению, у меня нет достоверной информации по этому вопросу. Когда Вы приедете, сотрудники с удовольствием подскажут Вам."
    };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(genericFallback) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "Нужно платить за оценку автомобиля?", attachments: [] });
    expect(output.reply).toBe(`${withFirstContactGreeting("Нет, оценка автомобиля бесплатна.")}\n\n${vehicleStageQuestion}`);
  });

  it("replaces a fallback with a direct question-answer pair from the DOCX", async () => {
    const genericFallback = {
      ...validResult,
      reply: "Пожалуйста, свяжитесь с нашими сотрудниками по телефону +996 502 108 108 или напишите менеджеру в WhatsApp +996 776 108 108."
    };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(genericFallback) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "Можно приехать на такси?", attachments: [] });
    expect(output.reply).toBe(`${withFirstContactGreeting("Да, конечно.")}\n\n${vehicleStageQuestion}`);
  });

  it("does not turn a question about region 10 into a region-10 refusal", async () => {
    const mistakenRefusal = {
      ...validResult,
      reply: "Автомобили с регионом 10 у нас не принимаются в залог по правилам компании.",
      leadCardPatch: { vehicleRegistrationRegion: "10" },
      dialogueState: { stage: "REFUSED", status: "refuse", nextAction: "refuse" }
    };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(mistakenRefusal) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [], facts: { vehicleModel: "Omoda", vehicleYear: 2010, vehicleValue: 4_000_000, requestedAmount: 700_000 }, settings: {},
      text: "а почему под 10 регион не даете", attachments: []
    });
    expect(output.result?.leadCardPatch.vehicleRegistrationRegion).toBeUndefined();
    expect(output.result?.dialogueState).toMatchObject({ stage: "COLLECTING_VEHICLE", status: "need_more_data" });
  });

  it("continues processing other messages when a region-10 policy question is in the same batch", async () => {
    const incompleteBatchReply = {
      ...validResult,
      reply: "Автомобили с регионом 10 у нас не принимаются в залог по правилам компании.",
      hasMoney: true,
      leadCardPatch: { vehicleModel: "Omoda", vehicleYear: 2010, vehicleValue: 4_000_000, requestedAmount: 700_000 }
    };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(incompleteBatchReply) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [], facts: {}, settings: {}, text: "а почему под 10 регион не даете\nомода 2010 года стоит 4 млн сом нужно 700 тыс",
      currentTurnMessages: [{ index: 1, text: "а почему под 10 регион не даете" }, { index: 2, text: "омода 2010 года стоит 4 млн сом нужно 700 тыс" }], attachments: []
    });
    expect(output.reply).toContain(OLDER_VEHICLE_PROGRAM_NOTICE);
    expect(output.reply).toContain("Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?");
    expect(output.result?.leadCardPatch).toMatchObject({ vehicleModel: "Omoda", vehicleYear: 2010, vehicleValue: 4_000_000, requestedAmount: 700_000 });
  });

  it("adds the approved older-vehicle notice once from the server", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Подскажите, пожалуйста, какую программу займа Вы выбираете?",
      leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: { vehicleModel: "Camry", vehicleYear: new Date().getFullYear() - 16, vehicleValue: 1_000_000, requestedAmount: 200_000 } as any,
      settings: {}, text: "без изъятия", attachments: []
    });

    expect(output.reply).toContain(OLDER_VEHICLE_PROGRAM_NOTICE);
    expect(output.reply.match(/автомобили старше 15 лет/giu)).toHaveLength(1);
  });

  it("does not add the older-vehicle notice at exactly 15 years or after it was already sent", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Подскажите, пожалуйста, какую программу займа Вы выбираете?",
      leadCardPatch: {}
    }) } }] }) } as any;
    const agent = new AgentTurnService(client);
    const currentYear = new Date().getFullYear();
    const baseFacts = { vehicleModel: "Camry", vehicleValue: 1_000_000, requestedAmount: 200_000 } as any;

    const exactlyFifteen = await agent.run({ messages: [], facts: { ...baseFacts, vehicleYear: currentYear - 15 }, settings: {}, text: "без изъятия", attachments: [] });
    const alreadyExplained = await agent.run({
      messages: [{ author: "ai", body: OLDER_VEHICLE_PROGRAM_NOTICE, createdAt: "before" } as any],
      facts: { ...baseFacts, vehicleYear: currentYear - 16 }, settings: {}, text: "без изъятия", attachments: []
    });

    expect(exactlyFifteen.reply).not.toContain(OLDER_VEHICLE_PROGRAM_NOTICE);
    expect(alreadyExplained.reply).not.toContain(OLDER_VEHICLE_PROGRAM_NOTICE);
  });

  it("keeps older-vehicle policy and client-fact echoing out of agent prompts", () => {
    const agentPrompt = readFileSync(new URL("../ai/prompts/agent.system.md", import.meta.url), "utf8");

    expect(agentPrompt).not.toMatch(/старше 15|15 лет/iu);
    expect(agentStageInstructions.application).not.toMatch(/старше 15|15 лет/iu);
    expect(agentPrompt).toContain("Никогда не цитируйте, не перечисляйте");
  });

  it("parses a valid model JSON without applying the log truncation limit", async () => {
    const long = { ...validResult, reply: "а".repeat(4000), cardSummary: "б".repeat(1000) };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(long) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "test", attachments: [] });
    expect(output.result?.reply).toHaveLength(`${withFirstContactGreeting(long.reply)}\n\n${vehicleStageQuestion}`.length);
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("accepts a numeric preliminary limit returned as a JSON string without retrying", async () => {
    const response = { ...validResult, preliminaryLimit: "600000" as any };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(response) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "датчик", attachments: [] });
    expect(output.result?.preliminaryLimit).toBe(600_000);
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("converts every explicit foreign-currency amount to som before the one model call", async () => {
    const integrations = { convertToSom: vi.fn().mockImplementation(async ({ amount, currency }: { amount: number; currency: string }) => ({ available: true, value: amount * 87, currency, rate: 87, nominal: 1, source: "NBKR", sourceUrl: "https://example.test", effectiveDate: "2026-09-02" })) } as any;
    const result = await resolveForeignCurrencyFacts("Мне нужно 6к долларов, авто стоит 20к", {}, integrations);
    expect(result.facts).toMatchObject({ requestedAmount: 520_000, requestedAmountSourceCurrency: "USD", vehicleValue: 1_740_000, vehicleValueSourceCurrency: "USD" });
    expect(result.clientText).toContain("6 000 долларов США — ориентировочно 520 000 сом");
    expect(result.clientText).toContain("20 000 долларов США — ориентировочно 1 740 000 сом");
    expect(integrations.convertToSom).toHaveBeenCalledTimes(2);
  });

  it("places the currency explanation after the greeting and removes an exact model duplicate", () => {
    const currency = "По официальному курсу НБКР: 6 000 долларов США — ориентировочно 524 700 сом.";
    const reply = composeReply(`Здравствуйте! Я Айлин, менеджер. ${currency}\n\nПодскажите год автомобиля. ${currency}`, currency);
    expect(reply).toBe("Здравствуйте! Я Айлин, менеджер.\n\nПо официальному курсу НБКР: 6 000 долларов США — ориентировочно 524 700 сом.\n\nПодскажите год автомобиля.");
  });

  it("places the currency explanation after the complete approved introduction", () => {
    const greeting = "Здравствуйте! Меня зовут Айлин. Я менеджер по оформлению новых займов автоломбарда «Молодой».";
    const currency = "По текущему курсу НБКР: • Стоимость автомобиля: 20 000 долларов США — ориентировочно 1 740 000 сом.";
    expect(composeReply(`${greeting} Подскажите программу.`, currency)).toBe(`${greeting}\n\n${currency}\n\nПодскажите программу.`);
  });

  it("removes reformulated currency echoes from the model reply", () => {
    const currency = "По текущему курсу НБКР:\n• Стоимость автомобиля: 30 000 долларов США — ориентировочно 2 610 000 сом.\n• Необходимая сумма займа: 10 000 долларов США — ориентировочно 870 000 сом.";
    const reply = composeReply("• Camry — автомобиль ориентировочно 2 610 000 сом. • 10 000 USD, ориентировочно 870 000 сом. Подскажите программу.", currency);
    expect(reply).toBe(`${currency}\n\nПодскажите программу.`);
  });

  it("persists a validated patch and preserves the public result shape", async () => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "Toyota", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue(["vehicleMake", "vehicleYear"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const agent = { run: vi.fn().mockResolvedValue({ result: validResult, reply: validResult.reply, model: "one-model", promptVersion: "single-agent" }) } as any;
    const service = new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any);
    const result = await service.receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "Toyota", attachments: [], timestamp: new Date() });
    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({
      ...validResult.leadCardPatch,
      language: "ru",
      stageCompletion: expect.objectContaining({ vehicle: false, readyForVisit: false })
    }));
    expect(store.saveAgentState).toHaveBeenCalledWith(application, expect.objectContaining({ cardSummary: validResult.cardSummary }));
    expect(result).toEqual(expect.objectContaining({ reply: validResult.reply, application, conversation, validation: { passed: true, errors: [] } }));
  });

  it("persists document inventory from current-turn attachment classifications", async () => {
    const application = { id: "app", facts: { vehicleMake: "Toyota", vehicleYear: 2020, vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "parking", residenceRegion: "Бишкек" }, contactId: "contact", stage: "COLLECTING_DOCUMENTS", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const attachments = [{ id: "front", type: "id_front" as const, status: "received" as const }, { id: "back", type: "id_back" as const, status: "received" as const }];
    const agentResult = { ...validResult, attachments, dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "collect_documents" } };
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue(["documents"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const service = new DialogueOrchestratorService({ run: vi.fn().mockResolvedValue({ result: agentResult, reply: agentResult.reply, model: "one", promptVersion: "v1" }) } as any, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any);
    await service.receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", attachments: [{ id: "front" }, { id: "back" }], timestamp: new Date() });
    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ documents: expect.objectContaining({ id_front: "received", id_back: "received" }), documentsProvided: true }));
    expect(store.addAttachment).toHaveBeenCalledTimes(2);
  });

  it("closes the document stage on any upload, keeps a readable FIO, and removes stale confirmations", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Пожалуйста, отправьте фото ID и свидетельства. У Вас всё ещё актуальна сумма 400 000 сом и программа со стоянкой?",
      leadCardPatch: { fullName: "Иванов Иван Иванович" }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 400_000, requestedProgram: "parking", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" } as any,
      settings: {}, text: "", attachments: [{ id: "id", mimeType: "image/jpeg" }, { id: "sts", mimeType: "image/jpeg" }]
    });

    expect(output.result?.leadCardPatch).toMatchObject({ fullName: "Иванов Иван Иванович", documentsProvided: true });
    expect(output.reply).toContain("2–3 фотографии автомобиля");
    expect(output.reply).not.toContain("фото ID");
    expect(output.reply).not.toContain("всё ещё актуальна");
  });

  it("unconditionally accepts uploads and continues to the next stage without promising a re-check", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Фотографии получили. Если какой-то снимок окажется неразборчивым, я уточню нужную сторону.",
      leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 400_000, requestedProgram: "parking", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" } as any,
      settings: {}, text: "", attachments: [{ id: "unexpected-photo", mimeType: "image/jpeg" }]
    });

    expect(output.result?.leadCardPatch.documentsProvided).toBe(true);
    expect(output.reply).toBe("Фотографии получены. Продолжаем оформление.\n\nПожалуйста, отправьте 2–3 фотографии автомобиля.");
    expect(output.reply).not.toMatch(/уточн|неразборчив|пересн|дослать/iu);
  });

  it("keeps accepted STS sides when ID photos arrive in the next message", async () => {
    const application = {
      id: "app",
      facts: {
        vehicleMake: "Toyota", vehicleYear: 2020, vehicleValue: 1_000_000, requestedAmount: 300_000,
        requestedProgram: "parking", residenceRegion: "Бишкек",
        documents: { vehicle_registration_front: "received", vehicle_registration_back: "received" }
      },
      contactId: "contact", stage: "COLLECTING_DOCUMENTS", status: "need_more_data"
    } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const agentResult = {
      ...validResult,
      reply: "Спасибо. Подскажите, пожалуйста, состоите ли Вы в браке?",
      attachments: [
        { attachmentId: "id-front", type: "id_front" as const, status: "received" as const },
        { attachmentId: "id-back", type: "id_back" as const, status: "received" as const }
      ],
      dialogueState: { stage: "COLLECTING_FAMILY_STATUS", status: "need_more_data", nextAction: "collect_family_status" }
    };
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue(["documents"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const service = new DialogueOrchestratorService({ run: vi.fn().mockResolvedValue({ result: agentResult, reply: agentResult.reply, model: "one", promptVersion: "v1" }) } as any, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any);

    await service.receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", attachments: [{ id: "id-front" }, { id: "id-back" }], timestamp: new Date() });

    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({
      documents: {
        vehicle_registration_front: "received",
        vehicle_registration_back: "received",
        id_front: "received",
        id_back: "received"
      }
    }));
  });

  it("moves on after documents received in any order instead of requesting STS again", async () => {
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
        ...validResult,
        reply: "Спасибо, документы приняты.",
        attachments: [
          { attachmentId: "id-front", type: "id_front", status: "received" },
          { attachmentId: "id-back", type: "id_back", status: "received" }
        ]
      }) } }] })
    } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Спасибо. Пожалуйста, отправьте ещё фото паспорта (ID): лицевая и обратная стороны.", createdAt: "now" } as any],
      facts: {
        vehicleMake: "Toyota", vehicleYear: 2020, vehicleValue: 1_000_000, requestedAmount: 300_000,
        requestedProgram: "parking", residenceRegion: "Бишкек",
        documents: { vehicle_registration_front: "received", vehicle_registration_back: "received" }
      },
      settings: {}, text: "", attachments: [{ id: "id-front" }, { id: "id-back" }]
    });

    expect(output.result?.leadCardPatch.documents).toEqual({
      vehicle_registration_front: "received",
      vehicle_registration_back: "received",
      id_front: "received",
      id_back: "received"
    });
    expect(output.result?.targetEvent).toBeNull();
    expect(output.reply).toBe("Спасибо, документы приняты.\n\nПодскажите, пожалуйста, модель и год выпуска автомобиля.");
  });

  it("persists uploaded files even when the agent returns no result", async () => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "COLLECTING_DOCUMENTS", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "", createdAt: "now" }), updateFacts: vi.fn(), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const service = new DialogueOrchestratorService({ run: vi.fn().mockResolvedValue({ reply: "Временный ответ", model: "unavailable", promptVersion: "v1", error: "fetch failed" }) } as any, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any);
    await service.receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", attachments: [{ id: "front" }, { id: "back" }], timestamp: new Date() });
    expect(store.addAttachment).toHaveBeenCalledTimes(2);
    expect(store.addAttachment).toHaveBeenCalledWith(expect.objectContaining({ type: "unknown", status: "received" }));
  });

  it("stores the deterministic selected-program limit instead of the model proposal", async () => {
    const application = { id: "app", facts: { vehicleMake: "Toyota", vehicleYear: 2020, vehicleValue: 1_900_000, requestedAmount: 300_000, requestedProgram: "parking", residenceRegion: "Бишкек" }, contactId: "contact", stage: "COLLECTING_DOCUMENTS", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const result = { ...validResult, preliminaryLimit: 2_000_000, dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "collect_documents" } };
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const service = new DialogueOrchestratorService({ run: vi.fn().mockResolvedValue({ result, reply: result.reply, model: "one", promptVersion: "v1" }) } as any, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any);
    await service.receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", attachments: [], timestamp: new Date() });
    expect(store.saveAgentState).toHaveBeenCalledWith(application, expect.objectContaining({ preliminaryLimit: 950_000 }));
  });

  it("uses the model target event when creating a manager notification", async () => {
    const application = { id: "app", facts: { vehicleMake: "Toyota", vehicleYear: 2020, vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "parking", residenceRegion: "Бишкек" }, contactId: "contact", stage: "COLLECTING_DOCUMENTS", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const result = { ...validResult, targetEvent: "documents" as const, dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "collect_documents" } };
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const service = new DialogueOrchestratorService({ run: vi.fn().mockResolvedValue({ result, reply: result.reply, model: "one", promptVersion: "v1" }) } as any, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any);

    await service.receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", attachments: [], timestamp: new Date() });

    expect(store.createManagerNotification).toHaveBeenCalledWith(application, "initial", expect.objectContaining({ event: "documents" }));
  });

  it("creates exactly one initial manager card after the target event", async () => {
    const target = { ...validResult, targetEvent: "documents", managerUpdate: { kind: "initial" as const, changedFields: [] } };
    const application = { id: "app", facts: { vehicleMake: "Toyota", vehicleYear: 2020, vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "parking", residenceRegion: "Бишкек", documents: { id_front: "received", id_back: "received", vehicle_registration_front: "received", vehicle_registration_back: "received" } }, contactId: "contact" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn().mockResolvedValue(true) } as any;
    const service = new DialogueOrchestratorService({ run: vi.fn().mockResolvedValue({ result: target, reply: target.reply, model: "one", promptVersion: "v1" }) } as any, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any);
    await service.receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", attachments: [], timestamp: new Date() });
    expect(store.createManagerNotification).toHaveBeenCalledWith(application, "initial", expect.objectContaining({ event: "documents" }));
    expect(store.updateFacts).toHaveBeenLastCalledWith(application, { handedToManager: true });
  });
});
