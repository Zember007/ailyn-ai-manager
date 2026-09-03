import { describe, expect, it, vi } from "vitest";
import { AgentTurnService, interpretCurrentTurn } from "./agent-turn.service.js";
import { DialogueOrchestratorService, composeReply, resolveForeignCurrencyFacts } from "./dialogue-orchestrator.service.js";

const validResult = {
  reply: "Подскажите, пожалуйста, модель и год выпуска автомобиля.", language: "ru", intent: "new_loan", leadCardPatch: { vehicleMake: "Toyota", vehicleYear: 2020 }, cardSummary: "Toyota 2020, ожидаются остальные данные.",
  dialogueState: { stage: "COLLECTING_VALUE", status: "need_more_data", nextAction: "Запросить стоимость" }, targetEvent: null,
  managerUpdate: { kind: "none", changedFields: [] }, attachments: []
};

describe("single-agent dialogue", () => {
  it("uses one multimodal model call with full history and knowledge", async () => {
    process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ model: "one-model", choices: [{ message: { content: JSON.stringify(validResult) } }] }) } as any;
    const service = new AgentTurnService(client);
    const output = await service.run({ messages: [{ author: "client", body: "Старая реплика", createdAt: "2026-01-01" } as any], facts: { fullName: "Иван" }, settings: { parkingInterestRate: 2.4 }, text: "Toyota 2020", attachments: [{ id: "photo", mimeType: "image/jpeg", contentBase64: "abc" }] });
    expect(output.result).toEqual({ ...validResult, leadCardPatch: { ...validResult.leadCardPatch, fullName: "Иван" } });
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
    const request = client.createChatCompletion.mock.calls[0][0];
    expect(request.model).toBe(process.env.ROUTERAI_TEXT_MODEL ?? "routerai-text-model-not-configured");
    expect(request.response_format).toEqual({ type: "json_object" });
    expect(JSON.stringify(request.messages)).toContain("Старая реплика");
    expect(JSON.stringify(request.messages)).toContain("docx_0001");
    expect(JSON.stringify(request.messages)).toContain("Б. Молодой Гвардии, 22, Бишкек");
    expect(JSON.stringify(request.messages)).toContain("+996 502 108 108");
    const context = JSON.parse((request.messages[1].content as Array<{ type: string; text?: string }>)[0].text ?? "{}");
    expect(context.knowledge.length).toBeGreaterThan(8);
    expect(context.knowledge.length).toBeLessThan(100);
    expect(request.messages[1].content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image_url" })]));
  });

  it("ignores derived or unknown fields inside the lead card patch", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, preliminaryLimit: 200000, leadCardPatch: { residenceRegion: "OTHER_KG", preliminaryLimit: 200000, arbitrary: true } }) } }] }) } as any;
    const logs = { warn: vi.fn().mockResolvedValue(undefined) } as any;
    const output = await new AgentTurnService(client, logs).run({ conversationId: "conversation-1", messages: [], facts: {}, settings: {}, text: "test", attachments: [] });
    expect(output.result).toEqual(expect.objectContaining({ preliminaryLimit: 200000, leadCardPatch: { residenceRegion: "Другой регион Кыргызстана" } }));
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

  it("persists an explicit divorce status and a relative visit in normalized fields", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "Я в разводе, в 5 в четверг", attachments: [] });
    expect(output.result?.leadCardPatch).toEqual(expect.objectContaining({ familyStatus: "divorced", visitRequested: true, visitTime: "17:00" }));
    expect(output.result?.leadCardPatch.visitDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("preserves a document-chat refusal and lets the latest family-status correction win", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, leadCardPatch: { familyStatus: "divorced" } }) } }] }) } as any;
    const service = new AgentTurnService(client);
    const refusal = await service.run({ messages: [], facts: {}, settings: {}, text: "не буду отправлять документы в чате", attachments: [] });
    const correction = await service.run({ messages: [], facts: { familyStatus: "divorced", declinedDocuments: true }, settings: {}, text: "а нет, в браке", attachments: [] });
    expect(refusal.result?.leadCardPatch).toEqual(expect.objectContaining({ declinedDocuments: true }));
    expect(correction.result?.leadCardPatch).toEqual(expect.objectContaining({ familyStatus: "married", declinedDocuments: true }));
    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("normalizes tomorrow at noon before the model writes its reply", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "завтра, в 12", attachments: [] });
    expect(output.result?.leadCardPatch).toEqual(expect.objectContaining({ visitRequested: true, visitTime: "12:00" }));
    expect(output.result?.leadCardPatch.visitDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(JSON.stringify(client.createChatCompletion.mock.calls[0][0].messages)).toContain("interpretedCurrentMessage");
  });

  it("makes an explicit current amount and program override a stale model patch", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, leadCardPatch: { requestedAmount: 200_000, requestedProgram: "without_storage" } }) } }] }) } as any;
    const service = new AgentTurnService(client);
    const amount = await service.run({ messages: [], facts: { requestedAmount: 200_000, vehicleValue: 1_000_000 }, settings: {}, text: "нет, надо 450 тысяч", attachments: [] });
    const program = await service.run({ messages: [], facts: { requestedProgram: "without_storage" }, settings: {}, text: "тогда давайте на стоянку", attachments: [] });
    const hypothetical = interpretCurrentTurn({ text: "а если на стоянку сколько дадите", facts: { requestedProgram: "without_storage" }, messages: [] });

    expect(amount.result?.leadCardPatch.requestedAmount).toBe(450_000);
    expect(program.result?.leadCardPatch.requestedProgram).toBe("parking");
    expect(hypothetical.facts.requestedProgram).toBeUndefined();
  });

  it("binds a short yes to the last unresolved guarantor question", () => {
    const interpreted = interpretCurrentTurn({
      text: "да",
      facts: {},
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, есть ли у Вас поручитель?", createdAt: "now" } as any]
    });
    expect(interpreted.facts.guarantorAvailable).toBe(true);
  });

  it("corrects a model stage that skips an unresolved required amount", async () => {
    const proposed = { ...validResult, dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "continue", nextAction: "request_documents" } };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(proposed) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: { vehicleMake: "Toyota", vehicleYear: 2020, vehicleValue: 1_000_000 }, settings: {}, text: "", attachments: [] });
    expect(output.result?.dialogueState).toEqual(expect.objectContaining({ stage: "COLLECTING_AMOUNT", status: "need_more_data" }));
  });

  it("retries a schema-valid reply that asks for an already received ID side", async () => {
    const facts = { vehicleMake: "Toyota", vehicleYear: 2020, vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "parking", residenceRegion: "Бишкек", documents: { id_front: "received", id_back: "received", vehicle_registration_front: "received", vehicle_registration_back: "received" } } as any;
    const invalid = { ...validResult, reply: "Пришлите, пожалуйста, лицевую сторону ID.", dialogueState: { stage: "SCHEDULING_VISIT", status: "need_more_data", nextAction: "schedule_visit" } };
    const fixed = { ...validResult, reply: "Подскажите, пожалуйста, удобные дату и время визита.", dialogueState: { stage: "SCHEDULING_VISIT", status: "need_more_data", nextAction: "schedule_visit" } };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(invalid) } }] }).mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(fixed) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts, settings: {}, text: "", attachments: [] });
    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(output.reply).toBe(fixed.reply);
  });

  it("retries a preliminary limit that conflicts with the deterministic value", async () => {
    const facts = { vehicleMake: "Toyota", vehicleYear: 2020, vehicleValue: 1_900_000, requestedAmount: 300_000, requestedProgram: "parking", residenceRegion: "Бишкек" } as any;
    const conflict = { ...validResult, preliminaryLimit: 2_000_000, dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "collect_documents" } };
    const fixed = { ...conflict, preliminaryLimit: 950_000 };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(conflict) } }] }).mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(fixed) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts, settings: {}, text: "", attachments: [] });
    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(output.result?.preliminaryLimit).toBe(950_000);
  });

  it("retries a reply that keeps the old program after an explicit switch", async () => {
    const invalid = { ...validResult, reply: "По программе без изъятия продолжим оформление." };
    const fixed = { ...validResult, reply: "По программе со стоянкой продолжим оформление." };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(invalid) } }] }).mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(fixed) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: { requestedProgram: "without_storage" }, settings: {}, text: "тогда давайте на стоянку", attachments: [] });
    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(output.result?.leadCardPatch.requestedProgram).toBe("parking");
    expect(output.reply).toBe(fixed.reply);
  });

  it("accepts a plain Chuy residence answer on the first model response", async () => {
    const withReadableResidence = {
      ...validResult,
      leadCardPatch: { residenceRegion: "Чуйская область", residenceCategory: "Чуйская область" },
      dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "Запросить документы" }
    };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(withReadableResidence) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [{ author: "ai", body: "Уточните прописку", createdAt: "2026-09-02" } as any], facts: { requestedProgram: "without_storage" }, settings: {}, text: "Чуйская область", attachments: [] });
    expect(output.result?.leadCardPatch).toEqual(expect.objectContaining({ residenceRegion: "Чуйская область", residenceCategory: "CHUY" }));
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("removes a repeated greeting when Ailyn has already answered in the conversation", async () => {
    const repeatedGreeting = { ...validResult, reply: "Здравствуйте! Я Айлин, менеджер. Запись предварительная, менеджер её подтвердит." };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(repeatedGreeting) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [{ author: "ai", body: "Предыдущий ответ", createdAt: "2026-09-02" } as any], facts: {}, settings: {}, text: "завтра в 12", attachments: [] });
    expect(output.reply).toBe("Запись предварительная, менеджер её подтвердит.");
    expect(output.result?.reply).toBe(output.reply);
  });

  it("parses a valid model JSON without applying the log truncation limit", async () => {
    const long = { ...validResult, reply: "а".repeat(4000), cardSummary: "б".repeat(1000) };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(long) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "test", attachments: [] });
    expect(output.result?.reply).toHaveLength(4000);
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("converts every explicit foreign-currency amount to som before the one model call", async () => {
    const integrations = { convertToSom: vi.fn().mockImplementation(async ({ amount, currency }: { amount: number; currency: string }) => ({ available: true, value: amount * 87, currency, rate: 87, nominal: 1, source: "NBKR", sourceUrl: "https://example.test", effectiveDate: "2026-09-02" })) } as any;
    const result = await resolveForeignCurrencyFacts("Мне нужно 6к долларов, авто стоит 20к", {}, integrations);
    expect(result.facts).toMatchObject({ requestedAmount: 522_000, requestedAmountSourceCurrency: "USD", vehicleValue: 1_740_000, vehicleValueSourceCurrency: "USD" });
    expect(result.clientText).toContain("6 000 долларов США — ориентировочно 522 000 сом");
    expect(result.clientText).toContain("20 000 долларов США — ориентировочно 1 740 000 сом");
    expect(integrations.convertToSom).toHaveBeenCalledTimes(2);
  });

  it("places the currency explanation after the greeting and removes an exact model duplicate", () => {
    const currency = "По официальному курсу НБКР: 6 000 долларов США — ориентировочно 524 700 сом.";
    const reply = composeReply(`Здравствуйте! Я Айлин, менеджер. ${currency}\n\nПодскажите год автомобиля. ${currency}`, currency);
    expect(reply).toBe("Здравствуйте! Я Айлин, менеджер.\n\nПо официальному курсу НБКР: 6 000 долларов США — ориентировочно 524 700 сом.\n\nПодскажите год автомобиля.");
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
    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ documents: expect.objectContaining({ id_front: "received", id_back: "received" }) }));
    expect(store.addAttachment).toHaveBeenCalledTimes(2);
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
