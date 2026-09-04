import { describe, expect, it, vi } from "vitest";
import { AgentTurnService } from "./agent-turn.service.js";
import { DialogueOrchestratorService, composeReply, resolveForeignCurrencyFacts, resolveNormalizedMoneyFacts } from "./dialogue-orchestrator.service.js";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
process.env.REDIS_URL ??= "redis://localhost:6379";

const validResult = {
  reply: "Подскажите, пожалуйста, модель и год выпуска автомобиля.", hasMoney: false, language: "ru", intent: "new_loan", leadCardPatch: { vehicleMake: "Toyota", vehicleYear: 2020 }, cardSummary: "Toyota 2020, ожидаются остальные данные.",
  dialogueState: { stage: "COLLECTING_VALUE", status: "need_more_data", nextAction: "Запросить стоимость" }, targetEvent: null,
  managerUpdate: { kind: "none", changedFields: [] }, attachments: []
};

describe("single-agent dialogue", () => {
  it("runs money normalization only after the agent explicitly detected money", async () => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "нужно 6к долларов", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue(["requestedAmount"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const agent = {
      run: vi.fn().mockResolvedValue({ result: { ...validResult, hasMoney: true, leadCardPatch: {} }, reply: "Подскажите стоимость автомобиля.", model: "one", promptVersion: "v1" }),
      normalizeMoney: vi.fn().mockResolvedValue([{ field: "requestedAmount", amount: 6_000, currency: "USD", confidence: 0.99 }])
    } as any;
    const integrations = { convertToSom: vi.fn().mockResolvedValue({ available: true, value: 524_700, currency: "USD", rate: 87.45, nominal: 1, source: "NBKR", effectiveDate: "2026-09-04" }) } as any;

    await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any, integrations)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "нужно 6к долларов", attachments: [], timestamp: new Date() });

    expect(agent.run).toHaveBeenCalledTimes(1);
    expect(agent.normalizeMoney).toHaveBeenCalledTimes(1);
    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ requestedAmount: 524_700, requestedAmountSourceCurrency: "USD" }));
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

    expect(result.facts).toMatchObject({ requestedAmount: 524_700, requestedAmountSourceCurrency: "USD" });
    expect(result.clientText).toBe("По текущему курсу НБКР:\n• Необходимая сумма займа: 6 000 долларов США — ориентировочно 524 700 сом.");
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

    expect(output.result?.leadCardPatch).toEqual(expect.objectContaining({ requestedProgram: "parking", requestedAmount: 874_488 }));
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
    expect(output.result?.preliminaryLimit).toBeUndefined();
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
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "Toyota 2020", attachments: [] });
    expect(output.reply).toBe(repaired.reply);
    expect(output.model).toBe("cheap-normalizer");
    expect(output.promptVersion).toContain("normalizer");
    expect(client.createChatCompletion).toHaveBeenCalledTimes(4);
    expect(client.createChatCompletion.mock.calls[3][0].model).toBe("openai/gpt-4o-mini");
  });

  it("does not treat a document request as a reached target event", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, leadCardPatch: { residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG" }, dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "continue", nextAction: "request_documents" }, targetEvent: "documents" }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [
        { author: "client", body: "нужен займ без изъятия камри 2022 стоит 20 тыс долларов надо 10", createdAt: "2026-09-03T14:36:45Z" } as any,
        { author: "ai", body: "По официальному курсу НБКР: 10 000 долларов США — ориентировочно 874 488 сом; 20 000 долларов США — ориентировочно 1 748 976 сом. Подскажите, пожалуйста, Ваша прописка: Бишкек; Чуйская область; другой регион Кыргызстана.", createdAt: "2026-09-03T14:36:54Z" } as any
      ],
      facts: { vehicleMake: "Toyota", vehicleYear: 2022, vehicleValue: 1_748_976, requestedAmount: 874_488, requestedProgram: "without_storage" },
      settings: {},
      text: "в такмоке",
      attachments: []
    });
    expect(output.result?.targetEvent).toBeNull();
    expect(output.result?.leadCardPatch).toEqual(expect.objectContaining({ residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", requestedProgram: "parking" }));
    expect(output.result?.preliminaryLimit).toBe(874_488);
    expect(output.result?.dialogueState).toEqual(expect.objectContaining({ stage: "COLLECTING_DOCUMENTS", nextAction: "collect_documents" }));
    expect(output.reply).toContain("200 000 сом");
    expect(output.reply).toContain("874 488 сом");
    expect(output.reply).toContain("подойдёт программа со стоянкой");
    expect(output.reply).toContain("свидетельства о регистрации ТС");
    expect(output.reply).not.toContain("Подойдёт такой вариант");
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("separates an optional photo explanation from the next question", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Спасибо. Если есть возможность, пожалуйста, отправьте также 2–3 фотографии автомобиля. Это поможет быстрее провести предварительную оценку и ускорит рассмотрение заявки. Состоите ли Вы в браке?" }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: {}, settings: {}, text: "", attachments: [] });
    expect(output.reply).toContain("заявки.\n\nСостоите ли Вы в браке?");
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

  it("corrects a model stage that skips an unresolved required amount", async () => {
    const proposed = { ...validResult, dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "continue", nextAction: "request_documents" } };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(proposed) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: { vehicleMake: "Toyota", vehicleYear: 2020, vehicleValue: 1_000_000 }, settings: {}, text: "", attachments: [] });
    expect(output.result?.dialogueState).toEqual(expect.objectContaining({ stage: "COLLECTING_AMOUNT", status: "need_more_data" }));
  });

  it("does not show document collection before the residence question is answered", async () => {
    const facts = { vehicleMake: "Toyota", vehicleYear: 2022, vehicleValue: 1_749_000, requestedAmount: 600_000, requestedProgram: "without_storage" } as any;
    const skipped = { ...validResult, reply: "Пожалуйста, отправьте ID и СТС.", dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "continue", nextAction: "request_documents" } };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(skipped) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts, settings: {}, text: "без изъятия", attachments: [] });
    expect(output.result?.dialogueState).toEqual(expect.objectContaining({ stage: "COLLECTING_RESIDENCE" }));
    expect(output.reply).toContain("Ваша прописка");
    expect(output.reply).not.toContain("ID и СТС");
  });

  it("does not schedule a visit before asking about family status", async () => {
    const facts = { vehicleMake: "Toyota", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "parking", residenceRegion: "Бишкек", documents: { id_front: "received", id_back: "received", vehicle_registration_front: "received", vehicle_registration_back: "received" } } as any;
    const skipped = { ...validResult, reply: "Когда Вам удобно приехать в офис?", dialogueState: { stage: "SCHEDULING_VISIT", status: "continue", nextAction: "schedule_visit" } };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(skipped) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts, settings: {}, text: "", attachments: [] });
    expect(output.result?.dialogueState).toEqual(expect.objectContaining({ stage: "COLLECTING_FAMILY_STATUS" }));
    expect(output.reply).toBe("Подскажите, пожалуйста, состоите ли Вы в браке?");
  });

  it("uses the model's car-photo refusal fact and moves to family status", async () => {
    const facts = { vehicleMake: "Toyota", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "parking", residenceRegion: "Бишкек", documents: { id_front: "received", id_back: "received", vehicle_registration_front: "received", vehicle_registration_back: "received" } } as any;
    const skipped = { ...validResult, reply: "Ничего страшного, продолжаем оформление.", leadCardPatch: { declinedCarPhoto: true }, dialogueState: { stage: "SCHEDULING_VISIT", status: "continue", nextAction: "schedule_visit" } };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(skipped) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [{ author: "ai", body: "Если есть возможность, отправьте 2–3 фотографии автомобиля.", createdAt: "now" } as any], facts, settings: {}, text: "нет фоток", attachments: [] });
    expect(output.result?.leadCardPatch.declinedCarPhoto).toBe(true);
    expect(output.reply).toBe("Подскажите, пожалуйста, состоите ли Вы в браке?");
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

  it("retries a schema-valid reply that asks for an already received ID side", async () => {
    const facts = { vehicleMake: "Toyota", vehicleYear: 2020, vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "parking", residenceRegion: "Бишкек", documents: { id_front: "received", id_back: "received", vehicle_registration_front: "received", vehicle_registration_back: "received" } } as any;
    const invalid = { ...validResult, reply: "Пришлите, пожалуйста, лицевую сторону ID.", dialogueState: { stage: "SCHEDULING_VISIT", status: "need_more_data", nextAction: "schedule_visit" } };
    const fixed = { ...validResult, reply: "Подскажите, пожалуйста, удобные дату и время визита.", dialogueState: { stage: "SCHEDULING_VISIT", status: "need_more_data", nextAction: "schedule_visit" } };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(invalid) } }] }).mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(fixed) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts, settings: {}, text: "", attachments: [] });
    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(output.reply).toBe("Подскажите, пожалуйста, состоите ли Вы в браке?");
  });

  it("rewrites a conflicting preliminary limit with the deterministic value without fallback", async () => {
    const facts = { vehicleMake: "Toyota", vehicleYear: 2020, vehicleValue: 1_900_000, requestedAmount: 300_000, requestedProgram: "parking", residenceRegion: "Бишкек" } as any;
    const conflict = { ...validResult, preliminaryLimit: 2_000_000, dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "collect_documents" } };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(conflict) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts, settings: {}, text: "", attachments: [] });
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
    expect(output.result?.preliminaryLimit).toBe(950_000);
    expect(output.reply).toContain("950 000 сом");
  });

  it("offers parking before documents when the requested amount exceeds the selected program limit", async () => {
    const facts = { vehicleMake: "Toyota", vehicleYear: 2022, vehicleValue: 1_749_000, requestedAmount: 874_500, requestedProgram: "without_storage", residenceRegion: "Чуйская область", residenceCategory: "CHUY" } as any;
    const modelResult = { ...validResult, preliminaryLimit: 600_000, dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "continue", nextAction: "request_documents" }, reply: "Предварительно доступно до 600 000 сом. Отправьте документы." };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(modelResult) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts, settings: {}, text: "да", attachments: [] });
    expect(output.result?.dialogueState).toEqual(expect.objectContaining({ stage: "COLLECTING_DOCUMENTS", nextAction: "collect_documents" }));
    expect(output.result?.leadCardPatch.requestedProgram).toBe("parking");
    expect(output.reply).toContain("600 000 сом");
    expect(output.reply).toContain("программа со стоянкой");
    expect(output.reply).toContain("свидетельства о регистрации ТС");
  });

  it("mentions the parking alternative when it also cannot cover the full request", async () => {
    const facts = { vehicleMake: "Toyota", vehicleYear: 2022, vehicleValue: 1_748_976, requestedAmount: 1_311_732, requestedProgram: "without_storage", residenceRegion: "Чуйская область", residenceCategory: "BISHKEK_CHUY" } as any;
    const modelResult = { ...validResult, preliminaryLimit: 600_000, dialogueState: { stage: "ELIGIBILITY_CHECK", status: "need_more_data", nextAction: "confirm_reduced_amount" }, reply: "Сможете рассмотреть сумму в пределах лимита?" };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(modelResult) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts, settings: {}, text: "надо 15 тыс долларов", attachments: [] });
    expect(output.reply).toContain("программе со стоянкой");
    expect(output.reply).toContain("874 488 сом");
    expect(output.reply).toContain("Запрошенная сумма превышает и этот лимит");
    expect(output.reply).not.toBe("Подскажите, пожалуйста, сможете рассмотреть сумму в пределах предварительного лимита?");
  });

  it("accepts an explicit switch to parking and uses its calculated limit", async () => {
    const facts = { vehicleMake: "Omoda", vehicleYear: 2009, vehicleValue: 1_900_000, requestedAmount: 650_000, requestedProgram: "without_storage", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", guarantorAvailable: true } as any;
    const modelResult = { ...validResult, preliminaryLimit: 2_000_000, dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "continue", nextAction: "request_documents" }, reply: "По программе со стоянкой доступно до 2 000 000 сом. Отправьте документы." };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(modelResult) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts, settings: {}, text: "Тогда со стоянкой", attachments: [] });
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
    expect(output.result?.leadCardPatch.requestedProgram).toBe("parking");
    expect(output.result?.preliminaryLimit).toBe(950_000);
    expect(output.reply).toContain("950 000 сом");
  });

  it("does not infer a programme switch from reply wording", async () => {
    const invalid = { ...validResult, reply: "По программе без изъятия продолжим оформление." };
    const fixed = { ...validResult, reply: "По программе со стоянкой продолжим оформление." };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(invalid) } }] }).mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(fixed) } }] }) } as any;
    const output = await new AgentTurnService(client).run({ messages: [], facts: { requestedProgram: "without_storage" }, settings: {}, text: "тогда давайте на стоянку", attachments: [] });
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
    expect(output.result?.leadCardPatch.requestedProgram).toBe("without_storage");
    expect(output.reply).toBe(invalid.reply);
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
    expect(output.result?.targetEvent).toBe("documents");
    expect(output.reply).toContain("состоите ли Вы в браке");
    expect(output.reply).not.toMatch(/СТС|свидетельств/u);
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
