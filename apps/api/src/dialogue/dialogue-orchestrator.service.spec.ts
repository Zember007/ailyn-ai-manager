import { describe, expect, it, vi } from "vitest";
import { AgentTurnService } from "./agent-turn.service.js";
import { DialogueOrchestratorService, composeReply, resolveForeignCurrencyFacts, resolveNormalizedMoneyFacts } from "./dialogue-orchestrator.service.js";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
process.env.REDIS_URL ??= "redis://localhost:6379";

const validResult = {
  reply: "Подскажите, пожалуйста, модель и год выпуска автомобиля.", hasMoney: false, needsKnowledgeLookup: false, language: "ru", intent: "new_loan", leadCardPatch: { vehicleMake: "Toyota", vehicleYear: 2020 }, cardSummary: "Toyota 2020, ожидаются остальные данные.",
  dialogueState: { stage: "COLLECTING_VALUE", status: "need_more_data", nextAction: "Запросить стоимость" }, targetEvent: null,
  managerUpdate: { kind: "none", changedFields: [] }, attachments: []
};

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

  it("runs foreign-currency normalization even when the agent misses hasMoney", async () => {
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

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(agent.normalizeMoney).toHaveBeenCalledTimes(1);
    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ requestedAmount: 520_000, requestedAmountSourceCurrency: "USD" }));
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

    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ vehicleValue: 1_740_000, vehicleValueSourceCurrency: "USD", requestedAmount: 100_000 }));
    expect(result.reply).toContain("20 000 долларов США — ориентировочно 1 740 000 сом");
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

  it("reruns an atypical question with targeted knowledge when the main agent requests it", async () => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "а вы датчики на машину ставите", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const agent = { run: vi.fn()
      .mockResolvedValueOnce({ result: { ...validResult, needsKnowledgeLookup: true }, reply: "Уточняю информацию.", model: "one", promptVersion: "v1" })
      .mockResolvedValueOnce({ result: { ...validResult, needsKnowledgeLookup: false, reply: "Да, на автомобиль устанавливаем GPS/трекер (датчик)." }, reply: "Да, на автомобиль устанавливаем GPS/трекер (датчик).", model: "one", promptVersion: "v1" }) } as any;

    const output = await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "а вы датчики на машину ставите", attachments: [], timestamp: new Date() });

    expect(agent.run).toHaveBeenCalledTimes(2);
    expect(agent.run.mock.calls[1][0]).toEqual(expect.objectContaining({ knowledgeLookup: true }));
    expect(output.reply).toBe("Да, на автомобиль устанавливаем GPS/трекер (датчик).");
  });

  it("normalizes both monetary roles through the model contract", async () => {
    process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ values: [
      { field: "vehicleValue", amount: 21_000, currency: "USD", confidence: 0.99 },
      { field: "requestedAmount", amount: 10_000, currency: "USD", confidence: 0.99 }
    ] }) } }] }) } as any;
    const result = await new AgentTurnService(client).normalizeMoney({ text: "камри 2023 стоит 21 к долларов надо 10", facts: {}, messages: [] });
    expect(result).toEqual([
      { field: "vehicleValue", amount: 21_000, currency: "USD", confidence: 0.99 },
      { field: "requestedAmount", amount: 10_000, currency: "USD", confidence: 0.99 }
    ]);
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
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
    expect(context.stageInstructions.some((instruction: string) => instruction.includes("вопрос «без изъятия или со стоянкой?» на этом этапе абсолютно запрещён"))).toBe(true);
    expect(context.stageInstructions.some((instruction: string) => instruction.includes("Запрещены любые мета-вопросы"))).toBe(true);
    expect(context.pricing.withoutStorage).toMatchObject({ available: true, publicMax: 400_000 });
    expect(context.pricing.residence).toEqual({ category: "BISHKEK_CHUY", residenceRegion: "Чуйская область" });
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

  it("uses one multimodal model call with full history and knowledge", async () => {
    process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ model: "one-model", choices: [{ message: { content: JSON.stringify(validResult) } }] }) } as any;
    const service = new AgentTurnService(client);
    const facts = { fullName: "Иван", vehicleMake: "Toyota", documents: { id_front: "received" }, visitRequested: true, visitDate: "2026-09-04" } as any;
    const output = await service.run({ messages: [{ author: "client", body: "Старая реплика", createdAt: "2026-01-01" } as any], facts, settings: { parkingInterestRate: 2.4 }, text: "Toyota 2020", attachments: [{ id: "photo", mimeType: "image/jpeg", contentBase64: "abc" }] });
    expect(output.result).toEqual({ ...validResult, leadCardPatch: { ...validResult.leadCardPatch, ...facts } });
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
    const request = client.createChatCompletion.mock.calls[0][0];
    expect(request.model).toBe(process.env.ROUTERAI_TEXT_MODEL ?? "routerai-text-model-not-configured");
    expect(request.response_format).toEqual({ type: "json_object" });
    expect(JSON.stringify(request.messages)).toContain("Старая реплика");
    const context = JSON.parse((request.messages[1].content as Array<{ type: string; text?: string }>)[0].text ?? "{}");
    expect(context.leadCard).toEqual(facts);
    expect(context.history).toEqual([{ author: "client", text: "Старая реплика", createdAt: "2026-01-01" }]);
    expect(context.knowledge.length).toBeLessThan(15);
    expect(context.commonKnowledge.length).toBeGreaterThan(0);
    expect(context.commonKnowledge.length).toBeLessThan(10);
    expect(context.commonKnowledge.some((chunk: { section: string }) => chunk.section === "5.1")).toBe(true);
    expect(context.relevantStages).toContain("application");
    expect(request.messages[1].content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image_url" })]));
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
    expect(output.result).toEqual(expect.objectContaining({ leadCardPatch: { residenceRegion: "Другой регион Кыргызстана" } }));
    expect(output.result?.preliminaryLimit).toBe(200_000);
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it("retries a malformed multimodal photo turn and persists the first valid retry", async () => {
    const malformed = { choices: [{ message: { content: JSON.stringify({ ...validResult, dialogueState: { ...validResult.dialogueState, stage: "not-a-stage" } }) } }] };
    const valid = { model: "one-model", choices: [{ message: { content: JSON.stringify(validResult) } }] };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValueOnce(malformed).mockResolvedValueOnce(valid) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "", attachments: [{ id: "id-front", mimeType: "image/jpeg", contentBase64: "abc" }] });
    expect(output.result).toEqual(validResult);
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
    expect(output.reply).toBe(repaired.reply);
    expect(output.model).toBe("cheap-normalizer");
    expect(output.promptVersion).toContain("normalizer");
    expect(client.createChatCompletion).toHaveBeenCalledTimes(4);
    expect(client.createChatCompletion.mock.calls[3][0].model).toBe("openai/gpt-4o-mini");
    const repairContext = JSON.parse(client.createChatCompletion.mock.calls[3][0].messages[1].content);
    expect(repairContext.currentTurnMessages).toEqual(currentTurnMessages);
    expect(repairContext.pricing).toEqual(pricing);
    expect(repairContext.history).toHaveLength(9);
  });

  it("preserves the model reply and programme patch without local interpretation", async () => {
    const response = {
      ...validResult,
      reply: "Спасибо. Можно рассмотреть вариант со стоянкой?",
      leadCardPatch: { requestedProgram: "without_storage" as const },
      preliminaryLimit: 2_000_000
    };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(response) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: { requestedProgram: "without_storage" }, settings: {}, text: "тогда со стоянкой", attachments: [] });

    expect(output.reply).toBe(response.reply);
    expect(output.result).toMatchObject({ reply: response.reply, preliminaryLimit: 2_000_000, leadCardPatch: { requestedProgram: "without_storage" } });
  });

  it("uses the model's semantic interpretation for flexible registration, guarantor and family answers", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Продолжаем оформление, пришлите документы.", leadCardPatch: { requestedProgram: "without_storage", residenceText: "я не из бишкека и не из чуя", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", residenceNeedsClarification: false }, dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "collect_documents" } }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, leadCardPatch: { guarantorAvailable: true } }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, leadCardPatch: { familyStatus: "married" } }) } }] })
    } as any;
    const service = new AgentTurnService(client);
    const region = await service.run({ messages: [{ author: "ai", body: "Подскажите, пожалуйста, Ваша прописка: Бишкек, Чуйская область или другой регион Кыргызстана?", createdAt: "now" } as any], facts: { requestedProgram: "without_storage" }, settings: {}, text: "я не из бишкека и не из чуя", attachments: [] });
    const guarantor = await service.run({ messages: [{ author: "ai", body: "Есть ли у Вас поручитель?", createdAt: "now" } as any], facts: {}, settings: {}, text: "поручителя смогу привести", attachments: [] });
    const family = await service.run({ messages: [{ author: "ai", body: "Состоите ли Вы в браке?", createdAt: "now" } as any], facts: {}, settings: {}, text: "мы официально женаты", attachments: [] });

    expect(region.result?.leadCardPatch).toEqual(expect.objectContaining({ residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", residenceNeedsClarification: false }));
    expect(region.reply).not.toContain("Ваша прописка");
    expect(guarantor.result?.leadCardPatch.guarantorAvailable).toBe(true);
    expect(family.result?.leadCardPatch.familyStatus).toBe("married");
    expect(client.createChatCompletion).toHaveBeenCalledTimes(3);
  });

  it("does not repeat the residence question after the exact other-region answer", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Пожалуйста, отправьте фото ID и СТС с двух сторон.", leadCardPatch: { requestedProgram: "without_storage", residenceText: "другой регион Кыргызстана", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", residenceNeedsClarification: false }, dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "collect_documents" } }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [{ author: "ai", body: "Подскажите, пожалуйста, Ваша прописка: Бишкек; Чуйская область; другой регион Кыргызстана.", createdAt: "now" } as any], facts: { vehicleMake: "Toyota", vehicleYear: 2020, vehicleValue: 1_000_000, requestedAmount: 200_000, requestedProgram: "without_storage" }, settings: {}, text: "другой регион Кыргызстана", attachments: [] });

    expect(output.result?.leadCardPatch).toEqual(expect.objectContaining({ residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", residenceNeedsClarification: false }));
    expect(output.reply).not.toContain("Ваша прописка");
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
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
    expect(output.reply).toBe(repeatedGreeting.reply);
    expect(output.result?.reply).toBe(output.reply);
  });

  it("repairs a shortened first-contact introduction to the approved greeting", async () => {
    const shortenedGreeting = { ...validResult, reply: "Здравствуйте! Я Айлин, помогу с оформлением нового займа. Подскажите модель автомобиля." };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(shortenedGreeting) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "здравствуйте", attachments: [] });

    expect(output.reply).toBe("Здравствуйте! Меня зовут Айлин. Я менеджер по оформлению новых займов автоломбарда «Молодой». Подскажите модель автомобиля.");
  });

  it("keeps the approved first-contact introduction once when the model repeats its title", async () => {
    const duplicatedGreeting = { ...validResult, reply: "Здравствуйте! Меня зовут Айлин. Я менеджер по оформлению новых займов автоломбарда «Молодой». Я менеджер по оформлению новых займов автоломбарда «Молодой». Подскажите модель автомобиля." };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(duplicatedGreeting) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "здравствуйте", attachments: [] });

    expect(output.reply).toBe("Здравствуйте! Меня зовут Айлин. Я менеджер по оформлению новых займов автоломбарда «Молодой». Подскажите модель автомобиля.");
  });

  it("adds office hours before asking the client for a visit day and time", async () => {
    const visitQuestion = { ...validResult, reply: "Хорошо, оформим согласие при визите. На какой день и время Вам удобно подъехать?" };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(visitQuestion) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [{ author: "ai", body: "Предыдущий этап завершён", createdAt: "2026-09-02" } as any], facts: {}, settings: {}, text: "да", attachments: [] });

    expect(output.reply).toBe("Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. Хорошо, оформим согласие при визите. На какой день и время Вам удобно подъехать?");
  });

  it("does not repeat the residence question after residence is stored in the lead", async () => {
    const repeatedResidenceQuestion = { ...validResult, reply: "Хорошо, продолжаем по программе без изъятия. Подскажите, пожалуйста, Ваша прописка — Бишкек, Чуйская область или другой регион Кыргызстана?" };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(repeatedResidenceQuestion) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [{ author: "ai", body: "Выберите программу", createdAt: "2026-09-02" } as any], facts: { residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", requestedProgram: "without_storage" }, settings: {}, text: "без изъятия", attachments: [] });

    expect(output.reply).toBe("Хорошо, продолжаем по программе без изъятия.");
  });

  it("replaces a model no-information fallback with an exact approved FAQ answer", async () => {
    const genericFallback = {
      ...validResult,
      reply: "К сожалению, у меня нет достоверной информации по этому вопросу. Когда Вы приедете, сотрудники с удовольствием подскажут Вам."
    };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(genericFallback) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "Нужно платить за оценку автомобиля?", attachments: [] });
    expect(output.reply).toBe("Нет, оценка автомобиля бесплатна.");
  });

  it("replaces a fallback with a direct question-answer pair from the DOCX", async () => {
    const genericFallback = {
      ...validResult,
      reply: "Пожалуйста, свяжитесь с нашими сотрудниками по телефону +996 502 108 108 или напишите менеджеру в WhatsApp +996 776 108 108."
    };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(genericFallback) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "Можно приехать на такси?", attachments: [] });
    expect(output.reply).toBe("Да, конечно.");
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
    expect(output.reply).toContain("По автомобилю: ему больше 15 лет");
    expect(output.reply).toContain("Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?");
    expect(output.result?.leadCardPatch).toMatchObject({ vehicleModel: "Omoda", vehicleYear: 2010, vehicleValue: 4_000_000, requestedAmount: 700_000 });
  });

  it("parses a valid model JSON without applying the log truncation limit", async () => {
    const long = { ...validResult, reply: "а".repeat(4000), cardSummary: "б".repeat(1000) };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(long) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "test", attachments: [] });
    expect(output.result?.reply).toHaveLength(4000);
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
    expect(store.updateFacts).toHaveBeenCalledWith(application, { ...validResult.leadCardPatch, language: "ru" });
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
    expect(output.reply).toBe("Спасибо, документы приняты.");
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
