import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AgentTurnService, nextRequiredStageQuestion, OLDER_VEHICLE_PROGRAM_NOTICE } from "./agent-turn.service.js";
import { agentStageInstructions } from "./agent-stage-instructions.js";
import { DialogueOrchestratorService, composeReply, removeEarlierDuplicateSentences, replaceMaximumLimitPlaceholders, resolveForeignCurrencyFacts, resolveNormalizedMoneyFacts, workflowFollowUpAfterKnowledge } from "./dialogue-orchestrator.service.js";
import { generatedDocumentationChunks } from "./documentation-chunks.generated.js";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
process.env.REDIS_URL ??= "redis://localhost:6379";

const validResult = {
  reply: "Подскажите, пожалуйста, модель и год выпуска автомобиля.", hasMoney: false, needsKnowledgeLookup: false, language: "ru", intent: "new_loan", loanQuestionKind: "none", leadCardPatch: { vehicleMake: "Toyota", vehicleYear: 2020 }, cardSummary: "Toyota 2020, ожидаются остальные данные.",
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
  it("answers a short why-question from the active vehicle stage instead of unrelated knowledge", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Нотариальное согласие требуется только если собственник автомобиля состоит в браке.",
      leadCardPatch: {},
      knowledgeRequest: { required: true, reason: "missing_approved_answer" }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, модель и год выпуска автомобиля и ориентировочную стоимость автомобиля.", createdAt: "now" } as any],
      facts: {}, settings: {}, text: "а зачем", attachments: []
    });

    expect(output.result?.needsKnowledgeLookup).toBe(false);
    expect(output.reply).toContain("предварительно оценить автомобиль");
    expect(output.reply).not.toMatch(/нотариальн|супруг/iu);
    expect(output.reply).toContain("модель и год выпуска автомобиля");
  });

  it.each(["а зачем эта информация", "для чего это нужно", "что это даст?"])("uses the model's current-stage clarification signal for %s", async (text) => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Распознано.",
      currentStageClarification: true,
      leadCardPatch: { knowledgeRequest: { required: true, reason: "missing_approved_answer" } }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: vehicleStageQuestion, createdAt: "now" } as any],
      facts: {}, settings: {}, text, attachments: []
    });

    expect(output.result?.leadCardPatch.knowledgeRequest).toBeUndefined();
    expect(output.reply).toContain("предварительно оценить автомобиль");
  });

  it("does not let the clarification signal suppress a separate knowledge question", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Распознано.",
      currentStageClarification: false,
      leadCardPatch: { knowledgeRequest: { required: true, reason: "missing_approved_answer" } }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: vehicleStageQuestion, createdAt: "now" } as any],
      facts: {}, settings: {}, text: "а wi-fi у вас есть?", attachments: []
    });

    expect(output.result?.leadCardPatch.knowledgeRequest).toEqual({ required: true, reason: "missing_approved_answer" });
  });

  it("treats a first-turn parking selection as data, not an unasked programme FAQ", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "По программе со стоянкой автомобиль размещается на охраняемой парковке компании. Ставка составляет 2,4% в месяц, дополнительно оплачивается парковка 130 сом в сутки.",
      programStatement: true,
      leadCardPatch: {
        requestedProgram: "parking",
        knowledgeRequest: { required: true, reason: "missing_approved_answer" }
      }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [], facts: {}, settings: {}, text: "нажуен займ со стоянкой", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ requestedProgram: "parking" });
    expect(output.result?.leadCardPatch.knowledgeRequest).toBeUndefined();
    expect(output.reply).toBe(withFirstContactGreeting(vehicleStageQuestion));
    expect(output.reply).not.toMatch(/ставка|парковк|охраняем/iu);
  });

  it.each([
    ["vehicle-year correction", "2031 год ещё не наступил. Уточните, пожалуйста, верный год выпуска автомобиля.", "Год выпуска нужен"],
    ["requested amount", "Какая сумма займа Вам необходима?", "Сумма нужна"],
    ["money role", "Подскажите, это ориентировочная стоимость автомобиля или желаемая сумма займа?", "относится названная сумма"],
    ["programme", "Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?", "Выбор программы определяет"],
    ["maximum programme", "Какую программу выбираете для максимальной суммы — без изъятия автомобиля или со стоянкой?", "максимальную сумму именно по выбранному варианту"],
    ["amount limit", "Могу продолжить либо на сумме до 500 000 сом без изъятия, либо перейти на стоянку. Какой вариант выбираете?", "запрошенная сумма превышает доступный лимит"],
    ["residence", "Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.", "Прописка нужна"],
    ["residence clarification", "Подскажите, пожалуйста, это в Чуйской области?", "Уточняем регион прописки"],
    ["guarantor", "И Вам потребуется поручитель:\n- возраст от 25 лет\nУ Вас есть такой поручитель?", "Поручитель нужен только для займа без изъятия"],
    ["parking alternative", "Поручитель обязателен для программы без изъятия в Вашем регионе. Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?", "готовы ли Вы рассмотреть вариант со стоянкой"],
    ["family status", "Подскажите, пожалуйста, Ваше семейное положение — Вы в браке, в разводе или не в браке.", "Семейное положение нужно"],
    ["divorce purchase timing", "Подскажите, пожалуйста, автомобиль был приобретён во время брака или после развода?", "свидетельство о расторжении брака"],
    ["office consent", "Для оформления потребуется нотариальное согласие супруга или супруги. Вам удобно оформить согласие при визите в офис?", "подготовить нотариальное согласие"],
    ["spouse-away consent", "Супруг или супруга может оформить нотариальное согласие у любого нотариуса по месту нахождения и отправить Вам оригинал. Напишите, пожалуйста, когда согласие будет у Вас — после этого продолжим оформление.", "согласовать оформление"],
    ["documents", "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.", "Документы нужны"],
    ["car photos", "Пожалуйста, отправьте 2–3 фотографии автомобиля.", "Фотографии автомобиля помогут"],
    ["visit", "Офис работает с понедельника по пятницу с 11:00 до 19:00. На какой день и время Вам удобно подъехать?", "Дата и время нужны"],
    ["money currency clarification", "Вы имели в виду 500 000 сом, верно?", "не ошибиться в сумме и валюте займа"]
  ])("explains why the active %s stage is needed", async (_stage, prompt, explanation) => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Нотариальное согласие требуется только если собственник автомобиля состоит в браке.",
      leadCardPatch: {},
      knowledgeRequest: { required: true, reason: "missing_approved_answer" }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: prompt, createdAt: "now" } as any],
      facts: _stage === "parking alternative"
        ? { requestedProgram: "without_storage", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", guarantorAvailable: false }
        : {},
      settings: {}, text: "зачем", attachments: []
    });

    expect(output.result?.needsKnowledgeLookup).toBe(false);
    expect(output.reply).toContain(explanation);
  });

  it("asks to correct a future vehicle year instead of advancing to the amount stage", () => {
    expect(nextRequiredStageQuestion({
      vehicleModel: "Li 9",
      reportedInvalidVehicleYear: 2031,
      vehicleValue: 6_000_000
    })).toBe("2031 год ещё не наступил. Уточните, пожалуйста, верный год выпуска автомобиля.");
  });

  it("does not let a future vehicle year advance to the amount stage", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: amountStageQuestion,
      leadCardPatch: { vehicleModel: "Li 9", vehicleYear: 2031, vehicleValue: 6_000_000 }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: vehicleStageQuestion, createdAt: "now" } as any],
      facts: {}, settings: {}, text: "ли 9 2031 года стоит 6 млн", attachments: []
    });

    expect(output.reply).toBe("2031 год ещё не наступил. Уточните, пожалуйста, верный год выпуска автомобиля.");
    expect(output.result.leadCardPatch).toMatchObject({ vehicleModel: "Li 9", reportedInvalidVehicleYear: 2031 });
    expect(output.result.leadCardPatch.vehicleYear).toBeUndefined();
  });

  it("answers a typo-tolerant non-owner disclosure with the approved UNA-registration FAQ", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Распознано.",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [], facts: {}, settings: {}, text: "А у меня мошина но оформлена не наменя", attachments: []
    });

    expect(output.result.leadCardPatch.borrowerIsOwner).toBeUndefined();
    expect(output.result.needsKnowledgeLookup).toBe(true);
    expect(output.reply).toContain("автомобиль должен быть зарегистрирован в УНА");
    expect(output.reply).not.toMatch(/доверенност|нотариус|согласие супруга/iu);
  });

  it("lets the knowledge model adapt an approved answer to a factual disclosure", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      reply: "Для оформления займа автомобиль должен быть зарегистрирован в УНА на человека, который обращается за займом.",
      answerFound: true
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).answerWithKnowledge({
      messages: [], facts: {}, settings: {}, text: "А у меня мошина но оформлена не наменя", workflowFollowUp: ""
    });

    expect(output?.reply).toBe("Для оформления займа автомобиль должен быть зарегистрирован в УНА на человека, который обращается за займом.");
    expect(output?.reply).not.toMatch(/^да[.!]?/iu);
  });

  it("keeps other knowledge answers when a turn also asks for the maximum", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      reply: "Без изъятия: от 50 000 сом до MAX_LIMIT_WITHOUT сом\nСо стоянкой: от 50 000 сом до MAX_LIMIT_PARK сом\n\nПо программе без изъятия ставка определяется индивидуально после осмотра автомобиля. По программе со стоянкой ставка составляет 2,4% в месяц, парковка — 130 сом в сутки.\n\nВ офисе есть зона ожидания.\n\nАвтомобиль после аварии можно рассмотреть после осмотра.",
      answerFound: true
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).answerWithKnowledge({
      messages: [],
      facts: { vehicleValue: 3_000_000, residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" } as any,
      settings: {},
      text: "сколько денег дадите, какой процент и есть ли зона ожидания, также ничего страшно что у меня авто после аварии?",
      workflowFollowUp: ""
    });

    expect(output?.reply).toContain("MAX_LIMIT_WITHOUT");
    expect(output?.reply).toContain("MAX_LIMIT_PARK");
    expect(output?.reply).toContain("ставка определяется индивидуально");
    expect(output?.reply).toContain("зона ожидания");
    expect(output?.reply).toContain("после аварии");
  });

  it("adds the parking rate when a general rate question was answered only for without-storage", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      reply: "По программе без изъятия ставка определяется индивидуально после осмотра автомобиля и проверки документов.",
      answerFound: true
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).answerWithKnowledge({
      messages: [], facts: {}, settings: {}, text: "какой у вас процент", workflowFollowUp: ""
    });

    expect(output?.reply).toContain("ставка определяется индивидуально");
    expect(output?.reply).toContain("ставка составляет 2,4% в месяц");
    expect(output?.reply).toContain("130 сом в сутки");
  });

  it("never exposes internal publicMax instructions from a rate knowledge response", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      reply: "По программе со стоянкой ставка составляет 2,4% в месяц. По сумме займа: предварительная сумма сообщается до переданного сервером `publicMax`; общие потолки не называются.",
      answerFound: true
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).answerWithKnowledge({
      messages: [], facts: {}, settings: {}, text: "А лимиты и проценты подскажи", workflowFollowUp: ""
    });

    expect(output?.reply).toContain("ставка составляет 2,4% в месяц");
    expect(output?.reply).not.toMatch(/publicmax|общие\s+потолки|предварительная сумма/iu);
  });

  it("marks a GPS malfunction as existing-loan servicing for the knowledge model", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      reply: "Если у Вас уже оформлен займ, пожалуйста, позвоните по телефону +996 502 108 108 или напишите в WhatsApp +996 776 108 108.",
      answerFound: true
    }) } }] }) } as any;
    const service = new AgentTurnService(client);

    await service.answerWithKnowledge({ messages: [], facts: {}, settings: {}, text: "У меня датчик не работает", workflowFollowUp: "" });

    const context = JSON.parse(client.createChatCompletion.mock.calls[0][0].messages[1].content);
    expect(context.existingContractServiceRequest).toBe(true);
    expect(context.knowledge[0]).toMatchObject({ section: "3.18" });
    expect(context.knowledge.some((chunk: { key?: string }) => chunk.key === "faq_gps_requirement")).toBe(false);
  });

  it("drops the generic clarification when a short correction is recognised", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Нужно уточнение.",
      leadCardPatch: { vehicleYear: 2030 }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "2031 год ещё не наступил. Уточните, пожалуйста, верный год выпуска автомобиля.", createdAt: "now" } as any],
      facts: { vehicleModel: "Li 9", vehicleValue: 6_000_000, reportedInvalidVehicleYear: 2031 } as any,
      settings: {}, text: "2030", attachments: []
    });

    expect(output.reply).toBe("2030 год ещё не наступил. Уточните, пожалуйста, верный год выпуска автомобиля.");
    expect(output.reply).not.toContain("Не смогла понять");
  });

  it("asks only for visit time when the visit date is already saved", () => {
    expect(nextRequiredStageQuestion({
      vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
      requestedAmount: 600_000, requestedProgram: "without_storage",
      residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
      documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single",
      visitDate: "2026-10-06"
    })).toBe("Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. В какое время Вам удобно подъехать?");
  });

  it("asks only for a visit date when the visit time is already saved", () => {
    expect(nextRequiredStageQuestion({
      vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
      requestedAmount: 600_000, requestedProgram: "without_storage",
      residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
      documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single",
      visitTime: "14:00"
    })).toBe("Офис работает с понедельника по пятницу с 11:00 до 19:00. На какой день Вам удобно подъехать?");
  });

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

  it("adds the canonical amount prompt only once when the model repeats it", async () => {
    const amountQuestion = "Какая сумма займа Вам необходима?";
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: `${amountQuestion} ${amountQuestion}`,
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, модель и год выпуска автомобиля и ориентировочную стоимость автомобиля.", createdAt: "now" } as any],
      facts: { vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 2_360_000 } as any,
      settings: {}, text: "А сколько денег дадите?", attachments: []
    });

    expect(output.reply.match(/Какая сумма займа Вам необходима\?/gu)).toHaveLength(1);
  });

  it("does not let the input model repeat vehicle facts that the client just supplied", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Танк 2012 года, стоимость около 27 тыс. долларов.",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите модель автомобиля и стоимость.", createdAt: "now" } as any],
      facts: { vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 2_360_000 } as any,
      settings: {}, text: "танк 2012 года стоит 27 тыс долларов", attachments: []
    });

    expect(output.reply).not.toMatch(/танк\s+2012/iu);
    expect(output.reply).not.toMatch(/27\s+тыс/iu);
  });

  it("removes a duplicate foreign-currency conversion from the input-model plan", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "6 тысяч евро — это около 600 тысяч сом.",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Какая сумма займа Вам необходима?", createdAt: "now" } as any],
      facts: { vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 2_360_000 } as any,
      settings: {}, text: "6 тыщ евро", currencyConversions: [{}], attachments: []
    });

    expect(output.reply).not.toMatch(/около\s+600\s+тысяч\s+сом/iu);
  });

  it("does not invent a loan explanation for a bare negative to a guarantor question", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Нет, это займ под залог автомобиля.",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "У Вас есть такой поручитель?", createdAt: "now" } as any],
      facts: { vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 2_360_000, requestedAmount: 100_000, requestedProgram: "without_storage", residenceCategory: "OTHER_KG", residenceRegion: "Другой регион Кыргызстана" } as any,
      settings: {}, text: "неа", attachments: []
    });

    expect(output.reply).not.toContain("это займ под залог автомобиля");
  });

  it("fails closed when the output renderer adds a fact outside the server plan", async () => {
    const plan = "Поручитель обязателен для программы без изъятия в Вашем регионе. Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?";
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ reply: `Нет, это займ под залог автомобиля. ${plan}` }) } }], model: "output-model" }) } as any;

    const output = await new AgentTurnService(client).renderClientReply({ responsePlan: plan, clientMessage: "неа", facts: {} as any });

    expect(output).toEqual({ reply: plan, model: "server-response-plan", rendered: false });
  });

  it("fails closed when the output renderer drops the answer and leaves only a stage question", async () => {
    const plan = "Без изъятия: от 50 000 сом до 600 000 сом\nСо стоянкой: от 50 000 сом до 1 500 000 сом\n\nПожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.";
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      reply: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон."
    }) } }], model: "output-model" }) } as any;

    const output = await new AgentTurnService(client).renderClientReply({ responsePlan: plan, clientMessage: "Сколько денег дадите", facts: {} as any });

    expect(output).toEqual({ reply: plan, model: "server-response-plan", rendered: false });
  });

  it.each(["а кофе есть", "с собоакой можноэ"])("routes an unpunctuated factual question to knowledge instead of treating it as a documents reply: %s", async (text) => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Corolla", vehicleYear: 2010, vehicleValue: 2_180_000,
        requestedAmount: 200_000, requestedProgram: "parking",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      settings: {}, text, attachments: []
    });

    expect(output.result?.needsKnowledgeLookup).toBe(true);
    expect(output.result?.leadCardPatch.knowledgeRequest).toMatchObject({ required: true });
  });

  it("always sends the completed server plan through the output renderer", async () => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "COLLECTING_VEHICLE", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockImplementation(async (_conversation: unknown, message: any) => ({ id: message.metadata?.externalMessageId ?? "ai", author: message.author, body: message.body, createdAt: "now" })),
      updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn()
    } as any;
    const serverPlan = "Поняла. Подскажите, пожалуйста, модель автомобиля.";
    const agent = {
      run: vi.fn().mockResolvedValue({ result: { ...validResult, reply: serverPlan, leadCardPatch: {} }, reply: serverPlan, model: "interpreter", promptVersion: "v1" }),
      renderClientReply: vi.fn().mockResolvedValue({ reply: "Поняла. Подскажите, пожалуйста, модель автомобиля.", model: "output", rendered: true })
    } as any;

    const output = await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "танк", attachments: [], timestamp: new Date() });

    expect(agent.renderClientReply).toHaveBeenCalledWith(expect.objectContaining({ responsePlan: serverPlan, clientMessage: "танк" }));
    expect(output.reply).toBe("Поняла. Подскажите, пожалуйста, модель автомобиля.");
  });

  it("sends a maximum-limit calculation directly and retains the later document prompt", async () => {
    const application = {
      id: "app",
      facts: {
        vehicleModel: "Corolla", vehicleYear: 2010, vehicleValue: 2_180_000,
        requestedAmount: 200_000, requestedProgram: "parking",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      },
      contactId: "contact", stage: "COLLECTING_DOCUMENTS", status: "need_more_data"
    } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockImplementation(async (_conversation: unknown, message: any) => ({ id: message.metadata?.externalMessageId ?? "ai", author: message.author, body: message.body, createdAt: "now" })),
      updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn()
    } as any;
    const plan = "Без изъятия: от 50 000 сом до 200 000 сом\nСо стоянкой: от 50 000 сом до 1 090 000 сом\n\nПожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.";
    const agent = {
      run: vi.fn().mockResolvedValue({
        result: { ...validResult, reply: plan, loanQuestionKind: "maximum_limit", leadCardPatch: {} },
        reply: plan, model: "interpreter", promptVersion: "v1"
      }),
      renderClientReply: vi.fn().mockResolvedValue({ reply: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.", model: "output", rendered: true })
    } as any;

    const output = await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "maximum", channel: "web-test", externalContactId: "contact", text: "Сколько денег дадите", attachments: [], timestamp: new Date() });

    expect(agent.renderClientReply).not.toHaveBeenCalled();
    expect(output.reply).toBe(plan);
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

  it("does not append the future guarantor question while the amount stage is still open", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Распознано.",
      leadCardPatch: { residenceText: "Кашка-Суу" }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000,
        requestedProgram: "without_storage"
      } as any,
      settings: {}, text: "кашка су", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({
      residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
    });
    expect(output.reply).toContain("По программе без изъятия Вам доступно до 200 000 сом");
    expect(output.reply).toContain("Какая сумма займа Вам необходима?");
    expect(output.reply).not.toMatch(/поручител/iu);
  });

  it("uses a dedicated model to classify money clarification agreement, currency, and rejection", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ decision: "accept", currency: "USD" }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ decision: "reject", currency: null }) } }] }) } as any;
    const service = new AgentTurnService(client);
    const messages = [{ author: "ai", body: "10 тысяч сом, верно?", createdAt: "now" }] as any;

    await expect(service.classifyPendingMoneyClarification({ text: "долларов", messages })).resolves.toEqual({ decision: "accept", currency: "USD" });
    await expect(service.classifyPendingMoneyClarification({ text: "нет", messages })).resolves.toEqual({ decision: "reject" });
    expect(client.createChatCompletion.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps a clear money-confirmation rejection out of knowledge routing when its classifier is undecided", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ decision: "undecided", currency: null }) } }] }) } as any;
    const result = await new AgentTurnService(client).classifyPendingMoneyClarification({
      text: "нет",
      messages: [{ author: "ai", body: "10 000 сом, верно?", createdAt: "now" } as any]
    });

    expect(result).toEqual({ decision: "reject" });
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

  it("forces a bare no after an amount confirmation into the rejection branch before the main model", async () => {
    const application = { id: "app", facts: { vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 2_360_000 }, contactId: "contact", stage: "COLLECTING_AMOUNT", status: "need_more_data" } as any;
    const conversation = { id: "conversation", application, channel: "web-test", messages: [{ author: "ai", body: "6 000 сом, верно?", createdAt: "before" }] } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "message", author: "client", body: "нет", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const agent = {
      classifyPendingMoneyClarification: vi.fn().mockResolvedValue({ decision: "undecided" }),
      run: vi.fn().mockResolvedValue({ result: { ...validResult, reply: "Тогда уточните, какую сумму вы имели в виду?", leadCardPatch: {} }, reply: "Тогда уточните, какую сумму вы имели в виду?", model: "one", promptVersion: "v1" })
    } as any;

    await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "reject", channel: "web-test", externalContactId: "contact", text: "нет", attachments: [], timestamp: new Date() });

    expect(agent.run).toHaveBeenCalledWith(expect.objectContaining({ moneyClarificationDecision: "reject" }));
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

  it("refreshes the private summary after every turn that updates lead facts", async () => {
    const facts = {} as any;
    const application = { id: "app", facts, contactId: "contact", stage: "COLLECTING_VEHICLE", status: "need_more_data" } as any;
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
      saveDialogueSummary: vi.fn().mockImplementation(async (_id: string, summary: string) => { application.dialogueSummary = summary; })
    } as any;
    const agent = {
      run: vi.fn()
        .mockResolvedValueOnce({
          result: { ...validResult, reply: "Уточнила автомобиль.", leadCardPatch: { vehicleModel: "Corolla", vehicleYear: 2022, vehicleValue: 5_000_000 } },
          reply: "Уточнила автомобиль.", model: "workflow", promptVersion: "v1"
        })
        .mockResolvedValueOnce({
          result: { ...validResult, reply: "Уточнила сумму.", leadCardPatch: { requestedAmount: 200_000 } },
          reply: "Уточнила сумму.", model: "workflow", promptVersion: "v1"
        }),
      summarizeDialogue: vi.fn()
        .mockResolvedValueOnce("Авто: Corolla 2022, стоимость 5 000 000 сом.")
        .mockResolvedValueOnce("Авто: Corolla 2022, стоимость 5 000 000 сом. Запрошенная сумма: 200 000 сом.")
    } as any;
    const service = new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any);
    const vehicleInbound = { externalMessageId: "vehicle", channel: "web-test", externalContactId: "contact", externalConversationId: "conversation", text: "Corolla 2022 за 5 млн", attachments: [], timestamp: new Date("2026-09-08T12:00:00.000Z") } as any;
    const amountInbound = { ...vehicleInbound, externalMessageId: "amount", text: "Нужно 200 тысяч" };

    await service.receive(vehicleInbound);
    const second = await service.receive(amountInbound);
    expect(agent.summarizeDialogue).toHaveBeenCalledTimes(2);
    expect(agent.summarizeDialogue).toHaveBeenNthCalledWith(1, expect.objectContaining({
      facts: expect.objectContaining({ vehicleModel: "Corolla", vehicleYear: 2022, vehicleValue: 5_000_000 }),
      messages: expect.arrayContaining([
        expect.objectContaining({ author: "client", body: "Camry 2022" }),
        expect.objectContaining({ author: "client", body: "Corolla 2022 за 5 млн" }),
        expect.objectContaining({ author: "ai", body: expect.stringContaining("автомобиль") })
      ])
    }));
    expect(agent.summarizeDialogue).toHaveBeenNthCalledWith(2, expect.objectContaining({
      facts: expect.objectContaining({ requestedAmount: 200_000 })
    }));
    expect(store.saveDialogueSummary).toHaveBeenNthCalledWith(1, "app", "Авто: Corolla 2022, стоимость 5 000 000 сом.");
    expect(store.saveDialogueSummary).toHaveBeenNthCalledWith(2, "app", "Авто: Corolla 2022, стоимость 5 000 000 сом. Запрошенная сумма: 200 000 сом.");
    expect(second.application.dialogueSummary).toBe("Авто: Corolla 2022, стоимость 5 000 000 сом. Запрошенная сумма: 200 000 сом.");
  });

  it("keeps the private-summary prompt limited to final staff facts", () => {
    const prompt = readFileSync(new URL("../ai/prompts/dialogue-summary.system.md", import.meta.url), "utf8");

    expect(prompt).toContain("«ориентировочная», «подтверждён");
    expect(prompt).toContain("«single»");
    expect(prompt).toContain("Не перечисляйте лицевую/обратную сторону");
    expect(prompt).toContain("Не указывайте адрес офиса");
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

  it("restores the server-owned maximum programme action on the residence reply", async () => {
    const application = {
      id: "app", facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_180_000 },
      agentState: { nextAction: "select_program_for_maximum", cardSummary: "", intent: "new_loan" },
      contactId: "contact", stage: "COLLECTING_RESIDENCE", status: "need_more_data"
    } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockImplementation(async (_conversation: unknown, message: any) => ({ id: message.metadata.externalMessageId, author: message.author, body: message.body, createdAt: "now" })),
      updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn()
    } as any;
    const agent = { run: vi.fn().mockResolvedValue({ result: validResult, reply: validResult.reply, model: "one", promptVersion: "v1" }) } as any;

    await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "residence", channel: "web-test", externalContactId: "contact", text: "кашка су", attachments: [], timestamp: new Date() });

    expect(agent.run).toHaveBeenCalledWith(expect.objectContaining({ pendingAction: "select_program_for_maximum" }));
  });

  it("never persists an empty assistant body when an upstream response is blank", async () => {
    const application = {
      id: "app", facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000 },
      contactId: "contact", stage: "COLLECTING_AMOUNT", status: "need_more_data"
    } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockImplementation(async (_conversation: unknown, message: any) => ({ id: message.metadata.externalMessageId, author: message.author, body: message.body, createdAt: "now" })),
      updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn()
    } as any;
    const agent = { run: vi.fn().mockResolvedValue({ result: { ...validResult, reply: "", leadCardPatch: {} }, reply: "", model: "one", promptVersion: "v1" }) } as any;

    const output = await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "maximum-question", channel: "web-test", externalContactId: "contact", text: "Сколько по максимуму дадите?", attachments: [], timestamp: new Date() });

    expect(output.reply).toBe("Какая сумма займа Вам необходима?");
    expect(store.addMessage).toHaveBeenLastCalledWith(conversation, expect.objectContaining({ author: "ai", body: "Какая сумма займа Вам необходима?" }));
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

  it("keeps an explicit half-million correction consistent from normalization through persistence", async () => {
    const application = { id: "app", facts: { requestedAmount: 1_000_000, requestedAmountSourceCurrency: "USD" }, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue(["requestedAmount", "requestedAmountSourceCurrency"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const agent = {
      // Simulate the model truncating the phrase. The deterministic fallback
      // must correct this one unambiguous construction before the agent and
      // persistence layers see it.
      normalizeMoney: vi.fn().mockResolvedValue([{ field: "requestedAmount", amount: 1_000_000, currency: "KGS", confidence: 0.99 }]),
      run: vi.fn(async (input: any) => ({ result: { ...validResult, leadCardPatch: input.facts }, reply: "Проверяю лимит.", model: "one", promptVersion: "v1" }))
    } as any;

    await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "half", channel: "web-test", externalContactId: "c", text: "мне надо всё-таки 1 млн с половиной", attachments: [], timestamp: new Date() });

    expect(agent.run).toHaveBeenCalledWith(expect.objectContaining({
      facts: expect.objectContaining({ requestedAmount: 1_500_000, requestedAmountSourceCurrency: undefined })
    }));
    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ requestedAmount: 1_500_000, requestedAmountSourceCurrency: undefined }));
  });

  it("treats a plain desired-amount correction as requested amount, never as a new car price", async () => {
    const application = { id: "app", facts: { vehicleValue: 3_000_000, requestedAmount: 200_000 }, contactId: "contact", stage: "SCHEDULING_VISIT", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "", createdAt: "now" }),
      updateFacts: vi.fn().mockResolvedValue(["requestedAmount"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application),
      getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn()
    } as any;
    const agent = {
      // Simulate the bad semantic normalizer assigning the same correction to
      // both roles. The orchestrator must enforce the unambiguous wording.
      normalizeMoney: vi.fn().mockResolvedValue([
        { field: "vehicleValue", amount: 500_000, currency: "KGS", confidence: 0.99 },
        { field: "requestedAmount", amount: 500_000, currency: "KGS", confidence: 0.99 }
      ]),
      run: vi.fn(async (input: any) => ({ result: { ...validResult, leadCardPatch: input.facts }, reply: "Проверяю лимит.", model: "one", promptVersion: "v1" }))
    } as any;

    await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "amount-correction", channel: "web-test", externalContactId: "c", text: "я хочу все-таки не 200, а 500", attachments: [], timestamp: new Date() });

    expect(agent.run).toHaveBeenCalledWith(expect.objectContaining({
      facts: expect.objectContaining({ vehicleValue: 3_000_000, requestedAmount: 500_000 })
    }));
    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ vehicleValue: 3_000_000, requestedAmount: 500_000 }));
  });

  it("does not overwrite a known car price when the client says they need 600 thousand", async () => {
    const application = { id: "app", facts: { vehicleValue: 3_000_000, requestedAmount: 200_000 }, contactId: "contact", stage: "SCHEDULING_VISIT", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "", createdAt: "now" }),
      updateFacts: vi.fn().mockResolvedValue(["requestedAmount"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application),
      getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn()
    } as any;
    const agent = {
      normalizeMoney: vi.fn().mockResolvedValue([
        { field: "vehicleValue", amount: 600_000, currency: "KGS", confidence: 0.99 },
        { field: "requestedAmount", amount: 600_000, currency: "KGS", confidence: 0.99 }
      ]),
      run: vi.fn(async (input: any) => ({ result: { ...validResult, leadCardPatch: input.facts }, reply: "Проверяю лимит.", model: "one", promptVersion: "v1" }))
    } as any;

    await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "amount-correction", channel: "web-test", externalContactId: "c", text: "мне надо все-таки 600 000", attachments: [], timestamp: new Date() });

    expect(agent.run).toHaveBeenCalledWith(expect.objectContaining({
      facts: expect.objectContaining({ vehicleValue: 3_000_000, requestedAmount: 600_000 })
    }));
    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ vehicleValue: 3_000_000, requestedAmount: 600_000 }));
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

  it("never persists vehicle value when one explicit loan amount is echoed by the dialogue model", async () => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "1 миллион нужен", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue(["requestedAmount"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const agent = {
      normalizeMoney: vi.fn().mockResolvedValue([{ field: "requestedAmount", amount: 1_000_000, currency: "KGS", confidence: 0.99 }]),
      run: vi.fn().mockResolvedValue({ result: { ...validResult, hasMoney: true, leadCardPatch: { vehicleValue: 1_000_000, requestedAmount: 1_000_000 } }, reply: "Распознано.", model: "one", promptVersion: "v1" })
    } as any;

    await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "1 миллион нужен", attachments: [], timestamp: new Date() });

    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ requestedAmount: 1_000_000 }));
    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.not.objectContaining({ vehicleValue: 1_000_000 }));
  });

  it("persists only vehicle value when a price correction is echoed into both money fields", async () => {
    const application = { id: "app", facts: { vehicleValue: 2_000_000, requestedAmount: 600_000 }, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "авто стоит 3 млн", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue(["vehicleValue"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const agent = {
      normalizeMoney: vi.fn().mockResolvedValue([
        { field: "vehicleValue", amount: 3_000_000, currency: "KGS", confidence: 0.99 },
        { field: "requestedAmount", amount: 3_000_000, currency: "KGS", confidence: 0.99 }
      ]),
      run: vi.fn().mockResolvedValue({ result: { ...validResult, hasMoney: true, leadCardPatch: { vehicleValue: 3_000_000, requestedAmount: 3_000_000 } }, reply: "Распознано.", model: "one", promptVersion: "v1" })
    } as any;

    await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "авто стоит 3 млн", attachments: [], timestamp: new Date() });

    expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ vehicleValue: 3_000_000, requestedAmount: 600_000 }));
  });

  it("appends the current server stage after a knowledge answer even when the workflow model omitted it", async () => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = { getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }), addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "а вы датчики на машину ставите", createdAt: "now" }), updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn() } as any;
    const agent = { run: vi.fn().mockResolvedValue({
      result: { ...validResult, leadCardPatch: { ...validResult.leadCardPatch, knowledgeRequest: { required: true, reason: "missing_approved_answer" } } },
      // A knowledge route can contain no canonical workflow question at all.
      // The orchestrator, rather than the model, must restore the next stage.
      reply: "Поняла.",
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

  it("answers a one-word maximum request at the amount stage without repeating that stage", async () => {
    const facts = {
      vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
      residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY"
    } as any;
    const application = { id: "app", facts, contactId: "contact", stage: "COLLECTING_AMOUNT", status: "need_more_data" } as any;
    const conversation = {
      id: "conversation",
      messages: [{ id: "previous", author: "ai", body: amountStageQuestion, createdAt: "now" }],
      application,
      channel: "web-test"
    } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "максимальная", createdAt: "now" }),
      updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn()
    } as any;
    const agent = {
      run: vi.fn().mockResolvedValue({
        result: { ...validResult, leadCardPatch: { ...facts, knowledgeRequest: { required: true, reason: "missing_approved_answer" } } },
        reply: "Поняла.", model: "workflow-model", promptVersion: "v1"
      }),
      answerWithKnowledge: vi.fn().mockResolvedValue({
        reply: "Без изъятия: от 50 000 сом до MAX_LIMIT_WITHOUT сом\nСо стоянкой: от 50 000 сом до MAX_LIMIT_PARK сом\n\nЧтобы подсказать точнее, нужна сумма займа, которая Вам необходима.",
        answerFound: true,
        model: "knowledge-model"
      })
    } as any;

    const output = await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "максимальная", attachments: [], timestamp: new Date() });

    expect(agent.answerWithKnowledge).toHaveBeenCalledWith(expect.objectContaining({
      text: "максимальная",
      workflowFollowUp: amountStageQuestion
    }));
    expect(output.reply).toBe("Без изъятия: от 50 000 сом до 600 000 сом\nСо стоянкой: от 50 000 сом до 1 500 000 сом");
    expect(output.reply).not.toContain(amountStageQuestion);
  });

  it("moves from a maximum request at the amount stage to residence when residence is missing", async () => {
    const facts = { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000 } as any;
    const application = { id: "app", facts, contactId: "contact", stage: "COLLECTING_AMOUNT", status: "need_more_data" } as any;
    const conversation = {
      id: "conversation",
      messages: [{ id: "previous", author: "ai", body: amountStageQuestion, createdAt: "now" }],
      application,
      channel: "web-test"
    } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "самая большая", createdAt: "now" }),
      updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn()
    } as any;
    const agent = {
      run: vi.fn().mockResolvedValue({
        result: { ...validResult, leadCardPatch: { ...facts, knowledgeRequest: { required: true, reason: "missing_approved_answer" } } },
        reply: "Поняла.", model: "workflow-model", promptVersion: "v1"
      }),
      answerWithKnowledge: vi.fn().mockResolvedValue({
        reply: "Без изъятия: от 50 000 сом до MAX_LIMIT_WITHOUT сом\nСо стоянкой: от 50 000 сом до MAX_LIMIT_PARK сом",
        answerFound: true,
        model: "knowledge-model"
      })
    } as any;

    const output = await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "самая большая", attachments: [], timestamp: new Date() });

    expect(output.reply).toBe("Максимальную сумму смогу рассчитать после того, как узнаю: Ваша прописка.\n\nПодскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.");
    expect(output.reply).not.toContain(amountStageQuestion);
    expect(store.saveAgentState).toHaveBeenCalledWith(application, expect.objectContaining({ nextAction: "answer_maximum_after_prerequisites" }));
  });

  it("answers the deferred maximum request immediately after the missing residence is supplied", async () => {
    const facts = { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000 } as any;
    const resolvedFacts = { ...facts, residenceText: "Бишкек", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" } as any;
    const application = {
      id: "app", facts, contactId: "contact", stage: "COLLECTING_RESIDENCE", status: "need_more_data",
      agentState: { nextAction: "answer_maximum_after_prerequisites", cardSummary: "", intent: "new_loan" }
    } as any;
    const conversation = {
      id: "conversation",
      messages: [{ id: "previous", author: "ai", body: "Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.", createdAt: "now" }],
      application,
      channel: "web-test"
    } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockResolvedValue({ id: "inbound", author: "client", body: "Бишкек", createdAt: "now" }),
      updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn()
    } as any;
    const agent = {
      run: vi.fn().mockResolvedValue({
        result: { ...validResult, leadCardPatch: resolvedFacts },
        reply: "Поняла.", model: "workflow-model", promptVersion: "v1"
      }),
      answerWithKnowledge: vi.fn().mockResolvedValue({
        reply: "Без изъятия: от 50 000 сом до MAX_LIMIT_WITHOUT сом\nСо стоянкой: от 50 000 сом до MAX_LIMIT_PARK сом",
        answerFound: true,
        model: "knowledge-model"
      })
    } as any;

    const output = await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "Бишкек", attachments: [], timestamp: new Date() });

    expect(agent.answerWithKnowledge).toHaveBeenCalledWith(expect.objectContaining({ text: "сколько максимум дадите", workflowFollowUp: "" }));
    expect(output.reply).toBe("Без изъятия: от 50 000 сом до 600 000 сом\nСо стоянкой: от 50 000 сом до 1 500 000 сом");
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

  it("rejects a duplicate vehicle value when the client says an amount is required", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ values: [
      { field: "requestedAmount", amount: 1_000_000, currency: "KGS", confidence: 0.99 },
      { field: "vehicleValue", amount: 1_000_000, currency: "KGS", confidence: 0.99 }
    ] }) } }] }) } as any;

    const result = await new AgentTurnService(client).normalizeMoney({
      text: "мне потребуется 1 миллион", facts: {}, messages: []
    });

    expect(result).toEqual([
      { field: "requestedAmount", amount: 1_000_000, currency: "KGS", confidence: 0.99 }
    ]);
  });

  it("does not let the dialogue model reintroduce vehicle value for one required amount", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      hasMoney: true,
      leadCardPatch: { vehicleValue: 1_000_000, requestedAmount: 1_000_000 }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: vehicleStageQuestion, createdAt: "now" } as any],
      // This is the fact already resolved by the dedicated current-turn
      // normalizer before the dialogue model sees the lead card.
      facts: { requestedAmount: 1_000_000 }, settings: {}, text: "требуется 1 миллион", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ requestedAmount: 1_000_000 });
    expect(output.result?.leadCardPatch.vehicleValue).toBeUndefined();
  });

  it("corrects a duplicated model value when the client explicitly supplied price and requested amount", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ values: [
      { field: "vehicleValue", amount: 30_000, currency: "EUR", confidence: 0.99 },
      { field: "requestedAmount", amount: 30_000, currency: "EUR", confidence: 0.99 }
    ] }) } }] }) } as any;

    const result = await new AgentTurnService(client).normalizeMoney({
      text: "королла 2022 года стои 30 тыс евро, надо 10 тыс", facts: {}, messages: []
    });

    expect(result).toEqual([
      { field: "vehicleValue", amount: 30_000, currency: "EUR", confidence: 0.99 },
      { field: "requestedAmount", amount: 10_000, currency: "EUR", confidence: 0.99 }
    ]);
  });

  it("never writes one model-recognized amount to both money fields without two explicit client roles", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ values: [
      { field: "vehicleValue", amount: 30_000, currency: "EUR", confidence: 0.99 },
      { field: "requestedAmount", amount: 30_000, currency: "EUR", confidence: 0.99 }
    ] }) } }] }) } as any;

    const result = await new AgentTurnService(client).normalizeMoney({
      text: "машина стоит 30 тыс евро", facts: {}, messages: []
    });

    expect(result).toEqual([
      { field: "vehicleValue", amount: 30_000, currency: "EUR", confidence: 0.99 }
    ]);
  });

  it("allows equal money fields only when the client explicitly states both equal values", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ values: [
      { field: "vehicleValue", amount: 30_000, currency: "EUR", confidence: 0.99 },
      { field: "requestedAmount", amount: 30_000, currency: "EUR", confidence: 0.99 }
    ] }) } }] }) } as any;

    const result = await new AgentTurnService(client).normalizeMoney({
      text: "машина стоит 30 тыс евро. Мне надо 30 тыс евро", facts: {}, messages: []
    });

    expect(result).toEqual([
      { field: "vehicleValue", amount: 30_000, currency: "EUR", confidence: 0.99 },
      { field: "requestedAmount", amount: 30_000, currency: "EUR", confidence: 0.99 }
    ]);
  });

  it("keeps an explicitly stated vehicle price out of the requested amount when the client also asks for a maximum", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ values: [
      { field: "vehicleValue", amount: 3_000_000, currency: "KGS", confidence: 0.99 },
      { field: "requestedAmount", amount: 3_000_000, currency: "KGS", confidence: 0.99 }
    ] }) } }] }) } as any;
    const result = await new AgentTurnService(client).normalizeMoney({
      text: "камри 2022 года стоит 3 млн, сколько максимум дадите и под какой процент", facts: {}, messages: []
    });

    expect(result).toEqual([{ field: "vehicleValue", amount: 3_000_000, currency: "KGS", confidence: 0.99 }]);
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

  it("does not leak the identity fallback when a misspelled locality is the active residence reply", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Я Айлин — виртуальный помощник по вопросам оформления новых займов. Если у Вас уже оформлен займ, пожалуйста, позвоните по телефону +996 502 108 108 или напишите в WhatsApp +996 776 108 108. Наши специалисты проверят информацию по Вашему договору и помогут решить Ваш вопрос.",
      leadCardPatch: { residenceText: "чтолпон ата" }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "parking" } as any,
      settings: {}, text: "чтолпон ата", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ residenceText: "Чолпон-Ата", residenceCategory: "OTHER_KG" });
    expect(output.reply).not.toContain("виртуальный помощник");
    expect(output.reply).not.toContain("+996 502 108 108");
  });

  it("removes an unsolicited existing-contract redirect while the client selects a new-loan programme", async () => {
    const redirect = "Если у Вас уже оформлен займ, пожалуйста, позвоните по телефону +996 502 108 108 или напишите в WhatsApp +996 776 108 108. Наши специалисты проверят информацию по Вашему договору и помогут решить Ваш вопрос.";
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: `По программе без изъятия автомобиль остаётся у Вас. ${redirect}`,
      leadCardPatch: { requestedProgram: "without_storage" }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_740_000, requestedAmount: 200_000, residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG" } as any,
      settings: {}, text: "нужно все таки без изъятия", attachments: []
    });

    expect(output.reply).not.toContain("Если у Вас уже оформлен займ");
    expect(output.reply).not.toContain("+996 502 108 108");
    expect(output.reply).toContain("И Вам потребуется поручитель:");
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

  it("explains the active new-application residence stage when the client says they already told it", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "К сожалению, у меня нет утверждённой информации по этому вопросу.",
      leadCardPatch: { knowledgeRequest: { required: true, reason: "missing_approved_answer" } }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 2_360_000, requestedAmount: 100_000, requestedProgram: "without_storage",
        residenceText: "неизвестный аил", residenceNeedsClarification: true
      } as any,
      settings: {}, text: "я уже говорил", attachments: []
    });

    expect(output.result?.leadCardPatch.knowledgeRequest).toBeUndefined();
    expect(output.reply).toBe("Понимаю. Мы оформляем новую заявку, и сейчас уточняем Вашу прописку для предварительного расчёта.\n\nПодскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.");
    expect(output.reply).not.toContain("это в Чуйской области");
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
    expect(output.reply).toBe("По программе без изъятия доступно до 200 000 сом.\n\nИ Вам потребуется поручитель:\n- возраст от 25 лет\n- проживает в г. Бишкек или Чуйской области\n- должен лично присутствовать при выдаче займа и иметь с собой ID (паспорт)\nУ Вас есть такой поручитель?");
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

  it.each(["максимальная", "по максимуму"])('routes the maximum-choice reply "%s" to the maximum-range knowledge answer', async (text) => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Хорошо.", leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: amountStageQuestion, createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000, requestedProgram: "without_storage", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" } as any,
      settings: {}, text, attachments: []
    });

    expect(output.result?.leadCardPatch.knowledgeRequest).toMatchObject({ required: true });
    expect(output.result?.leadCardPatch.requestedAmount).toBeUndefined();
    expect(output.result?.leadCardPatch.requestedProgram).toBe("without_storage");
  });

  it("does not repeat the amount-stage question after the maximum-range knowledge answer", () => {
    const maximumRange = "Без изъятия: от 50 000 сом до MAX_LIMIT_WITHOUT сом\nСо стоянкой: от 50 000 сом до MAX_LIMIT_PARK сом";

    expect(workflowFollowUpAfterKnowledge(maximumRange, amountStageQuestion, amountStageQuestion, { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000, residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" })).toBe("");
    expect(workflowFollowUpAfterKnowledge("Да, GPS устанавливаем.", amountStageQuestion, amountStageQuestion)).toBe(amountStageQuestion);
    expect(workflowFollowUpAfterKnowledge(maximumRange, vehicleStageQuestion, vehicleStageQuestion)).toBe(vehicleStageQuestion);
    expect(workflowFollowUpAfterKnowledge(
      maximumRange,
      amountStageQuestion,
      amountStageQuestion,
      { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000 },
    )).toBe("Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.");
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

  it("asks only for time when the client says tomorrow morning", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Чтобы согласовать визит, пожалуйста, уточните конкретную дату и удобное время подъезда. Офис работает с понедельника по пятницу с 11:00 до 19:00, для оформления нужно приехать не позднее 18:00. На какой день и во сколько Вам удобно подъехать?",
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
      settings: { timezone: "Asia/Bishkek" }, text: "завтра утром", attachments: []
    });

    expect(output.result?.leadCardPatch.visitTime).toBeUndefined();
    expect(output.reply).toBe("Завтра подойдёт. Во сколько Вам удобно подъехать? Офис работает с понедельника по пятницу с 11:00 до 19:00, для оформления нужно приехать не позднее 18:00.");
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

    expect(output.reply).toBe("Максимальную сумму смогу рассчитать после того, как узнаю: ориентировочную стоимость автомобиля и Вашу прописку.\n\nПодскажите, пожалуйста, ориентировочную стоимость автомобиля.");
  });

  it("recognizes a misspelled maximum-money question and explains the data needed for an from-to range", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, loanQuestionKind: "none", reply: "Подскажите, пожалуйста, модель и год выпуска автомобиля и ориентировочную стоимость автомобиля.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [], facts: {}, settings: {}, text: "Сколкьо денег можете дать?", attachments: []
    });

    expect(output.result?.loanQuestionKind).toBe("maximum_limit");
    expect(output.reply).toContain("Максимальную сумму смогу рассчитать после того, как узнаю: ориентировочную стоимость автомобиля и Вашу прописку.");
    expect(output.reply).toContain("Подскажите, пожалуйста, модель и год выпуска автомобиля и ориентировочную стоимость автомобиля.");
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

    expect(output.reply).toBe("Предварительный диапазон займа — от 50 000 сом до максимальной суммы, которую рассчитаю по стоимости автомобиля и Вашей прописке. Чтобы назвать точный верхний предел, нужны: ориентировочная стоимость автомобиля, Ваша прописка.\n\nКакая ориентировочная стоимость автомобиля?");
  });

  it("calculates a maximum from vehicle value and residence without requesting model or year", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: { vehicleValue: 3_000_000, residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" } as any,
      settings: {}, text: "Сколько денег можете дать?", attachments: []
    });

    expect(output.reply).toContain("Без изъятия: от 50 000 сом до 600 000 сом");
    expect(output.reply).toContain("Со стоянкой: от 50 000 сом до 1 500 000 сом");
    expect(output.reply).not.toMatch(/модель и год выпуска/iu);
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

  it("gives the parking-offer classifier its active question and accepts a contextual parking choice", async () => {
    const parkingOffer = "Поручитель обязателен для программы без изъятия в Вашем регионе. Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?";
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn()
        .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
          ...validResult,
          reply: "Распознано.",
          leadCardPatch: { requestedProgram: "parking" }
        }) } }] })
        .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ decision: "accept", question: null }) } }] })
    } as any;
    const facts = {
      vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_740_000,
      requestedAmount: 200_000, requestedProgram: "without_storage",
      residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG",
      guarantorAvailable: false, guarantorAlternativeDeclined: false
    } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: `К сожалению, нет. При наличии ареста оформить займ невозможно.\n\n${parkingOffer}`, createdAt: "now" } as any],
      facts, settings: {}, text: "Понял, стоянка тогда", attachments: []
    });

    expect(JSON.parse(client.createChatCompletion.mock.calls[1][0].messages[1].content)).toMatchObject({
      activeQuestion: parkingOffer,
      clientReply: "Понял, стоянка тогда"
    });
    expect(output.result?.leadCardPatch).toMatchObject({ requestedProgram: "parking", guarantorAlternativeDeclined: false });
    expect(output.reply).not.toContain("Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?");
    expect(output.reply).toContain("У Вас есть такой поручитель?");
  });

  it("never reopens the guarantor stage after parking has been selected", async () => {
    const staleGuarantorOffer = "Поручитель обязателен для программы без изъятия в Вашем регионе. Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?";
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Поняла. И Вам потребуется поручитель:\n- возраст от 25 лет\n- проживает в г. Бишкек или Чуйской области\n- должен лично присутствовать при выдаче займа и иметь с собой ID (паспорт)\nУ Вас есть такой поручитель?",
      leadCardPatch: { requestedProgram: "parking" }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: staleGuarantorOffer, createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_740_000,
        requestedAmount: 200_000, requestedProgram: "parking",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      settings: {}, text: "Зачем если стоянка", attachments: []
    });

    expect(output.result?.leadCardPatch.requestedProgram).toBe("parking");
    expect(client.createChatCompletion.mock.calls[0][0].messages[1].content).not.toContain(staleGuarantorOffer);
    expect(output.reply).not.toMatch(/поручител/iu);
    expect(output.reply).toContain("Пожалуйста, отправьте фото ID");
  });

  it("treats a client's parking correction as closing the guarantor branch", async () => {
    const parkingOffer = "Поручитель обязателен для программы без изъятия в Вашем регионе. Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?";
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn()
        .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: parkingOffer, leadCardPatch: {} }) } }] })
        .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ decision: "accept", question: null }) } }] })
    } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: parkingOffer, createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_740_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG",
        guarantorAvailable: false, guarantorAlternativeDeclined: false
      } as any,
      settings: {}, text: "д стоянка же", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ requestedProgram: "parking", guarantorAlternativeDeclined: false });
    expect(output.reply).not.toMatch(/поручител|постановкой автомобиля на охраняемую стоянку/iu);
    expect(output.reply).toContain("Пожалуйста, отправьте фото ID");
  });

  it("switches to parking from a guarantor question before evaluating the guarantor answer", async () => {
    const guarantorQuestion = "И Вам потребуется поручитель:\n- возраст от 25 лет\n- проживает в г. Бишкек или Чуйской области\n- должен лично присутствовать при выдаче займа и иметь с собой ID (паспорт)\nУ Вас есть такой поручитель?";
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn()
        .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
          ...validResult,
          reply: "К сожалению, мы не сможем оформить займ, если населённый пункт находится за пределами Чуйской области. Подскажите, пожалуйста, правильно ли я понимаю, что этот населённый пункт находится за пределами Чуйской области? Подскажите, пожалуйста, это в Чуйской области?",
          leadCardPatch: {}
        }) } }] })
        .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ program: "parking", hasOtherStageAnswer: false, question: null }) } }] })
    } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: guarantorQuestion, createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_740_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      settings: {}, text: "давай стоянку тогда", attachments: []
    });

    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(output.result?.leadCardPatch.requestedProgram).toBe("parking");
    expect(output.result?.leadCardPatch.guarantorAvailable).toBeUndefined();
    expect(output.reply).not.toMatch(/поручител/iu);
    expect(output.reply).toContain("Пожалуйста, отправьте фото ID");
  });

  it("resets an earlier guarantor decision when the client switches back to without-storage", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: { requestedProgram: "without_storage" }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 200_000, requestedProgram: "parking",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG",
        guarantorAvailable: false, guarantorAlternativeDeclined: true,
        documentsProvided: true, declinedCarPhoto: true, familyStatus: "single"
      } as any,
      settings: {}, text: "мне нужно без изъятия", attachments: []
    });

    expect(output.result?.leadCardPatch.requestedProgram).toBe("without_storage");
    expect(output.result?.leadCardPatch.guarantorAvailable).toBeUndefined();
    expect(output.result?.leadCardPatch.guarantorAlternativeDeclined).toBeUndefined();
    expect(output.reply).toContain("По программе без изъятия доступно до 200 000 сом.");
    expect(output.reply).toContain("И Вам потребуется поручитель:");
    expect(output.reply).toContain("У Вас есть такой поручитель?");
    expect(output.reply).not.toContain("Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?");
  });

  it("uses the residence normalizer to close a Chuy clarification after a clear negation", async () => {
    const clarification = "Подскажите, пожалуйста, это в Чуйской области?";
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn()
        .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] })
        .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ decision: "reject", locality: null }) } }] })
    } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: `Напишите, пожалуйста, подробнее.\n\n${clarification}`, createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 800_000,
        requestedAmount: 100_000, requestedProgram: "without_storage",
        residenceText: "неизвестный аил", residenceNeedsClarification: true
      } as any,
      settings: {}, text: "не в чуйской", attachments: []
    });

    expect(JSON.parse(client.createChatCompletion.mock.calls[1][0].messages[1].content)).toMatchObject({ activeQuestion: "Это в Чуйской области?", clientReply: "не в чуйской" });
    expect(output.result?.leadCardPatch).toMatchObject({ residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", residenceNeedsClarification: false });
    expect(output.reply).not.toMatch(/не\s+сможем\s+оформить/iu);
    expect(output.reply).not.toMatch(/чуйской области\?/iu);
    expect(output.reply).toContain("Пожалуйста, отправьте фото ID");
  });

  it("reopens the server limit choice when a changed vehicle price makes the requested amount unavailable", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      hasMoney: true,
      reply: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.",
      leadCardPatch: { vehicleValue: 1_000_000 }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_360_000,
        requestedAmount: 870_000, requestedProgram: "without_storage",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG",
        guarantorAvailable: true, documentsProvided: true
      } as any,
      settings: {}, text: "машина теперь стоит 1 млн сом", attachments: []
    });

    expect(output.result?.leadCardPatch.vehicleValue).toBe(1_000_000);
    expect(output.reply).toContain("Сумма 870 000 сом по этой программе не проходит.");
    expect(output.reply).toContain("перейти на программу со стоянкой");
    expect(output.reply).not.toContain("Пожалуйста, отправьте фото ID");
  });

  it("reopens the server limit choice when the requested amount is changed on a later stage", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      hasMoney: true,
      reply: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.",
      leadCardPatch: { requestedAmount: 870_000 }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG",
        guarantorAvailable: true, documentsProvided: true
      } as any,
      settings: {}, text: "мне всё-таки нужно 870 тыс сом", attachments: []
    });

    expect(output.result?.leadCardPatch.requestedAmount).toBe(870_000);
    expect(output.reply).toContain("Сумма 870 000 сом по этой программе не проходит.");
    expect(output.reply).not.toContain("Пожалуйста, отправьте фото ID");
  });

  it("revalidates an explicit one-and-a-half-million request against the current programme limit", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      hasMoney: true,
      reply: "Поняла, продолжим по программе со стоянкой на сумму 1 500 000 сом.",
      leadCardPatch: { requestedAmount: 1_500_000 }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 1_000_000,
        requestedAmount: 1_000_000, requestedAmountSourceCurrency: "USD", requestedProgram: "parking",
        residenceText: "Бишкек", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY"
      } as any,
      settings: { parkingPercent: 1, parkingLimit: 2_000_000 }, text: "мне надо всё-таки 1 млн с половиной", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ requestedAmount: 1_500_000, requestedProgram: "parking" });
    expect(output.reply).toContain("По программе со стоянкой доступно до 1 000 000 сом.");
    expect(output.reply).toContain("Сумма 1 500 000 сом по этой программе не проходит.");
  });

  it("does not treat a corrected amount after the final question as an unclear final answer", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      hasMoney: true,
      reply: "Поняла.",
      // Regression: a semantic model must not turn «мне нужно 2 млн» into
      // both the loan amount and a replacement vehicle price.
      leadCardPatch: { requestedAmount: 2_000_000, vehicleValue: 500_000 }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Есть ли у Вас ещё вопросы?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000,
        requestedAmount: 1_000_000, requestedProgram: "parking",
        residenceText: "Ош", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG",
        documentsProvided: true, declinedCarPhoto: true, familyStatus: "single", visitDate: "2026-09-15", visitTime: "17:00"
      } as any,
      settings: {}, text: "мне кстати всё-таки 2 млн нужно", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ requestedAmount: 2_000_000, requestedProgram: "parking" });
    expect(output.result?.leadCardPatch.vehicleValue).toBe(2_000_000);
    expect(output.reply).toContain("По программе со стоянкой доступно до 1 000 000 сом.");
    expect(output.reply).toContain("Сумма 2 000 000 сом по этой программе не проходит.");
    expect(output.reply).not.toContain("Уточните, пожалуйста: Есть ли у Вас ещё вопросы?");
  });

  it("uses the semantic classifier, with a regex fallback, to accept ok for a single-programme limit offer", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ choice: "undecided", hasOtherStageAnswer: false, question: null }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "По программе со стоянкой доступно до 1 000 000 сом. Сумма 2 000 000 сом по этой программе не проходит. Могу продолжить на сумму до 1 000 000 сом.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000,
        requestedAmount: 2_000_000, requestedProgram: "parking",
        residenceText: "Ош", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      pricing: { minimumLoan: 50_000, parking: { available: true, publicMax: 1_000_000 }, withoutStorage: { available: true, publicMax: 800_000 } } as any,
      settings: {}, text: "ок", attachments: []
    });

    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(client.createChatCompletion.mock.calls[1][0].messages[0].content).toContain("меньшую сумму");
    expect(output.result?.leadCardPatch).toMatchObject({ requestedProgram: "parking", requestedAmount: 1_000_000 });
    expect(output.reply).not.toContain("Сумма 2 000 000 сом по этой программе не проходит.");
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

    expect(output.reply).toBe("Поняла.\n\nИ Вам потребуется поручитель:\n- возраст от 25 лет\n- проживает в г. Бишкек или Чуйской области\n- должен лично присутствовать при выдаче займа и иметь с собой ID (паспорт)\nУ Вас есть такой поручитель?");
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
    expect(refused.reply).toBe("Поручитель обязателен для программы без изъятия в Вашем регионе. Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?");

    const acceptedParking = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Поручитель обязателен для программы без изъятия в Вашем регионе. Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?", createdAt: "now" } as any],
      facts: { ...facts, guarantorAvailable: false, guarantorAlternativeDeclined: false }, settings: {}, text: "да", attachments: []
    });
    expect(acceptedParking.result?.leadCardPatch).toMatchObject({ requestedProgram: "parking", guarantorAlternativeDeclined: false });
    expect(acceptedParking.reply).toContain("Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.");
    expect(acceptedParking.reply).not.toContain("поручитель");
  });

  it("accepts an available guarantor while a parking alternative is pending without routing it to knowledge", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Распознано.", leadCardPatch: {} }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ decision: "has_guarantor", question: null }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Поручитель обязателен для программы без изъятия в Вашем регионе. Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_740_000, requestedAmount: 200_000, requestedProgram: "without_storage", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", guarantorAvailable: false, guarantorAlternativeDeclined: false } as any,
      settings: {}, text: "нет, найду поручителя", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ requestedProgram: "without_storage", guarantorAvailable: true, guarantorAlternativeDeclined: false });
    expect(output.result?.needsKnowledgeLookup).toBe(false);
    expect(output.reply).toContain("Пожалуйста, отправьте фото ID");
    expect(output.reply).not.toMatch(/можем рассмотреть программу.*стоянк|есть ли у вас.*поручител/iu);
    expect(client.createChatCompletion.mock.calls[1][0].messages[0].content).toContain("«нет, найду поручителя» означает has_guarantor");
  });

  it("answers a colloquial maximum-loan question in the same reply that accepts parking", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "По программе без изъятия ставка определяется индивидуально после осмотра автомобиля. По программе со стоянкой ставка составляет 2,4% в месяц.", leadCardPatch: {} }) } }] })
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
    expect(output.reply).toContain("Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.");
    expect(output.reply).not.toMatch(/ставк|2,4%/iu);
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

  it("never returns to residence after Karakol is classified, even if its stale clarification flag remains", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "К сожалению, у меня нет утверждённой информации по этому вопросу.",
      leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "И Вам потребуется поручитель:\n- возраст от 25 лет\n- проживает в г. Бишкек или Чуйской области\n- должен лично присутствовать при выдаче займа и иметь с собой ID (паспорт)\nУ Вас есть такой поручитель?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 2_360_000, requestedAmount: 100_000, requestedProgram: "without_storage",
        residenceText: "Каракол", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", residenceNeedsClarification: true
      } as any,
      settings: {}, text: "фвывф", attachments: []
    });

    expect(output.reply).toContain("У Вас есть такой поручитель?");
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

  it("splits parking consent from a money-limit question and answers limits rather than rates", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, loanQuestionKind: "loan_rate", reply: "Ставка определяется индивидуально.", leadCardPatch: {} }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ decision: "accept", question: "сколько денег дадите" }) } }] })
    } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Поручитель обязателен для программы без изъятия в Вашем регионе. Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Tank", vehicleYear: 2012, vehicleValue: 2_360_000, requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", guarantorAvailable: false, guarantorAlternativeDeclined: false
      } as any,
      pricing: {
        minimumLoan: 50_000, clientFacingMaximumField: "publicMax",
        withoutStorage: { available: true, rawMax: 200_000, publicMax: 200_000 },
        parking: { available: true, rawMax: 1_180_000, publicMax: 1_180_000, monthlyRate: 2.4, dailyParkingFee: 130 }
      },
      settings: {}, text: "ок. а сколько денег дадите", attachments: []
    });

    expect(client.createChatCompletion.mock.calls[1][0].messages[0].content).toContain('"question":string|null');
    expect(output.result?.leadCardPatch.requestedProgram).toBe("parking");
    expect(output.result?.clientQuestion).toBe("сколько денег дадите");
    expect(output.result?.loanQuestionKind).toBe("maximum_limit");
    expect(output.reply).toContain("Без изъятия: от 50 000 сом до 200 000 сом");
    expect(output.reply).toContain("Со стоянкой: от 50 000 сом до 1 180 000 сом");
    expect(output.reply).not.toMatch(/ставк|процент|2,4%/iu);
    expect(output.reply).toContain("Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.");
  });

  it.each([
    ["а сколько можно по максимуму", "loan_rate", "maximum_limit"],
    ["сколько денег дадите", "loan_rate", "maximum_limit"],
    ["ок. а сколько денег дадите", "loan_rate", "maximum_limit"],
    ["ставка какая", "maximum_limit", "loan_rate"],
    ["ок. а ставка какая", "maximum_limit", "loan_rate"]
  ])("routes %s to %s only from the current client wording", async (text, modelKind, expectedKind) => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, loanQuestionKind: modelKind, reply: "Ставка определяется индивидуально.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000, residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" } as any,
      settings: {}, text, attachments: []
    });

    expect(output.result?.loanQuestionKind).toBe(expectedKind);
    if (expectedKind === "maximum_limit") expect(output.reply).not.toMatch(/ставк|процент|2,4%/iu);
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
    ["где у вас стоянка", "Парковка находится недалеко от нашего офиса и находится под охраной. Точный адрес парковки не сообщается. Парковка платная — 130 сом в сутки."],
    ["авто в кредите", "К сожалению, мы не сможем оформить займ, если автомобиль в кредите."],
    ["А вещи надо забрать из авто?", "Вещи в автомобиле можно оставить или забрать — на Ваше усмотрение."],
    ["а в УНА должна стоять на учете ?", "Да. Для оформления займа автомобиль должен быть зарегистрирован в УНА на человека, который обращается за займом."],
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

  it("substitutes both maximum-loan placeholders after the knowledge route", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ reply: "Точный максимум после осмотра.", answerFound: true }) } }] }) } as any;
    const reply = await new AgentTurnService(client).answerWithKnowledge({
      messages: [],
      facts: { vehicleValue: 3_000_000, residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" } as any,
      settings: {},
      text: "а проценты какие и сумма максимальная",
      workflowFollowUp: ""
    });

    expect(reply?.reply).toContain("ставка определяется индивидуально");
    expect(reply?.reply).toContain("2,4% в месяц");
    expect(reply?.reply).toContain("Без изъятия: от 50 000 сом до MAX_LIMIT_WITHOUT сом");
    expect(reply?.reply).toContain("Со стоянкой: от 50 000 сом до MAX_LIMIT_PARK сом");
    expect(reply?.reply).not.toContain("Точный максимум после осмотра");
  });

  it("does not retain a model-invented requested-amount prompt with a maximum answer", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      reply: "Без изъятия: от 50 000 сом до MAX_LIMIT_WITHOUT сом\nСо стоянкой: от 50 000 сом до MAX_LIMIT_PARK сом\n\nЧтобы подсказать точнее по Вашей Corolla, нужна сумма займа, которая Вам необходима.",
      answerFound: true
    }) } }] }) } as any;
    const reply = await new AgentTurnService(client).answerWithKnowledge({
      messages: [], facts: { vehicleValue: 5_000_000 } as any, settings: {}, text: "королла 2022 года стоит 5 млн сколько дадите по максимуму", workflowFollowUp: ""
    });

    expect(reply?.reply).toBe("Без изъятия: от 50 000 сом до MAX_LIMIT_WITHOUT сом\nСо стоянкой: от 50 000 сом до MAX_LIMIT_PARK сом");
    expect(reply?.reply).not.toMatch(/сумм\p{L}*\s+займ/iu);
  });

  it("routes a combined rate and maximum question to knowledge without selecting a programme", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, loanQuestionKind: "loan_rate", leadCardPatch: {}, reply: "Распознано."
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: { vehicleValue: 3_000_000, residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" } as any,
      settings: {},
      text: "а проценты какие и сумма максимальная",
      attachments: []
    });

    expect(output.result?.leadCardPatch.knowledgeRequest).toEqual({ required: true, reason: "missing_approved_answer" });
    expect(output.result?.leadCardPatch.requestedProgram).toBeUndefined();
    expect(output.result?.leadCardPatch.requestedAmount).toBeUndefined();
  });

  it("does not calculate a maximum until both value and residence are known", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ reply: "ignored", answerFound: true }) } }] }) } as any;
    const reply = await new AgentTurnService(client).answerWithKnowledge({
      messages: [], facts: { vehicleValue: 3_000_000 } as any, settings: {}, text: "сколько максимум дадите", workflowFollowUp: ""
    });

    expect(reply?.reply).toBe("Максимальную сумму смогу рассчитать после того, как узнаю: Ваша прописка.");
  });

  it("never sends unresolved maximum-limit placeholders to the client", () => {
    const template = "По программе со стоянкой ставка составляет 2,4% в месяц.\nБез изъятия: от 50 000 сом до MAX_LIMIT_WITHOUT сом\nСо стоянкой: от 50 000 сом до MAX_LIMIT_PARK сом";
    const reply = replaceMaximumLimitPlaceholders(template, {
      vehicleValue: 3_000_000, residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY"
    } as any, {});

    expect(reply).toContain("до 600 000 сом");
    expect(reply).toContain("до 1 500 000 сом");
    expect(reply).not.toMatch(/MAX_LIMIT_/u);
  });

  it("removes an unresolved maximum template when calculation inputs are missing", () => {
    const reply = replaceMaximumLimitPlaceholders(
      "Без изъятия: от 50 000 сом до MAX_LIMIT_WITHOUT сом Со стоянкой: от 50 000 сом до MAX_LIMIT_PARK сом",
      {},
      {}
    );

    expect(reply).toContain("ориентировочная стоимость автомобиля");
    expect(reply).toContain("Ваша прописка");
    expect(reply).not.toMatch(/MAX_LIMIT_/u);
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
    const question = "И Вам потребуется поручитель:\n- возраст от 25 лет\n- проживает в г. Бишкек или Чуйской области\n- должен лично присутствовать при выдаче займа и иметь с собой ID (паспорт)\nУ Вас есть такой поручитель?";
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
    expect(undecided.reply).toBe("Уточните, пожалуйста, есть ли у Вас такой поручитель?");
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

  it("resolves a clear no to the Chuy clarification before model routing and immediately enforces the other-region guarantor rule", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Не смогла понять.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Да, оформление по временной прописке возможно. Подскажите, пожалуйста, это в Чуйской области?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceText: "Временная прописка", residenceNeedsClarification: true
      } as any,
      settings: {}, text: "нет", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({
      residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG", residenceNeedsClarification: false
    });
    expect(output.reply).not.toContain("Не смогла понять");
    expect(output.reply).toContain("И Вам потребуется поручитель:");
    expect(output.reply.match(/У Вас есть такой поручитель\?/g)).toHaveLength(1);
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("never treats a vehicle arrest as an unresolved residence or asks the Chuy question", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: { vehicleArrested: true, residenceText: "Ош" }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000, requestedAmount: 200_000, requestedProgram: "without_storage" } as any,
      settings: {}, text: "в аресте", attachments: []
    });

    expect(output.result?.leadCardPatch.vehicleArrested).toBe(true);
    expect(output.result?.leadCardPatch.residenceRegion).toBeUndefined();
    expect(output.result?.leadCardPatch.residenceCategory).toBeUndefined();
    expect(output.reply).toContain("Вашу прописку");
    expect(output.reply).not.toContain("Это в Чуйской области?");
    expect(output.reply).not.toContain("поручител");
  });

  it("does not let a vehicle-credit reply resolve a pending Chuy question or trigger guarantor", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "К сожалению, мы не сможем оформить займ, если автомобиль в кредите.",
      leadCardPatch: { vehicleInCredit: true, residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG" }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, это в Чуйской области?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceText: "Неизвестный населённый пункт", residenceNeedsClarification: true
      } as any,
      settings: {}, text: "в кредите", attachments: []
    });

    expect(output.result?.leadCardPatch.vehicleInCredit).toBe(true);
    expect(output.result?.leadCardPatch.residenceRegion).toBeUndefined();
    expect(output.result?.leadCardPatch.residenceCategory).toBeUndefined();
    expect(output.reply).not.toContain("поручител");
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("moves a clear no to the mandatory guarantor directly to the parking alternative instead of repeating the requirement", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Не смогла понять.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "И Вам потребуется поручитель:\n- возраст от 25 лет\n- проживает в г. Бишкек или Чуйской области\n- должен лично присутствовать при выдаче займа и иметь с собой ID (паспорт)\nУ Вас есть такой поручитель?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 430_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      settings: {}, text: "нет", attachments: []
    });

    expect(output.result?.leadCardPatch.guarantorAvailable).toBe(false);
    expect(output.reply).toContain("Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?");
    expect(output.reply).not.toContain("Не смогла понять");
    expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("does not route a bare guarantor refusal to knowledge when the model invents a question", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      needsKnowledgeLookup: true,
      clientQuestion: "какие условия?",
      leadCardPatch: { knowledgeRequest: { required: true, reason: "missing_approved_answer" } }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "И Вам потребуется поручитель:\n- возраст от 25 лет\n- проживает в г. Бишкек или Чуйской области\n- должен лично присутствовать при выдаче займа и иметь с собой ID (паспорт)\nУ Вас есть такой поручитель?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 430_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      settings: {}, text: "нету", attachments: []
    });

    expect(output.result?.leadCardPatch.guarantorAvailable).toBe(false);
    expect(output.result?.leadCardPatch.knowledgeRequest).toBeUndefined();
    expect(output.result?.needsKnowledgeLookup).toBe(false);
    expect(output.reply).toContain("Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?");
    expect(output.reply).not.toContain("нет утверждённой информации");
  });

  it.each(["какой поручитель", "какой такой"])("answers an active guarantor clarification without routing it to knowledge: %s", async (text) => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Подскажите, пожалуйста, есть ли у Вас поручитель?", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "И Вам потребуется поручитель:\n- возраст от 25 лет\n- проживает в г. Бишкек или Чуйской области\n- должен лично присутствовать при выдаче займа и иметь с собой ID (паспорт)\nУ Вас есть такой поручитель?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 430_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      settings: {}, text, attachments: []
    });

    expect(output.result?.needsKnowledgeLookup).toBe(false);
    expect(output.result?.leadCardPatch.knowledgeRequest).toBeUndefined();
    expect(output.reply).toContain("только по программе без изъятия автомобиля");
    expect(output.reply).toContain("за пределами Бишкека и Чуйской области");
    expect(output.reply).toContain("По программе со стоянкой поручитель не требуется");
    expect(output.reply).toContain("У Вас есть такой поручитель?");
  });

  it("explains that a stale guarantor prompt no longer applies to a Chuy resident", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "К сожалению, у меня нет утверждённой информации по этому вопросу.", needsKnowledgeLookup: true,
      leadCardPatch: { knowledgeRequest: { required: true, reason: "missing_approved_answer" } }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "И Вам потребуется поручитель:\n- возраст от 25 лет\n- проживает в г. Бишкек или Чуйской области\n- должен лично присутствовать при выдаче займа и иметь с собой ID (паспорт)\nУ Вас есть такой поручитель?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 430_000,
        requestedAmount: 150_000, requestedProgram: "without_storage",
        residenceRegion: "Чуйская область", residenceCategory: "BISHKEK_CHUY"
      } as any,
      settings: {}, text: "какой такой", attachments: []
    });

    expect(output.result?.needsKnowledgeLookup).toBe(false);
    expect(output.result?.leadCardPatch.knowledgeRequest).toBeUndefined();
    expect(output.reply).toContain("Чуйской области поручитель не требуется");
    expect(output.reply).not.toContain("нет утверждённой информации");
    expect(output.reply).not.toMatch(/У Вас есть такой поручитель\?/u);
  });

  it("routes a colloquial early-repayment question without a question mark to knowledge", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000,
        requestedAmount: 700_000, requestedProgram: "parking",
        residenceRegion: "Чуйская область", residenceCategory: "BISHKEK_CHUY"
      } as any,
      settings: {}, text: "и можно ли досить досрочно", attachments: []
    });

    expect(output.result?.leadCardPatch.knowledgeRequest).toEqual({ required: true, reason: "missing_approved_answer" });
    expect(output.result?.needsKnowledgeLookup).toBe(true);
  });

  it("does not answer a combined maximum-and-rate question before the vehicle registration is known", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      // Reproduce the production failure: the model classifies a combined
      // question as rate-only, but server validation corrects it.
      ...validResult, loanQuestionKind: "loan_rate", reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000 } as any,
      settings: {}, text: "камри 2022 года стоит 3 млн, сколько максимум дадите и под какой процент", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ vehicleValue: 3_000_000 });
    expect(output.result?.leadCardPatch.requestedAmount).toBeUndefined();
    expect(output.result?.leadCardPatch.requestedProgram).toBeUndefined();
    expect(output.result?.leadCardPatch.requestedMaximumAmount).toBeUndefined();
    expect(output.result?.loanQuestionKind).toBe("maximum_limit_and_rate");
    expect(output.reply).not.toMatch(/ставк|2,4%/iu);
    expect(output.reply).toContain("Чтобы назвать точный верхний предел, нужны: Ваша прописка.");
    expect(output.reply).toContain("Вашу прописку");
    expect(output.reply).not.toContain("Какая сумма займа Вам необходима?");
  });

  it("answers a maximum-loan question with programme ranges and never rates", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000,
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      settings: {}, text: "сколько максимум дадите?", attachments: []
    });

    expect(output.reply).toContain("Без изъятия: от 50 000 сом до 200 000 сом");
    expect(output.reply).toContain("Со стоянкой: от 50 000 сом до 1 000 000 сом");
    expect(output.reply).not.toMatch(/ставк|процент|2,4%/iu);
  });

  it("uses the original client turn for a money-limit question when clientQuestion is wrong", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, loanQuestionKind: "loan_rate", clientQuestion: "какая ставка?", reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000,
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      settings: {}, text: "сколько денег дадите", attachments: []
    });

    expect(output.result?.loanQuestionKind).toBe("maximum_limit");
    expect(output.reply).toContain("Без изъятия: от 50 000 сом до 200 000 сом");
    expect(output.reply).toContain("Со стоянкой: от 50 000 сом до 1 000 000 сом");
    expect(output.reply).not.toMatch(/ставк|процент|2,4%/iu);
  });

  it("uses the model JSON classification for a maximum-limit question instead of routing it to knowledge", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, loanQuestionKind: "maximum_limit", reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000,
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      settings: {}, text: "Что в моём случае вообще доступно?", attachments: []
    });

    expect(output.result?.loanQuestionKind).toBe("maximum_limit");
    expect(output.result?.leadCardPatch.knowledgeRequest).toBeUndefined();
    expect(output.reply).toContain("Без изъятия: от 50 000 сом до 200 000 сом");
    expect(output.reply).not.toMatch(/нет утверждённой информации|ставк|процент/iu);
  });

  it("uses the model JSON classification to distinguish a maximum preference from a limit question", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, loanQuestionKind: "maximum_preference", reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000 } as any,
      settings: {}, text: "Подберите мне предельный размер займа", attachments: []
    });

    expect(output.result?.leadCardPatch.requestedMaximumAmount).toBe(true);
    expect(output.result?.leadCardPatch.requestedAmount).toBeUndefined();
    expect(output.reply).toContain("Вашу прописку");
  });

  it("does not choose a programme for a maximum question, then applies the selected programme maximum", async () => {
    const quoteClient = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, loanQuestionKind: "maximum_limit", reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const facts = {
      vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
      residenceText: "Бишкек", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY"
    } as any;
    const quote = await new AgentTurnService(quoteClient).run({
      messages: [{ author: "ai", body: "Какая сумма займа Вам необходима?", createdAt: "now" } as any],
      facts, settings: {}, text: "сколько максимум дадите?", attachments: []
    });

    expect(quote.result?.leadCardPatch.requestedProgram).toBeUndefined();
    expect(quote.result?.leadCardPatch.requestedAmount).toBeUndefined();
    expect(quote.reply).toContain("Без изъятия: от 50 000 сом до 600 000 сом");
    expect(quote.reply).toContain("Со стоянкой: от 50 000 сом до 1 500 000 сом");
    expect(quote.reply).toContain("Какую программу выбираете для максимальной суммы");

    const selectionClient = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const selected = await new AgentTurnService(selectionClient).run({
      messages: [{ author: "ai", body: "Какую программу выбираете для максимальной суммы — без изъятия автомобиля или со стоянкой?", createdAt: "now" } as any],
      facts, settings: {}, text: "без изъятия", attachments: []
    });

    expect(selected.result?.leadCardPatch).toMatchObject({ requestedProgram: "without_storage", requestedAmount: 600_000 });
  });

  it("always answers a full maximum question, and records it only as the response to the amount stage", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const facts = {
      vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
      residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY"
    } as any;

    const question = await new AgentTurnService(client).run({
      messages: [], facts, settings: {}, text: "Сколько по максимуму дадите?", attachments: []
    });

    expect(question.result?.loanQuestionKind).toBe("maximum_limit");
    expect(question.result?.leadCardPatch.requestedMaximumAmount).toBeUndefined();
    expect(question.reply).toContain("Без изъятия: от 50 000 сом до 600 000 сом");
    expect(question.reply).toContain("Со стоянкой: от 50 000 сом до 1 500 000 сом");

    const amountStageResponse = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Какая сумма займа Вам необходима?", createdAt: "now" } as any],
      facts, settings: {}, text: "Сколько по максимуму дадите?", attachments: []
    });

    expect(amountStageResponse.result?.leadCardPatch).toMatchObject({ requestedMaximumAmount: true });
    expect(amountStageResponse.result?.dialogueState.nextAction).toBe("select_program_for_maximum");
    expect(amountStageResponse.reply).toContain("Без изъятия: от 50 000 сом до 600 000 сом");
    expect(amountStageResponse.reply).toContain("Какую программу выбираете для максимальной суммы");
    expect(amountStageResponse.reply).not.toBe("");
  });

  it("applies the maximum after a selection from a legacy generic programme prompt", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_180_000,
        residenceText: "Кашка-Суу", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      settings: {}, text: "без изъятия", pendingAction: "select_program_for_maximum", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ requestedProgram: "without_storage", requestedAmount: 200_000 });
    expect(output.reply).toContain("По программе без изъятия доступно до 200 000 сом.");
    expect(output.reply).not.toContain("Какая сумма займа Вам необходима?");
    expect(output.result?.dialogueState.nextAction).not.toBe("select_program_for_maximum");
  });

  it("keeps a maximum request through residence collection and applies only the later selected programme maximum", async () => {
    const questionClient = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Распознано.", leadCardPatch: {} }) } }] }) } as any;
    const initialFacts = { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_180_000 } as any;
    const asked = await new AgentTurnService(questionClient).run({
      messages: [{ author: "ai", body: "Какая сумма займа Вам необходима?", createdAt: "now" } as any],
      facts: initialFacts, settings: {}, text: "а сколько можно по максимуму", attachments: []
    });

    expect(asked.result?.dialogueState.nextAction).toBe("select_program_for_maximum");
    expect(asked.result?.leadCardPatch).not.toHaveProperty("requestedAmount");
    expect(asked.reply).toContain("Вашу прописку");

    const residenceClient = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Не смогла понять. Напишите, пожалуйста, подробнее.", leadCardPatch: {}
    }) } }] }) } as any;
    const afterResidence = await new AgentTurnService(residenceClient).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.", createdAt: "now" } as any],
      facts: asked.result?.leadCardPatch ?? initialFacts, settings: {}, text: "кашка су",
      pendingAction: "select_program_for_maximum", attachments: []
    });

    expect(afterResidence.result?.leadCardPatch).toMatchObject({
      residenceText: "Кашка-Суу", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
    });
    expect(afterResidence.result?.dialogueState.nextAction).toBe("select_program_for_maximum");
    expect(afterResidence.reply).toBe("Какую программу выбираете для максимальной суммы — без изъятия автомобиля или со стоянкой?");
    expect(afterResidence.reply).not.toContain("Какая сумма займа Вам необходима?");

    const selectionClient = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Распознано.", leadCardPatch: {} }) } }] }) } as any;
    const selected = await new AgentTurnService(selectionClient).run({
      messages: [{ author: "ai", body: "Какую программу выбираете для максимальной суммы — без изъятия автомобиля или со стоянкой?", createdAt: "now" } as any],
      facts: afterResidence.result?.leadCardPatch ?? initialFacts, settings: {}, text: "со стоянкой",
      pendingAction: "select_program_for_maximum", attachments: []
    });

    expect(selected.result?.leadCardPatch).toMatchObject({ requestedProgram: "parking", requestedAmount: 1_090_000 });
    expect(selected.reply).toContain("По программе со стоянкой доступно до 1 090 000 сом.");
  });

  it("answers the maximum-and-rate question before requesting residence", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, loanQuestionKind: "maximum_preference", reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000 } as any,
      settings: {}, text: "сколько максимум дадите и под какой процент", attachments: []
    });

    expect(output.result?.loanQuestionKind).toBe("maximum_limit_and_rate");
    expect(output.result?.leadCardPatch.requestedProgram).toBeUndefined();
    expect(output.result?.leadCardPatch.requestedAmount).toBeUndefined();
    expect(output.reply).toContain("ставка определяется индивидуально");
    expect(output.reply).toContain("ставка составляет 2,4% в месяц");
    expect(output.reply).toContain("Максимальную сумму смогу рассчитать после получения Вашей прописки.");
    expect(output.reply).toContain("Вашу прописку");
  });

  it("uses the semantic classifier before the regex fallback for a document refusal", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Распознано.", leadCardPatch: {} }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ decision: "reject" }) } }] })
    } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 600_000, requestedProgram: "without_storage",
        residenceText: "Бишкек", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY"
      } as any,
      settings: {}, text: "сегодня не смогу отправить", attachments: []
    });

    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(output.result?.leadCardPatch).toMatchObject({ declinedDocuments: true, residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" });
    expect(output.reply).toContain("2–3 фотографии автомобиля");
  });

  it("acknowledges 'не найду фото' as a document-stage refusal before moving on", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Не смогла понять. Напишите, пожалуйста, подробнее.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 600_000, requestedProgram: "without_storage",
        residenceText: "Бишкек", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY"
      } as any,
      settings: {}, text: "не найду фото", attachments: []
    });

    expect(output.result?.leadCardPatch.declinedDocuments).toBe(true);
    expect(output.reply).toBe("Хорошо, документы можно отправить позже.\n\nПожалуйста, отправьте 2–3 фотографии автомобиля.");
  });

  it("answers a loan question without consuming the pending guarantor answer", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, loanQuestionKind: "maximum_limit", reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "И Вам потребуется поручитель:\n- возраст от 25 лет\n- проживает в г. Бишкек или Чуйской области\n- должен лично присутствовать при выдаче займа и имеет с собой ID (паспорт)\nУ Вас есть такой поручитель?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      settings: {}, text: "А сколько денег дадите?", attachments: []
    });

    expect(output.result?.leadCardPatch.guarantorAvailable).toBeUndefined();
    expect(output.reply).toContain("Без изъятия: от 50 000 сом до 200 000 сом");
    expect(output.reply.match(/У Вас есть такой поручитель\?/gu)).toHaveLength(1);
  });

  it("extracts vehicle, parking programme, residence and vehicle value from one client message", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      hasMoney: true,
      residenceStatement: true,
      programStatement: true,
      reply: "Распознано.",
      leadCardPatch: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 6_000_000,
        requestedProgram: "parking", residenceText: "Ош"
      }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [], facts: {}, settings: {},
      text: "Камри 2022, нужна парковка, я из Оша, стоит 6 млн", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({
      vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 6_000_000,
      requestedProgram: "parking", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
    });
    expect(output.result?.leadCardPatch.requestedAmount).toBeUndefined();
    expect(output.reply).toContain("Какая сумма займа Вам необходима?");
  });

  it.each([
    "официально не расписаны, но дети есть",
    "я вообще официально брак не регистрировал",
    "в браке гражданском"
  ])("treats %s as not officially married", async (text) => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Распознано.", leadCardPatch: {} }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ familyStatus: "single" }) } }] })
    } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, Ваше семейное положение — Вы в браке, в разводе или не в браке.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 600_000, requestedProgram: "without_storage",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        declinedDocuments: true, declinedCarPhoto: true
      } as any,
      settings: {}, text, attachments: []
    });

    expect(client.createChatCompletion.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(output.result?.leadCardPatch.familyStatus).toBe("single");
    expect(output.reply).toContain("Нотариальное согласие супруга или супруги в таком случае не требуется.");
  });

  it("replaces a prior official marriage after a later civil-marriage correction", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Распознано.", leadCardPatch: {} }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ familyStatus: "single" }) } }] })
    } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Для оформления потребуется нотариальное согласие супруга или супруги. Вам удобно оформить согласие при визите в офис?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 600_000, requestedProgram: "without_storage",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        declinedDocuments: true, declinedCarPhoto: true, familyStatus: "married"
      } as any,
      settings: {}, text: "в гражданском", attachments: []
    });

    expect(output.result?.leadCardPatch.familyStatus).toBe("single");
    expect(output.reply).toContain("Нотариальное согласие супруга или супруги в таком случае не требуется.");
    expect(output.reply).not.toContain("Вам удобно оформить согласие");
  });

  it("recovers an already stated loan amount instead of asking for it again", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Не смогла понять. Напишите, пожалуйста, подробнее.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [
        { author: "client", body: "Мне нужно 700 000 сом", createdAt: "before" } as any,
        { author: "ai", body: "Спасибо, документы получены. Какая сумма займа Вам необходима?", createdAt: "now" } as any
      ],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_180_000,
        requestedProgram: "without_storage", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG",
        declinedDocuments: true
      } as any,
      settings: {}, text: "я же написал", attachments: []
    });

    expect(output.result?.leadCardPatch.requestedAmount).toBe(700_000);
    expect(output.reply).toContain("Сумма 700 000 сом по этой программе не проходит");
    expect(output.reply).not.toContain("Какая сумма займа Вам необходима?");
    expect(output.reply).not.toContain("Не смогла понять");
  });

  it("does not persist a money value hallucinated from a prior FX conversion", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, hasMoney: true, loanQuestionKind: "maximum_limit", reply: "Распознано.",
      leadCardPatch: { vehicleValue: 26_200_000 }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Стоимость автомобиля: 30 000 долларов США — ориентировочно 2 620 000 сом. Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.", createdAt: "now" } as any],
      facts: { vehicleModel: "Corolla", vehicleYear: 2022, vehicleValue: 2_620_000, vehicleValueSourceCurrency: "USD" } as any,
      settings: {}, text: "сколько дадите", attachments: []
    });

    expect(output.result?.leadCardPatch.vehicleValue).toBe(2_620_000);
    expect(output.result?.leadCardPatch.residenceText).toBeUndefined();
    expect(output.reply).toContain("Чтобы рассчитать максимальную сумму, нужны: Ваша прописка.");
    expect(output.reply).not.toContain("Чуйской области?");
  });

  it.each(["а мене сколько максимум дадите", "сколько денег дадите"])("answers %s as a maximum-limit question even when the model misses it", async (text) => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, loanQuestionKind: "none", reply: "К сожалению, у меня нет утверждённой информации.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_900_000,
        residenceText: "Ош", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      settings: {}, text, attachments: []
    });

    expect(output.result?.loanQuestionKind).toBe("maximum_limit");
    expect(output.reply).toContain("Без изъятия: от 50 000 сом до 200 000 сом");
    expect(output.reply).toContain("Со стоянкой: от 50 000 сом до 950 000 сом");
    expect(output.reply).not.toMatch(/ставк|процент|утверждённой информации/iu);
  });

  it("never answers with a rate when a model misclassifies an explicit maximum question", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, loanQuestionKind: "loan_rate", reply: "По стоянке ставка 2,4%.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_900_000,
        residenceText: "Ош", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      settings: {}, text: "а мене сколько максимум дадите", attachments: []
    });

    expect(output.result?.loanQuestionKind).toBe("maximum_limit");
    expect(output.reply).toContain("Без изъятия: от 50 000 сом до 200 000 сом");
    expect(output.reply).not.toMatch(/ставк|процент|2,4%/iu);
  });

  it("rejects a model-requested knowledge lookup for a limit-only question", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      loanQuestionKind: "loan_rate",
      reply: "По программе без изъятия ставка определяется индивидуально.",
      needsKnowledgeLookup: true,
      leadCardPatch: { knowledgeRequest: { required: true, reason: "missing_approved_answer" } }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: {
        vehicleValue: 1_900_000,
        residenceRegion: "Другой регион Кыргызстана",
        residenceCategory: "OTHER_KG"
      } as any,
      settings: {}, text: "А сколько дадите денег?", attachments: []
    });

    expect(output.result?.loanQuestionKind).toBe("maximum_limit");
    expect(output.result?.needsKnowledgeLookup).toBe(false);
    expect(output.result?.leadCardPatch.knowledgeRequest).toBeUndefined();
    expect(output.reply).toContain("Без изъятия: от 50 000 сом до 200 000 сом");
    expect(output.reply).toContain("Со стоянкой: от 50 000 сом до 950 000 сом");
    expect(output.reply).not.toMatch(/ставк|процент|2,4%/iu);
  });

  it("keeps a knowledge request for an address alongside a maximum-limit question", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      loanQuestionKind: "maximum_limit",
      reply: "Распознано.",
      leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: { vehicleValue: 3_000_000, residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" } as any,
      settings: {}, text: "нет с собой, а адрес какой, и сколько вообще денег можете дать", attachments: []
    });

    expect(output.result?.loanQuestionKind).toBe("maximum_limit");
    expect(output.result?.needsKnowledgeLookup).toBe(true);
    expect(output.result?.leadCardPatch.knowledgeRequest).toMatchObject({ required: true });
    expect(output.reply).toContain("Без изъятия: от 50 000 сом до 600 000 сом");
    expect(output.reply).toContain("Со стоянкой: от 50 000 сом до 1 500 000 сом");
  });

  it("reopens a closed visit after any later message instead of repeating the closing acknowledgement", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Спасибо за обращение. Ожидайте звонка менеджера, он подтвердит время визита.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 600_000, requestedProgram: "parking",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single",
        visitDate: "2026-09-10", visitTime: "12:00", clientClosed: true
      } as any,
      settings: {}, text: "Я перепутал регион", attachments: []
    });

    expect(output.result?.leadCardPatch.clientClosed).toBe(false);
    expect(output.reply).not.toContain("Спасибо за обращение. Ожидайте звонка");
    expect(output.reply).toContain("Есть ли у Вас ещё вопросы?");
  });

  it("does not announce a post-visit residence correction to the client", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Спасибо за обращение. Ожидайте звонка менеджера, он подтвердит время визита.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceText: "Ош", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG",
        guarantorAvailable: true, documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single",
        visitDate: "2026-09-10", visitTime: "12:00", clientClosed: true
      } as any,
      settings: {}, text: "Я из Бишкека", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY", clientClosed: false });
    expect(output.reply).not.toMatch(/поняла|ваша\s+прописка|бишкек/iu);
    expect(output.reply).not.toContain("поручител");
  });

  it("leaves the rate portion of a combined maximum question to the knowledge pass", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, loanQuestionKind: "maximum_limit_and_rate", reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000 } as any,
      settings: {}, text: "сколько максимум дадите и под какой процент?", attachments: []
    });

    expect(output.result?.needsKnowledgeLookup).toBe(true);
    expect(output.reply).toContain("Максимальную сумму смогу рассчитать после получения Вашей прописки.");
    expect(output.reply).not.toMatch(/ставка определяется|2,4%|парковка 130/iu);
  });

  it("continues to car photos after attachment recovery instead of promising a re-check", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockRejectedValue(new Error("fetch failed")) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 600_000, requestedProgram: "parking",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY"
      } as any,
      settings: {}, text: "", attachments: [{ id: "document", mimeType: "image/jpeg" }]
    });

    expect(output.result?.leadCardPatch.documentsProvided).toBe(true);
    expect(output.result?.targetEvent).toBe("documents");
    expect(output.reply).toBe("Спасибо, документы получены.\n\nПожалуйста, отправьте 2–3 фотографии автомобиля.");
    expect(output.reply).not.toMatch(/неразборчив|уточню нужную сторону/iu);
  });

  it("does not route a one-word stage reply without a question mark to knowledge", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "К сожалению, у меня нет утверждённой информации по этому вопросу.",
      needsKnowledgeLookup: true,
      leadCardPatch: { knowledgeRequest: { required: true, reason: "missing_approved_answer" } }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте 2–3 фотографии автомобиля.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 600_000, requestedProgram: "parking",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        declinedDocuments: true
      } as any,
      settings: {}, text: "сейчас", attachments: []
    });

    expect(output.result?.needsKnowledgeLookup).toBe(false);
    expect(output.result?.leadCardPatch.knowledgeRequest).toBeUndefined();
    expect(output.reply).toBe("Пожалуйста, отправьте 2–3 фотографии автомобиля.");
  });

  it("falls back to a maximum-limit question when the interpreter misses colloquial money wording", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, loanQuestionKind: "none", reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, автомобиль был приобретён во время брака или после развода?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY", familyStatus: "divorced"
      } as any,
      settings: {}, text: "А сколько денег дадите", attachments: []
    });

    expect(output.result?.loanQuestionKind).toBe("maximum_limit");
    expect(output.reply).toContain("Без изъятия: от 50 000 сом до 600 000 сом");
    expect(output.reply).toContain("Со стоянкой: от 50 000 сом до 1 500 000 сом");
    expect(output.reply).toContain("Пожалуйста, отправьте фото ID");
  });

  it.each(["сколько вообще дадите", "а денег сколько"])("answers %s before a pending spouse-consent question", async (text) => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, loanQuestionKind: "none", reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Для оформления потребуется нотариальное согласие супруга или супруги. Его можно оформить у любого нотариуса или у нотариуса в нашем здании; ориентировочная стоимость — 1500 сом. Вам удобно оформить согласие при визите в офис?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 600_000, requestedProgram: "without_storage",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY", familyStatus: "married"
      } as any,
      settings: {}, text, attachments: []
    });

    expect(output.result?.loanQuestionKind).toBe("maximum_limit");
    expect(output.reply).toContain("Без изъятия: от 50 000 сом до 600 000 сом");
    expect(output.reply).toContain("Со стоянкой: от 50 000 сом до 1 500 000 сом");
    expect(output.reply).toContain("Пожалуйста, отправьте фото ID");
    expect(output.reply).not.toContain("не смогу назвать сумму дистанционно");
  });

  it("overrides a mistaken rate classification for an explicit maximum-money question", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, loanQuestionKind: "loan_rate", reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, автомобиль был приобретён во время брака или после развода?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY", familyStatus: "divorced"
      } as any,
      settings: {}, text: "А максимум сколько дадите денег", attachments: []
    });

    expect(output.result?.loanQuestionKind).toBe("maximum_limit");
    expect(output.result?.needsKnowledgeLookup).toBe(false);
    expect(output.reply).toContain("Без изъятия: от 50 000 сом до 600 000 сом");
    expect(output.reply).toContain("Со стоянкой: от 50 000 сом до 1 500 000 сом");
    expect(output.reply).not.toMatch(/ставка определяется|2,4%|срок займа/iu);
  });

  it("treats a number next to 'дадите' as a limit question, not the vehicle price", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      loanQuestionKind: "none",
      hasMoney: true,
      leadCardPatch: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 1_000_000 }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [], facts: {}, settings: {}, text: "камри 2022 г 1 млн дадите?", attachments: []
    });

    expect(output.result?.loanQuestionKind).toBe("maximum_limit");
    expect(output.result?.leadCardPatch).toMatchObject({ vehicleModel: "Camry", vehicleYear: 2022 });
    expect(output.result?.leadCardPatch.vehicleValue).toBeUndefined();
    expect(output.result?.leadCardPatch.requestedAmount).toBeUndefined();
    expect(output.reply).toContain("ориентировочная стоимость автомобиля");
    expect(output.reply).toContain("Ваша прописка");
  });

  it.each([
    "сколько бабок дашь", "Сколько дадите", "Денег сколько", "сколько вообще дадите", "а денег сколько", "Какие лимиты", "Лимиты",
    "От сколько", "До скольки", "До скольки даете"
  ])("classifies colloquial limit wording %s as a maximum-limit question", async (text) => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, loanQuestionKind: "none", reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000, residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" } as any,
      settings: {}, text, attachments: []
    });

    expect(output.result?.loanQuestionKind).toBe("maximum_limit");
    expect(output.reply).toContain("Без изъятия: от 50 000 сом до 600 000 сом");
    expect(output.reply).toContain("Со стоянкой: от 50 000 сом до 1 500 000 сом");
  });

  it("keeps a semantic non-money question on the knowledge route during a workflow stage", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: { knowledgeRequest: { required: true, reason: "missing_approved_answer" } }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, автомобиль был приобретён во время брака или после развода?", createdAt: "now" } as any],
      facts: { familyStatus: "divorced" } as any,
      settings: {}, text: "А кофе есть", attachments: []
    });

    expect(output.result?.needsKnowledgeLookup).toBe(true);
    expect(output.result?.leadCardPatch.knowledgeRequest).toMatchObject({ required: true });
  });

  it("answers a combined maximum-and-rate question after vehicle and registration without requiring a requested amount", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000,
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      settings: {}, text: "сколько максимум дадите и какая процентная ставка?", attachments: []
    });

    expect(output.reply).toContain("Без изъятия: от 50 000 сом до 200 000 сом");
    expect(output.reply).toContain("Со стоянкой: от 50 000 сом до 1 000 000 сом");
    expect(output.result?.needsKnowledgeLookup).toBe(true);
    expect(output.reply).not.toMatch(/ставк|2,4%/iu);
  });

  it("explains which facts are needed for a maximum question before collecting vehicle data", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [], facts: {}, settings: {}, text: "сколько денег по максимуму дадите", attachments: []
    });

    expect(output.result?.loanQuestionKind).toBe("maximum_limit");
    expect(output.result?.leadCardPatch.requestedAmount).toBeUndefined();
    expect(output.result?.leadCardPatch.requestedProgram).toBeUndefined();
    expect(output.reply).toContain("Чтобы назвать точный верхний предел");
    expect(output.reply).toMatch(/ориентировочн\p{L}*\s+стоимост\p{L}*\s+автомобил\p{L}*/iu);
    expect(output.reply).toContain("Ваша прописка");
    expect(output.reply).toContain("Какая ориентировочная стоимость автомобиля?");
  });

  it("defers an explicit maximum-loan preference until residence is known, then uses the parking maximum", async () => {
    const initialClient = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const initial = await new AgentTurnService(initialClient).run({
      messages: [],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000 } as any,
      settings: {}, text: "Мне нужна максимальная сумма займа", attachments: []
    });

    expect(initial.result?.leadCardPatch).toMatchObject({ requestedMaximumAmount: true });
    expect(initial.result?.leadCardPatch.requestedAmount).toBeUndefined();
    expect(initial.reply).toContain("Вашу прописку");

    const residenceClient = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const resolved = await new AgentTurnService(residenceClient).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, Вашу прописку — Бишкек, Чуйская область или другой регион Кыргызстана.", createdAt: "now" } as any],
      facts: { ...initial.result?.leadCardPatch } as any,
      settings: {}, text: "Бишкек", attachments: []
    });

    expect(resolved.result?.leadCardPatch).toMatchObject({ requestedMaximumAmount: true, requestedProgram: "parking", requestedAmount: 1_500_000 });
  });

  it("invalidates an earlier amount and programme when an explicit maximum preference needs a new residence calculation", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, loanQuestionKind: "maximum_preference", reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "На какой день и время Вам удобно подъехать?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single"
      } as any,
      settings: {}, text: "А вообще нужна максимальная сумма займа", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ requestedMaximumAmount: true });
    expect(output.result?.leadCardPatch.requestedAmount).toBeUndefined();
    expect(output.result?.leadCardPatch.requestedProgram).toBeUndefined();
    expect(output.reply).toContain("Вашу прописку");
    expect(output.reply).not.toMatch(/на какой день|во сколько.*подъехать/iu);
  });

  it("reopens the amount stage when the client asks to change the amount without naming a replacement", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "На какой день и время Вам удобно подъехать?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single"
      } as any,
      settings: {}, text: "Мне нужна другая сумма займа", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ requestedMaximumAmount: false });
    expect(output.result?.leadCardPatch.requestedAmount).toBeUndefined();
    expect(output.result?.leadCardPatch.requestedProgram).toBeUndefined();
    expect(output.reply).toContain("Какая сумма займа Вам необходима?");
    expect(output.reply).not.toMatch(/на какой день|во сколько.*подъехать/iu);
  });

  it("answers a combined maximum-and-rate question with both programme ranges after all required facts are known", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 500_000, requestedProgram: "without_storage",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY"
      } as any,
      settings: {}, text: "сколько максимум дадите и под какой процент", attachments: []
    });

    expect(output.reply).toContain("Без изъятия: от 50 000 сом до 600 000 сом");
    expect(output.reply).toContain("Со стоянкой: от 50 000 сом до 1 500 000 сом");
    expect(output.result?.needsKnowledgeLookup).toBe(true);
    expect(output.reply).not.toMatch(/ставк|2,4%/iu);
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
    expect(output.reply).toContain("Ваша прописка — Чуйская область");
    expect(output.reply).toContain("По программе без изъятия Вам доступно до 600 000 сом");
    expect(output.reply).toContain("Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.");
  });

  it("accepts an explicit Bir-Bulak registration correction and closes the guarantor branch", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Распознано.",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "И Вам потребуется поручитель:\n- возраст от 25 лет\n- проживает в г. Бишкек или Чуйской области\n- должен лично присутствовать при выдаче займа и иметь с собой ID (паспорт)\nУ Вас есть такой поручитель?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_740_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceText: "Кашка-Суу", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      settings: {}, text: "а нет я прописан в бир булаке", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({
      residenceText: "Бер-Булак", residenceRegion: "Чуйская область", residenceCategory: "BISHKEK_CHUY",
      residenceNeedsClarification: false
    });
    expect(output.reply).toContain("Ваша прописка — Чуйская область");
    expect(output.reply).toContain("Пожалуйста, отправьте фото ID");
    expect(output.reply).not.toMatch(/поручител/iu);
  });

  it.each([
    ["бир булак в чуйской", "OTHER_KG", "BISHKEK_CHUY", "Чуйская область"],
    ["нахера поручитель если я живу в чуйской", "OTHER_KG", "BISHKEK_CHUY", "Чуйская область"],
    ["это не в чуйской", "BISHKEK_CHUY", "OTHER_KG", "Другой регион Кыргызстана"]
  ])("immediately applies an explicit Chuy residence correction: %s", async (text, previousCategory, expectedCategory, expectedRegion) => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "И Вам потребуется поручитель:\n- возраст от 25 лет\n- проживает в г. Бишкек или Чуйской области\n- должен лично присутствовать при выдаче займа и иметь с собой ID (паспорт)\nУ Вас есть такой поручитель?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceText: previousCategory === "BISHKEK_CHUY" ? "Бишкек" : "Кашка-Суу",
        residenceRegion: previousCategory === "BISHKEK_CHUY" ? "Бишкек" : "Другой регион Кыргызстана",
        residenceCategory: previousCategory
      } as any,
      settings: {}, text, attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({
      residenceCategory: expectedCategory, residenceRegion: expectedRegion, residenceNeedsClarification: false
    });
  });

  it("applies a full-sentence Bishkek residence correction during an amount-limit branch", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Распознано.",
      leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "По программе без изъятия доступно до 200 000 сом. Сумма 520 000 сом по этой программе не проходит. Со стоянкой при текущей стоимости автомобиля доступно до 1 180 000 сом. Могу продолжить либо на сумму до 200 000 сом без изъятия, либо перейти на программу со стоянкой и рассмотреть сумму до 1 180 000 сом.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_500_000,
        requestedAmount: 520_000, requestedProgram: "without_storage",
        residenceText: "Каракол", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      settings: {}, text: "Я вообще-то в Бишкеке", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({
      residenceText: "Бишкек", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
      residenceNeedsClarification: false
    });
    expect(output.reply).toContain("до 600 000 сом");
    expect(output.reply).not.toContain("Сумма 520 000 сом по этой программе не проходит");
    expect(output.reply).toContain("Пожалуйста, отправьте фото ID");
  });

  it("uses a model-extracted residence correction before recalculating the limit at a later stage", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Распознано.",
      leadCardPatch: { residenceText: "Ош" }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_500_000,
        requestedAmount: 520_000, requestedProgram: "without_storage",
        residenceText: "Бишкек", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY"
      } as any,
      settings: {}, text: "Вообще-то моя прописка в Оше", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({
      residenceText: "Ош", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG",
      residenceNeedsClarification: false
    });
    expect(output.reply).toContain("По программе без изъятия доступно до 200 000 сом");
    expect(output.reply).toContain("Сумма 520 000 сом по этой программе не проходит");
    expect(output.reply).not.toContain("Пожалуйста, отправьте фото ID");
  });

  it("treats a misspelled explicit city correction as residence, not a refusal of documents", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Хорошо, документы можно отправить позже.", leadCardPatch: {} }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ locality: "Балыкчы" }) } }] })
    } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 1_500_000, requestedProgram: "parking",
        residenceText: "Бишкек", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY"
      } as any,
      settings: {}, text: "я вообще-то из баклагока", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({
      residenceText: "Балыкчы", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
    });
    expect(output.result?.leadCardPatch.declinedDocuments).toBeUndefined();
    expect(output.reply).not.toContain("документы можно отправить позже");
    expect(output.reply).toContain("Пожалуйста, отправьте фото ID");
  });

  it("recalculates the active programme limit before the next stage after a vehicle-value correction", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Распознано.",
      hasMoney: true,
      leadCardPatch: { vehicleValue: 800_000 }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_500_000,
        requestedAmount: 520_000, requestedProgram: "without_storage",
        residenceText: "Бишкек", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY"
      } as any,
      settings: {}, text: "Стоимость авто не 1 500 000, а 800 000 сом", attachments: []
    });

    expect(output.result?.leadCardPatch.vehicleValue).toBe(800_000);
    expect(output.reply).toContain("По программе без изъятия доступно до 320 000 сом");
    expect(output.reply).toContain("Сумма 520 000 сом по этой программе не проходит");
    expect(output.reply).not.toContain("Пожалуйста, отправьте фото ID");
  });

  it("uses a corrected requested amount before choosing the next stage", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Распознано.",
      hasMoney: true,
      leadCardPatch: { requestedAmount: 300_000 }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "По программе без изъятия доступно до 200 000 сом. Сумма 520 000 сом по этой программе не проходит. Со стоянкой при текущей стоимости автомобиля доступно до 750 000 сом. Могу продолжить либо на сумму до 200 000 сом без изъятия, либо перейти на программу со стоянкой и рассмотреть сумму до 750 000 сом.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_500_000,
        requestedAmount: 520_000, requestedProgram: "without_storage",
        residenceText: "Ош", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      settings: {}, text: "Мне нужно не 520 000, а 300 000 сом", attachments: []
    });

    expect(output.result?.leadCardPatch.requestedAmount).toBe(300_000);
    expect(output.reply).toContain("Сумма 300 000 сом по этой программе не проходит");
    expect(output.reply).not.toContain("Сумма 520 000 сом по этой программе не проходит");
    expect(output.reply).not.toContain("Пожалуйста, отправьте фото ID");
  });

  it("does not activate the guarantor stage before the vehicle value and loan amount are known", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(validResult) } }] }) } as any;

    await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите стоимость автомобиля.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, requestedProgram: "without_storage", residenceCategory: "OTHER_KG",
        guarantorAvailable: false, guarantorAlternativeDeclined: true,
        stageCompletion: { vehicle: true, program: true, guarantor: true }
      } as any,
      settings: {}, text: "чтолпон ата", attachments: []
    });

    const context = JSON.parse((client.createChatCompletion.mock.calls[0][0].messages[1].content as Array<{ type: string; text?: string }>)[0].text ?? "{}");
    expect(context.guarantorRequirement).toBeUndefined();
    expect(context.leadCard.guarantorAvailable).toBeUndefined();
    expect(context.leadCard.guarantorAlternativeDeclined).toBeUndefined();
    expect(context.leadCard.stageCompletion.guarantor).toBeUndefined();
  });

  it("ignores guarantor fields emitted by the general model", async () => {
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
        ...validResult,
        leadCardPatch: { guarantorAvailable: false, guarantorAlternativeDeclined: true }
      }) } }] })
    } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, модель автомобиля.", createdAt: "now" } as any],
      facts: { guarantorAvailable: true, guarantorAlternativeDeclined: false } as any,
      settings: {}, text: "спасибо", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ guarantorAvailable: true, guarantorAlternativeDeclined: false });
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
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG",
        guarantorAvailable: true
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

  it("does not say it failed to understand after the model resolved a terse family-status reply", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Нужно уточнение.", leadCardPatch: { familyStatus: "married" }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, Ваше семейное положение — Вы в браке, в разводе или не в браке.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 430_000,
        requestedAmount: 100_000, requestedProgram: "without_storage",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        declinedDocuments: true, declinedCarPhoto: true
      } as any,
      settings: {}, text: "в", attachments: []
    });

    expect(output.result?.leadCardPatch.familyStatus).toBe("married");
    expect(output.reply).toContain("Для оформления потребуется нотариальное согласие");
    expect(output.reply).not.toContain("Не смогла понять");
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

  it.each([
    ["в", true], ["во время", true], ["в браке", true], ["во время брака", true],
    ["после", false], ["не в", false], ["не в браке", false], ["вне брака", false], ["после развода", false]
  ])("understands the short divorce purchase-timing answer %s", async (text, expected) => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] })
      // An undecided semantic model forces verification of the regex fallback.
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ timing: "undecided" }) } }] })
    } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, автомобиль был приобретён во время брака или после развода?", createdAt: "now" } as any],
      facts: { familyStatus: "divorced" } as any,
      settings: {}, text, attachments: []
    });

    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(output.result?.leadCardPatch).toMatchObject({ familyStatus: "divorced", vehicleBoughtDuringMarriage: expected });
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

  it("asks only about office consent after the client reports being married", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      // Reproduce the fault: the model incorrectly treats «в браке» as a
      // consent to arrange notarisation at the office in the same turn.
      ...validResult, reply: "Поняла.", leadCardPatch: { familyStatus: "married", spouseConsentAtOffice: true }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Хорошо, фотографии автомобиля можно отправить позже. Подскажите, пожалуйста, Ваше семейное положение — Вы в браке, в разводе или не в браке.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 430_000,
        requestedAmount: 100_000, requestedProgram: "without_storage",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        declinedDocuments: true, declinedCarPhoto: true
      } as any,
      settings: {}, text: "в браке", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({ familyStatus: "married" });
    expect(output.result?.leadCardPatch.spouseConsentAtOffice).toBeUndefined();
    expect(output.reply).toContain("Вам удобно оформить согласие при визите в офис?");
    expect(output.reply).not.toContain("На какой день и время Вам удобно подъехать?");
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

  it("passes every question from one client message to knowledge without replacing the answer with one FAQ", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({
      model: "knowledge-test-model",
      choices: [{ message: { content: JSON.stringify({
        reply: "Парковка находится недалеко от офиса и охраняется. Стоимость парковки — 130 сом в сутки. Вещи в автомобиле можно оставить или забрать — на Ваше усмотрение.",
        answerFound: true
      }) } }]
    }) } as any;
    const service = new AgentTurnService(client);
    const text = "а где у вас стоянка, она платная ? и надо ли забирать из машины вещи";

    const output = await service.answerWithKnowledge({ messages: [], facts: {}, settings: {}, text, currentTurnMessages: [{ index: 1, text }], workflowFollowUp: "" });

    expect(output?.reply).toContain("130 сом в сутки");
    expect(output?.reply).toContain("Вещи в автомобиле");
    const context = JSON.parse(client.createChatCompletion.mock.calls[0][0].messages[1].content);
    expect(context.currentMessage).toBe(text);
    expect(context.currentTurnMessages).toEqual([{ index: 1, text }]);
  });

  it("answers an accident-and-tow-truck question even when it follows a document request", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Распознано.", leadCardPatch: {} }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ decision: "not_an_answer" }) } }] })
    } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000, requestedAmount: 600_000, requestedProgram: "parking" },
      settings: {}, text: "нету под рукой, но машина после ДТП, можно ее на эвакуаторе привезти?", attachments: []
    });

    expect(output.result?.leadCardPatch.accidentNotDrivable).toBe(true);
    expect(output.result?.dialogueState).toMatchObject({ stage: "REFUSED", status: "refuse" });
    expect(output.reply).toContain("принять его в залог не сможем");
    expect(output.reply).not.toContain("документы можно отправить позже");
  });

  it("routes a non-drivable accident follow-up to knowledge instead of consuming it as family status", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Распознано.",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Автомобиль после серьёзного ДТП принимается только если он на ходу; повреждения могут повлиять на оценочную стоимость. Подскажите, пожалуйста, Ваше семейное положение — Вы в браке, в разводе или не в браке.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000, requestedAmount: 600_000, requestedProgram: "parking" },
      settings: {}, text: "машина не находу", attachments: []
    });

    expect(output.result?.leadCardPatch).toMatchObject({
      accidentNotDrivable: true,
      knowledgeRequest: { required: true, reason: "missing_approved_answer" }
    });
    expect(output.result?.leadCardPatch.familyStatus).toBeUndefined();
  });

  it("honours the model's unrelated-stage classification before regex fallback", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Распознано.",
      currentStageResponse: "unrelated",
      leadCardPatch: { knowledgeRequest: { required: true, reason: "missing_approved_answer" } }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, Ваше семейное положение — Вы в браке, в разводе или не в браке.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000, requestedAmount: 600_000, requestedProgram: "parking" },
      settings: {}, text: "а автомобиль на газу принимаете", attachments: []
    });

    expect(output.result?.leadCardPatch.knowledgeRequest).toEqual({ required: true, reason: "missing_approved_answer" });
    expect(output.result?.leadCardPatch.familyStatus).toBeUndefined();
  });

  it("hands an out-of-stage accident condition to the knowledge agent before resuming the workflow", async () => {
    const facts = { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000, requestedAmount: 600_000, requestedProgram: "parking" };
    const application = { id: "app", facts, contactId: "contact", stage: "COLLECTING_FAMILY_STATUS", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockResolvedValue({ id: "message", author: "client", body: "машина не находу", createdAt: "now" }),
      updateFacts: vi.fn().mockResolvedValue(["accidentNotDrivable"]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn()
    } as any;
    const agent = {
      run: vi.fn().mockResolvedValue({
        result: { ...validResult, reply: "Распознано.", leadCardPatch: { ...facts, accidentNotDrivable: true, knowledgeRequest: { required: true, reason: "missing_approved_answer" } } },
        reply: "Распознано.", model: "workflow-model", promptVersion: "v1"
      }),
      answerWithKnowledge: vi.fn().mockResolvedValue({ reply: "Если автомобиль после ДТП не на ходу, принять его в залог не сможем.", answerFound: true, model: "knowledge-model" })
    } as any;

    const output = await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "c", text: "машина не находу", attachments: [], timestamp: new Date() });

    expect(agent.answerWithKnowledge).toHaveBeenCalledWith(expect.objectContaining({ text: "машина не находу" }));
    expect(output.reply).toContain("принять его в залог не сможем");
    expect(output.reply).not.toContain("семейное положение");
  });

  it("keeps a friendly contextual acknowledgement before the pending visit after an unhandled reaction", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", currentStageResponse: "unrelated", contextualAcknowledgement: { text: "Понимаю, сумма может не подойти." }, leadCardPatch: {}
    }) } }] }) } as any;
    const visitQuestion = "Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?";

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: visitQuestion, createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000, requestedAmount: 200_000, requestedProgram: "parking", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY", documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single" },
      settings: {}, text: "мало", attachments: []
    });

    expect(output.result?.contextualAcknowledgement).toEqual({ text: "Понимаю, сумма может не подойти." });
    expect(output.result?.leadCardPatch).toEqual(expect.objectContaining({
      vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000, requestedAmount: 200_000, requestedProgram: "parking", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY", documentsProvided: true, familyStatus: "single"
    }));
    expect(output.reply).toContain("сумма может не подойти");
    expect(output.reply).toContain("На какой день и время");
    expect(output.result?.leadCardPatch.knowledgeRequest).toBeUndefined();
  });

  it("keeps the server visit question after an explicit refusal to book", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Распознано.",
      currentStageResponse: "unrelated",
      contextualAcknowledgement: { text: "Хорошо, запись пока не будем оформлять." },
      leadCardPatch: {}
    }) } }] }) } as any;
    const visitQuestion = "Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?";

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: visitQuestion, createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000, requestedAmount: 200_000, requestedProgram: "parking", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY", documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single" },
      settings: {}, text: "не хочу запись", attachments: []
    });

    expect(output.reply).toContain("запись пока не будем оформлять");
    expect(output.reply).toContain("На какой день и время");
    expect(output.result?.leadCardPatch.clientPaused).toBeUndefined();
  });

  it("appends the server visit question after a repeated-stage explanation", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Офис работает с понедельника по пятницу.", currentStageResponse: "unrelated", leadCardPatch: {}
    }) } }] }) } as any;
    const visitQuestion = "Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?";

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: visitQuestion, createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000, requestedAmount: 200_000, requestedProgram: "parking", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY", documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single" },
      settings: {}, text: "не понял", attachments: []
    });

    expect(output.reply).toContain("Офис работает с понедельника по пятницу");
    expect(output.reply).toContain("На какой день и время");
  });

  it("explains the active visit stage for the colloquial question а зачем тебе", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", currentStageResponse: "unrelated", leadCardPatch: {}
    }) } }] }) } as any;
    const visitQuestion = "Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?";

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: visitQuestion, createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000, requestedAmount: 200_000, requestedProgram: "parking", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY", documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single" },
      settings: {}, text: "а зачем тебе", attachments: []
    });

    expect(output.reply).toContain("Дата и время нужны");
    expect(output.reply).toContain("На какой день и время");
  });

  it("lets a knowledge request win over contextual acknowledgement prose", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Распознано.",
      currentStageResponse: "unrelated",
      contextualAcknowledgement: { text: "Этот fallback не должен быть показан." },
      leadCardPatch: { knowledgeRequest: { required: true, reason: "missing_approved_answer" } }
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Подскажите, пожалуйста, Ваше семейное положение — Вы в браке, в разводе или не в браке.", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000, requestedAmount: 200_000, requestedProgram: "parking" },
      settings: {}, text: "а wi-fi у вас есть", attachments: []
    });

    expect(output.result?.leadCardPatch.knowledgeRequest).toEqual({ required: true, reason: "missing_approved_answer" });
    expect(output.reply).not.toContain("Этот fallback");
  });

  it("provides a server-built working-day calendar for a visit request", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(validResult) } }] }) } as any;
    const service = new AgentTurnService(client);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T06:00:00.000Z"));
    try {
      await service.run({ messages: [], facts: {}, settings: { timezone: "Asia/Bishkek" }, text: "завтра в 2", attachments: [] });

      const request = client.createChatCompletion.mock.calls[0][0];
      const context = JSON.parse((request.messages[1].content as Array<{ type: string; text?: string }>)[0].text ?? "{}");
      expect(request.messages[0].content).toContain("visitCalendar");
      expect(context.now).toBe("2026-09-11T12:00:00");
      expect(context.timezone).toBe("Asia/Bishkek");
      expect(context.visitCalendar.officeHours).toContain("ПН–ПТ");
      expect(context.visitCalendar.dates).toEqual(expect.arrayContaining([expect.objectContaining({ date: "2026-09-12", weekday: "суббота", working: false })]));
    } finally {
      vi.useRealTimers();
    }
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

  it("repairs malformed attachment shorthand before the focused ID vision pass", async () => {
    const malformed = {
      ...validResult,
      reply: "Документы получены.",
      leadCardPatch: {},
      contextualAcknowledgement: { text: "" },
      attachments: ["id_front", "vehicle_registration_back"],
      dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "collect_documents" }
    };
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn()
        .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(malformed) } }] })
        .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
          fullName: "Смолева Евгения Прокопьевна",
          ownerFullName: null,
          attachments: [
            { attachmentId: "id", type: "id_front", documentTypes: ["id_front"], status: "received" },
            { attachmentId: "sts", type: "vehicle_registration_back", documentTypes: ["vehicle_registration_back"], status: "received" }
          ]
        }) } }] })
    } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Загрузите документы в чат.", createdAt: "now" } as any],
      facts: {} as any,
      settings: {}, text: "", attachments: [
        { id: "id", mimeType: "image/jpeg", contentBase64: "/9j/2Q==" },
        { id: "sts", mimeType: "image/jpeg", contentBase64: "/9j/2Q==" }
      ]
    });

    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(output.result?.contextualAcknowledgement).toBeUndefined();
    expect(output.result?.attachments).toEqual([
      { attachmentId: "id", type: "id_front", status: "received" },
      { attachmentId: "sts", type: "vehicle_registration_back", status: "received" }
    ]);
    expect(output.result?.leadCardPatch.fullName).toBe("Смолева Евгения Прокопьевна");
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

  it.each(["Кто ты?", "Чем занимаешься?", "Зачем ты?", "Ты робот что ли?", "Ты бот?"])("routes identity question %s through knowledge even during a pending stage", async (text) => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Да, я бот Айлин.",
      leadCardPatch: {}
    }) } }] }) } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?", createdAt: "now" } as any],
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000, requestedAmount: 600_000, requestedProgram: "parking", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY", documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single" } as any,
      settings: {}, text, attachments: []
    });

    expect(output.result?.needsKnowledgeLookup).toBe(true);
    expect(output.result?.leadCardPatch.knowledgeRequest).toEqual({ required: true, reason: "missing_approved_answer" });
    expect(output.reply).not.toContain("На какой день и время Вам удобно подъехать?");
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

  it("normalizes a terse parking choice from the server amount-limit offer", async () => {
    const offer = "По программе без изъятия доступно до 200 000 сом. Сумма 520 000 сом по этой программе не проходит. Со стоянкой при текущей стоимости автомобиля доступно до 1 180 000 сом. Могу продолжить либо на сумму до 200 000 сом без изъятия, либо перейти на программу со стоянкой и рассмотреть сумму до 1 180 000 сом.";
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn()
        .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", limitChoice: "undecided", leadCardPatch: {} }) } }] })
        .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ choice: "parking", hasOtherStageAnswer: false, question: null }) } }] })
    } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: offer, createdAt: "now" } as any],
      facts: { requestedProgram: "without_storage", requestedAmount: 520_000 } as any,
      pricing: { minimumLoan: 50_000, clientFacingMaximumField: "publicMax", withoutStorage: { available: true, rawMax: 200_000, publicMax: 200_000 }, parking: { available: true, rawMax: 1_180_000, publicMax: 1_180_000 } },
      settings: {}, text: "стоянка", attachments: []
    });

    expect(JSON.parse(client.createChatCompletion.mock.calls[1][0].messages[1].content)).toMatchObject({ limitOffer: offer, clientReply: "стоянка" });
    expect(output.result?.leadCardPatch).toMatchObject({ requestedProgram: "parking", requestedAmount: 520_000 });
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

  it("answers spouse and guarantor questions from known application facts instead of knowledge", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: {}, knowledgeRequest: { required: true, reason: "missing_approved_answer" }
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG",
        familyStatus: "married"
      } as any,
      settings: {}, text: "а жену брать надо и поручителя?", attachments: []
    });

    expect(output.result?.needsKnowledgeLookup).toBe(false);
    expect(output.reply).toContain("возьмите с собой супругу");
    expect(output.reply).toContain("Да, в Вашем случае нужен поручитель.");
    expect(output.reply).toContain("У Вас есть такой поручитель?");
  });

  it("gives conditional spouse and guarantor guidance when facts are unknown", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult, reply: "Распознано.", leadCardPatch: {}
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [], facts: {}, settings: {}, text: "жену брать надо? поручитель нужен?", attachments: []
    });

    expect(output.result?.needsKnowledgeLookup).toBe(false);
    expect(output.reply).toContain("Если Вы состоите в браке");
    expect(output.reply).toContain("Поручитель нужен только для программы без изъятия");
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

  it.each([
    ["6 октября в 6", "18:00"],
    ["6 октября в 6 вечера", "18:00"],
    ["6 котября в 5", "17:00"]
  ])("treats %s as a visit date and time, not a vehicle price", async (text, visitTime) => {
    const modelResult = {
      ...validResult,
      reply: "Поняла.",
      // Regression: a model can incorrectly label the day/time number as a
      // monetary field. The active server-owned visit stage must reject it.
      hasMoney: true,
      leadCardPatch: { vehicleValue: 6 }
    };
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(modelResult) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?", createdAt: "2026-09-09" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 600_000, requestedProgram: "without_storage",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single"
      } as any,
      settings: {}, text, attachments: []
    });

    expect(output.result?.leadCardPatch).toEqual(expect.objectContaining({
      vehicleValue: 3_000_000,
      visitRequested: true,
      visitDate: "2026-10-06",
      visitTime
    }));
    expect(output.reply).toContain(`в ${visitTime}`);
  });

  it("records a date-only visit reply and asks only for the time", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?", createdAt: "2026-09-09" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 600_000, requestedProgram: "without_storage",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single"
      } as any,
      settings: {}, text: "6 октября", attachments: []
    });

    expect(output.result?.leadCardPatch).toEqual(expect.objectContaining({ visitRequested: true, visitDate: "2026-10-06" }));
    expect(output.result?.leadCardPatch.visitTime).toBeUndefined();
    expect(output.reply).toBe("Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. В какое время Вам удобно подъехать?");
  });

  it("confirms a colloquial visit time once instead of asking for it again", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. В какое время Вам удобно подъехать?", createdAt: "2026-09-09" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 600_000, requestedProgram: "without_storage",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single",
        visitDate: "2026-10-06"
      } as any,
      settings: {}, text: "приеду примерно в 5", attachments: []
    });

    expect(output.result?.leadCardPatch).toEqual(expect.objectContaining({ visitRequested: true, visitDate: "2026-10-06", visitTime: "17:00" }));
    expect(output.reply).toMatch(/записываю Вас на/iu);
    expect(output.reply).toContain("в 17:00");
    expect(output.reply).not.toMatch(/в какое время вам удобно подъехать/iu);
  });

  it("acknowledges an explicitly unknown visit time without storing one", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Поняла.", leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. В какое время Вам удобно подъехать?", createdAt: "2026-09-09" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 600_000, requestedProgram: "without_storage",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single",
        visitDate: "2026-10-06"
      } as any,
      settings: {}, text: "по времени пока не знаю", attachments: []
    });

    expect(output.result?.leadCardPatch.visitTime).toBeUndefined();
    expect(output.reply).toContain("сообщите, пожалуйста, когда время будет известно");
  });

  it("explicitly declines a weekend visit and does not persist its slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T06:00:00.000Z"));
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Распознано.", leadCardPatch: {} }) } }] }) } as any;
    try {
      const output = await new AgentTurnService(client).run({
        messages: [{ author: "ai", body: "Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?", createdAt: "now" } as any],
        facts: {
          vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
          requestedAmount: 600_000, requestedProgram: "without_storage",
          residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
          documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single"
        } as any,
        settings: {}, text: "завтра в 5", attachments: []
      });

      expect(output.result?.leadCardPatch.visitDate).toBeUndefined();
      expect(output.result?.leadCardPatch.visitTime).toBeUndefined();
      expect(output.reply).toContain("12 сентября — суббота");
      expect(output.reply).toContain("только по будням");
    } finally {
      vi.useRealTimers();
    }
  });

  it("repeats the concrete weekend restriction when the client asks again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T06:00:00.000Z"));
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Распознано.", leadCardPatch: {} }) } }] }) } as any;
    try {
      const output = await new AgentTurnService(client).run({
        messages: [{ author: "ai", body: "12 сентября — суббота. Офис работает только по будням, с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой другой рабочий день и время Вам удобно подъехать?", createdAt: "now" } as any],
        facts: {
          vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
          requestedAmount: 600_000, requestedProgram: "without_storage",
          residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
          documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single"
        } as any,
        settings: {}, text: "завтра можно?", attachments: []
      });

      expect(output.reply).toContain("12 сентября — суббота");
      expect(output.reply).toContain("только по будням");
    } finally {
      vi.useRealTimers();
    }
  });

  it("distinguishes the day after tomorrow from tomorrow in availability questions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T06:00:00.000Z"));
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Распознано.", leadCardPatch: {} }) } }] }) } as any;
    try {
      const output = await new AgentTurnService(client).run({
        messages: [], facts: {}, settings: {}, text: "А послезавтра можно?", attachments: []
      });

      expect(output.reply).toContain("13 сентября — воскресенье");
      expect(output.reply).not.toContain("12 сентября — суббота");
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks a direct tomorrow-availability question against the real calendar before visit readiness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T06:00:00.000Z"));
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Если офис ещё открыт — да.", leadCardPatch: {} }) } }] }) } as any;
    try {
      const output = await new AgentTurnService(client).run({
        messages: [], facts: {}, settings: {}, text: "завтра можно?", attachments: []
      });

      expect(output.reply).toContain("12 сентября — суббота");
      expect(output.reply).toContain("только по будням");
      expect(output.reply).not.toContain("Если офис ещё открыт");
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a named weekday visit and confirms its time", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Распознано.", leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 600_000, requestedProgram: "without_storage",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single"
      } as any,
      settings: {}, text: "в понедельник в 3", attachments: []
    });

    expect(output.result?.leadCardPatch).toEqual(expect.objectContaining({ visitRequested: true, visitTime: "15:00" }));
    expect(output.result?.leadCardPatch.visitDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(output.reply).toContain("Записываю Вас на понедельник");
    expect(output.reply).toContain("в 15:00");
  });

  it("combines visit requirements after the maps when spouse consent and a guarantor are required", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Распознано.", leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceRegion: "Ош", residenceCategory: "OTHER_KG", guarantorAvailable: true,
        documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "married", spouseConsentReady: true
      } as any,
      settings: {}, text: "в понедельник в 3", attachments: []
    });

    expect(output.reply).toContain("Google Maps: https://maps.app.goo.gl/9xiWLVvdyRgn3Sx4A");
    expect(output.reply).toContain("Напоминаем Вам, что для оформления займа нужно согласие супруга(и) и требуется поручитель при визите.");
    expect(output.reply).toContain("Есть ли у Вас ещё вопросы?");
    expect(output.reply.indexOf("Google Maps:")).toBeLessThan(output.reply.indexOf("Напоминаем Вам"));
    expect(output.reply.indexOf("Напоминаем Вам")).toBeLessThan(output.reply.indexOf("Есть ли у Вас ещё вопросы?"));
  });

  it("does not add visit requirements for a divorced client", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Распознано.", leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 600_000, requestedProgram: "parking",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        documentsProvided: true, documents: { car_photo: "received" },
        familyStatus: "divorced", vehicleBoughtDuringMarriage: true
      } as any,
      settings: {}, text: "в понедельник в 3", attachments: []
    });

    expect(output.reply).not.toContain("Напоминаем Вам, что для оформления займа");
    expect(output.reply).not.toContain("требуется поручитель при визите");
  });

  it("does not let an unsolicited identity fallback hijack the visit stage", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...validResult, reply: "Я Айлин — виртуальный помощник по вопросам оформления новых займов. Если у Вас уже оформлен займ, пожалуйста, позвоните по телефону +996 502 108 108 или напишите в WhatsApp +996 776 108 108. Наши специалисты проверят информацию по Вашему договору и помогут решить Ваш вопрос.", leadCardPatch: {} }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
        requestedAmount: 600_000, requestedProgram: "without_storage",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single"
      } as any,
      settings: {}, text: "ты сломался?", attachments: []
    });

    expect(output.reply).not.toContain("виртуальный помощник");
    expect(output.reply).toContain("На какой день и время Вам удобно подъехать?");
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

  it("shows conversions for both the vehicle price and loan when one normalizer role is missing", async () => {
    const application = { id: "app", facts: {}, contactId: "contact", stage: "NEW", status: "need_more_data" } as any;
    const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
    const store = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
      addMessage: vi.fn().mockImplementation(async (_conversation: unknown, message: any) => ({ id: message.metadata.externalMessageId, author: message.author, body: message.body, createdAt: "now" })),
      updateFacts: vi.fn().mockResolvedValue([]), saveAgentState: vi.fn(), getApplication: vi.fn().mockResolvedValue(application), getConversation: vi.fn().mockResolvedValue(conversation), addAttachment: vi.fn(), createManagerNotification: vi.fn()
    } as any;
    const agent = {
      normalizeMoney: vi.fn().mockResolvedValue([{ field: "requestedAmount", amount: 10_000, currency: "EUR", confidence: 0.99 }]),
      run: vi.fn().mockResolvedValue({ result: { ...validResult, reply: "Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?", leadCardPatch: {} }, reply: "Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?", model: "interpreter", promptVersion: "v1" })
    } as any;
    const integrations = { convertToSom: vi.fn().mockImplementation(async ({ amount, currency }: { amount: number; currency: string }) => ({ available: true, value: amount * 101, currency, rate: 101, nominal: 1, source: "NBKR", effectiveDate: "2026-09-11" })) } as any;

    const output = await new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any, integrations)
      .receive({ externalMessageId: "m", channel: "web-test", externalContactId: "contact", text: "королла 2022 года стои 30 тыс евро, надо 10 тыс", attachments: [], timestamp: new Date() });

    expect(agent.run).toHaveBeenCalledWith(expect.objectContaining({ facts: expect.objectContaining({ vehicleValue: 3_030_000, vehicleValueSourceCurrency: "EUR", requestedAmount: 1_010_000, requestedAmountSourceCurrency: "EUR" }) }));
    expect(output.reply).toContain("Стоимость автомобиля: 30 000 евро — ориентировочно 3 030 000 сом.");
    expect(output.reply).toContain("Необходимая сумма займа: 10 000 евро — ориентировочно 1 010 000 сом.");
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

  it("removes the first exact repeated sentence of at least three words", () => {
    expect(removeEarlierDuplicateSentences(
      "5 октября — это воскресенье. Для оформления нужно приехать не позднее 18:00. Офис работает с понедельника по пятницу. Для оформления нужно приехать не позднее 18:00. На какой день Вам удобно подъехать?"
    )).toBe(
      "5 октября — это воскресенье. Офис работает с понедельника по пятницу. Для оформления нужно приехать не позднее 18:00. На какой день Вам удобно подъехать?"
    );
  });

  it("removes the earlier sentence when a three-word fragment is repeated", () => {
    expect(removeEarlierDuplicateSentences(
      "Для оформления нужно подъехать не позднее 18:00. Офис работает с понедельника по пятницу. Для оформления нужно приехать не позднее 18:00."
    )).toBe(
      "Офис работает с понедельника по пятницу. Для оформления нужно приехать не позднее 18:00."
    );
  });

  it("keeps sentences without a shared three-word fragment and short duplicates intact", () => {
    expect(removeEarlierDuplicateSentences("Приезжайте до 18:00. Приезжайте до 17:00. Да. Да.")).toBe("Приезжайте до 18:00. Приезжайте до 17:00. Да. Да.");
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

  it("extracts FIO from an image upload even before the document stage is recognized", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
        ...validResult,
        reply: "Распознано.",
        attachments: [],
        dialogueState: { stage: "COLLECTING_VALUE", status: "need_more_data", nextAction: "collect_value" }
      }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
        fullName: "Омронов Омурбек Омурович",
        ownerFullName: null,
        documents: { id_front: false, id_back: false, vehicle_registration_front: false, vehicle_registration_back: false }
      }) } }] })
    } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Могу продолжить либо на меньшую сумму, либо по программе со стоянкой.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000,
        requestedAmount: 700_000, requestedProgram: "without_storage",
        residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      settings: {}, text: "", attachments: [{ id: "id-photo", mimeType: "image/jpeg", contentBase64: "/9j/2Q==" }]
    });

    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(output.result?.leadCardPatch.fullName).toBe("Омронов Омурбек Омурович");
    expect(output.result?.leadCardPatch.documents).toBeUndefined();
  });

  it("uses the focused document extraction to correct a missed FIO from a self-initiated upload", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
        ...validResult,
        reply: "Фотографии получены.",
        // The conversational pass can return a plausible but incomplete OCR
        // value. The focused document pass must replace it with the name read
        // from the ID image.
        leadCardPatch: { fullName: "Абдрахманов Азамат" },
        attachments: [],
        dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "collect_documents" }
      }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
        fullName: "Абдрахманов Азамат Бакытович",
        ownerFullName: null,
        documents: { id_front: true, id_back: false, vehicle_registration_front: false, vehicle_registration_back: false }
      }) } }] })
    } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Какая сумма займа Вам необходима?", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000,
        requestedAmount: 400_000, requestedProgram: "parking",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY"
      } as any,
      settings: {}, text: "", attachments: [{ id: "id-before-request", mimeType: "image/jpeg", contentBase64: "/9j/2Q==" }]
    });

    expect(output.result?.leadCardPatch).toMatchObject({
      fullName: "Абдрахманов Азамат Бакытович",
      documents: { id_front: "received" }
    });
    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("extracts FIO from a document sent in response to the ID collection request", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
        ...validResult,
        reply: "Спасибо, документы получены.",
        leadCardPatch: {},
        attachments: [{ attachmentId: "id-at-stage", type: "id_front", status: "received" }],
        dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "collect_documents" }
      }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
        fullName: "Токтосунова Айпери Кубанычбековна",
        ownerFullName: null,
        documents: { id_front: true, id_back: false, vehicle_registration_front: false, vehicle_registration_back: false }
      }) } }] })
    } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000,
        requestedAmount: 400_000, requestedProgram: "parking",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY"
      } as any,
      settings: {}, text: "", attachments: [{ id: "id-at-stage", mimeType: "image/jpeg", contentBase64: "/9j/2Q==" }]
    });

    expect(output.result?.leadCardPatch).toMatchObject({
      fullName: "Токтосунова Айпери Кубанычбековна",
      documents: { id_front: "received" },
      documentsProvided: true
    });
    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("recognizes combined documents from a generic JPEG upload even when FIO is already known", async () => {
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn()
        .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
          ...validResult, reply: "Спасибо, документы получены.", leadCardPatch: {}, attachments: [{ attachmentId: "combined", type: "unknown", status: "received" }],
          dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "collect_documents" }
        }) } }] })
        .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
          fullName: "Смолева Евгения Прокопьевна",
          ownerFullName: "Смолева Евгения Прокопьевна",
          documents: { id_front: true, id_back: false, vehicle_registration_front: true, vehicle_registration_back: false }
        }) } }] })
    } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Загрузите документы в чат.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 400_000,
        requestedProgram: "parking", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        fullName: "Смолева Евгения Прокопьевна", ownerFullName: "Смолева Евгения Прокопьевна"
      } as any,
      settings: {}, text: "", attachments: [{ id: "combined", fileName: "documents.jpeg", mimeType: "application/octet-stream", contentBase64: "/9j/2Q==" }]
    });

    expect(output.result?.leadCardPatch).toMatchObject({
      fullName: "Смолева Евгения Прокопьевна",
      ownerFullName: "Смолева Евгения Прокопьевна",
      documents: { id_front: "received", vehicle_registration_front: "received" },
      documentsProvided: true
    });
    expect(client.createChatCompletion).toHaveBeenCalledTimes(2);
    expect(client.createChatCompletion.mock.calls[1][0].messages[1].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "image_url", image_url: expect.objectContaining({ url: "data:image/jpeg;base64,/9j/2Q==", detail: "high" }) })
    ]));
  });

  it("makes focused vision authoritative for every uploaded image type and document FIO", async () => {
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn()
        .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
          ...validResult,
          reply: "Фотографии получены.",
          leadCardPatch: {},
          attachments: [
            { attachmentId: "id-front", type: "unknown", status: "received" },
            { attachmentId: "sts-front", type: "unknown", status: "received" },
            { attachmentId: "car", type: "unknown", status: "received" },
            { attachmentId: "other", type: "id_front", status: "received" }
          ],
          dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "collect_documents" }
        }) } }] })
        .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
          fullName: "Абдрахманов Азамат Бакытович",
          ownerFullName: "Смолева Евгения Прокопьевна",
          attachments: [
            { attachmentId: "id-front", type: "id_front", status: "received" },
            { attachmentId: "sts-front", type: "vehicle_registration_front", status: "received" },
            { attachmentId: "car", type: "car", status: "received" },
            { attachmentId: "other", type: "unknown", status: "received" }
          ]
        }) } }] })
    } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Загрузите документы в чат.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 400_000,
        requestedProgram: "parking", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY"
      } as any,
      settings: {}, text: "", attachments: [
        { id: "id-front", mimeType: "image/jpeg", contentBase64: "/9j/2Q==" },
        { id: "sts-front", mimeType: "image/jpeg", contentBase64: "/9j/2Q==" },
        { id: "car", mimeType: "image/jpeg", contentBase64: "/9j/2Q==" },
        { id: "other", mimeType: "image/jpeg", contentBase64: "/9j/2Q==" }
      ]
    });

    expect(output.result?.attachments).toEqual(expect.arrayContaining([
      { attachmentId: "id-front", type: "id_front", status: "received" },
      { attachmentId: "sts-front", type: "vehicle_registration_front", status: "received" },
      { attachmentId: "car", type: "car", status: "received" },
      { attachmentId: "other", type: "unknown", status: "received" }
    ]));
    expect(output.result?.leadCardPatch).toMatchObject({
      fullName: "Абдрахманов Азамат Бакытович",
      ownerFullName: "Смолева Евгения Прокопьевна",
      documents: { id_front: "received", vehicle_registration_front: "received" }
    });
  });

  it("recognizes every document side when each photo contains both ID and STS", async () => {
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn()
        .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
          ...validResult, reply: "Спасибо, документы получены.", leadCardPatch: {},
          attachments: [
            { attachmentId: "photo-one", type: "unknown", status: "received" },
            { attachmentId: "photo-two", type: "unknown", status: "received" }
          ],
          dialogueState: { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "collect_documents" }
        }) } }] })
        .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
          fullName: "Смолева Евгения Прокопьевна",
          ownerFullName: "Смолева Евгения Прокопьевна",
          attachments: [
            { attachmentId: "photo-one", type: "id_back", documentTypes: ["id_back", "vehicle_registration_front"], status: "received" },
            { attachmentId: "photo-two", type: "id_front", documentTypes: ["id_front", "vehicle_registration_back"], status: "received" }
          ]
        }) } }] })
    } as any;

    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Rexton", vehicleYear: 2018, vehicleValue: 1_000_000, requestedAmount: 400_000,
        requestedProgram: "parking", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY"
      } as any,
      settings: {}, text: "", attachments: [
        { id: "photo-one", mimeType: "image/jpeg", contentBase64: "/9j/2Q==" },
        { id: "photo-two", mimeType: "image/jpeg", contentBase64: "/9j/2Q==" }
      ]
    });

    expect(output.result?.leadCardPatch).toMatchObject({
      fullName: "Смолева Евгения Прокопьевна",
      ownerFullName: "Смолева Евгения Прокопьевна",
      documents: {
        id_front: "received", id_back: "received",
        vehicle_registration_front: "received", vehicle_registration_back: "received"
      }
    });
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

  it("closes the car-photo stage after any upload even when the model calls it unknown", async () => {
    const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Спасибо, документы получены. Пожалуйста, отправьте 2–3 фотографии автомобиля.",
      leadCardPatch: {},
      attachments: [{ attachmentId: "camry-photo", type: "unknown", status: "received" }]
    }) } }] }) } as any;
    const output = await new AgentTurnService(client).run({
      messages: [{ author: "ai", body: "Спасибо, документы получены. Пожалуйста, отправьте 2–3 фотографии автомобиля.", createdAt: "now" } as any],
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 400_000,
        requestedProgram: "parking", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY", documentsProvided: true
      } as any,
      settings: {}, text: "", attachments: [{ id: "camry-photo", mimeType: "image/jpeg" }]
    });

    expect(output.result?.leadCardPatch.documents).toMatchObject({ car_photo: "received" });
    expect(output.reply).not.toMatch(/2\s*[–-]\s*3\s+фотограф/iu);
    expect(output.reply).toMatch(/браке/iu);
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
