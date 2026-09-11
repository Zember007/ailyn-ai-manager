import { describe, expect, it } from "vitest";
import { isMaximumLoanKnowledgeQuestion, prioritizedKnowledgeForQuestion, selectRelevantDocumentation } from "./documentation-retrieval.js";

describe("selectRelevantDocumentation", () => {
  it("always supplies only the compact approved-answer core", () => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: "здравствуйте", messages: [] });

    expect(result.commonKnowledge.length).toBeGreaterThan(0);
    expect(result.commonKnowledge.length).toBeLessThan(10);
    expect(result.commonKnowledge.some((chunk) => chunk.section === "5.1")).toBe(true);
    expect(result.commonKnowledge.some((chunk) => chunk.section === "5.25")).toBe(true);
    expect(result.stageInstructions.some((instruction) => instruction.includes("марку отдельно не спрашивайте"))).toBe(true);
  });

  it("includes approved duration FAQ for a general timing question", () => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: "а долго оформлять", messages: [] });
    expect([...result.commonKnowledge, ...result.knowledge].some((chunk) => /5 минут|около 1 часа/u.test(chunk.text))).toBe(true);
  });

  it("maps a misspelled duration question to the approved one-hour answer", () => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: "Сколько длится оформлениу", messages: [] });

    expect(result.mandatoryAnswer).toBe("Обычно оформление занимает 1 час. Присланные Вами документы помогут нам сократить время выдачи денег.");
  });

  it("includes the exact approved redirect for an existing contract", () => {
    const result = selectRelevantDocumentation({ facts: { existingContractQuestion: true }, currentMessage: "сколько я должен по текущему займу", messages: [] });
    expect(result.commonKnowledge.some((chunk) => chunk.text.includes("Я Айлин — виртуальный помощник"))).toBe(true);
  });

  it("supplies the approved programme-specific interest-rate answer only for a direct rate question", () => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: "какая процентная ставка", messages: [] });

    const rateAnswer = result.commonKnowledge.find((chunk) => chunk.section === "5.23.1")?.text ?? "";
    expect(rateAnswer).toContain("ставка 2,4% в месяц");
    expect(rateAnswer).toContain("ставка определяется индивидуально после осмотра");
    expect(rateAnswer).toContain("только к ставке");
    expect(rateAnswer).toContain("до переданного сервером `publicMax`");
    expect(rateAnswer).not.toContain("сумма до 2 000 000 сом");

    const maximum = selectRelevantDocumentation({ facts: {}, currentMessage: "сколько денег по максимуму дадите", messages: [] });
    expect(maximum.commonKnowledge.some((chunk) => chunk.section === "5.23.1")).toBe(false);
  });

  it.each([
    "а проценты какие и сумма максимальная",
    "сколько денег дадите",
    "какой лимит можно получить",
    "до какой суммы дадите"
  ])("routes a maximum-loan wording to the placeholder FAQ: %s", (currentMessage) => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage, messages: [] });

    expect(isMaximumLoanKnowledgeQuestion(currentMessage)).toBe(true);
    expect(result.knowledge.some((chunk) => chunk.key === "faq_maximum_loan_range")).toBe(true);
  });

  it("does not mistake a stated vehicle value for a maximum-loan question", () => {
    expect(isMaximumLoanKnowledgeQuestion("машина стоит 3 млн сом")).toBe(false);
  });

  it("finds the approved GPS answer during a targeted knowledge lookup", () => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: "а вы датчики на машину ставите", messages: [], includeCrossStageMatches: true });
    const gps = result.knowledge.find((chunk) => "approvedQuestion" in chunk && chunk.approvedQuestion?.includes("GPS/трекер"));
    expect(gps).toMatchObject({
      responsePolicy: "verbatim",
      approvedAnswer: "Это зависит от суммы займа и состояния автомобиля. Точно ответить сможем после осмотра автомобиля."
    });
  });

  it("marks the approved card-disbursement answer as verbatim", () => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: "Можно деньги на карту?", messages: [], includeCrossStageMatches: true });
    expect(result.knowledge.find((chunk) => "approvedQuestion" in chunk && chunk.approvedQuestion?.includes("банковскую карту"))).toMatchObject({
      responsePolicy: "verbatim",
      approvedAnswer: "К сожалению только наличными"
    });
  });

  it("ranks an approved question-answer pair above neighbouring FAQ context", () => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: "Можно деньги на карту?", messages: [] });
    expect(result.knowledge[0]).toMatchObject({
      responsePolicy: "verbatim",
      approvedAnswer: "К сожалению только наличными"
    });
  });

  it("retrieves the approved temporary-registration FAQ for a semantic wording", () => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: "Можно оформить займ по временной регистрации?", messages: [] });
    expect(result.knowledge[0]).toMatchObject({
      approvedAnswer: "Да, оформление по временной прописке возможно."
    });
  });

  it("retrieves the approved GPS FAQ for the colloquial word датчики", () => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: "датчики ставите?", messages: [] });
    expect(result.knowledge[0]).toMatchObject({
      key: "faq_gps_requirement",
      approvedAnswer: "Это зависит от суммы займа и состояния автомобиля. Точно ответить сможем после осмотра автомобиля."
    });
  });

  it("prioritizes existing-loan support over the GPS-installation FAQ for a malfunction report", () => {
    const currentMessage = "У меня датчик не работает";
    const result = selectRelevantDocumentation({ facts: {}, currentMessage, messages: [] });
    const packet = prioritizedKnowledgeForQuestion({ facts: {}, currentMessage, messages: [] });

    expect(result.mandatoryAnswer).toContain("Если у Вас уже оформлен займ");
    expect(packet[0]).toMatchObject({ section: "3.18" });
    expect(packet.some((chunk) => chunk.key === "faq_gps_requirement")).toBe(false);
  });

  it("makes the exact approved air-conditioner answer mandatory", () => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: "Есть кондиционер?", messages: [] });

    expect(result.mandatoryAnswer).toBe("Да.");
    expect(result.knowledge[0]).toMatchObject({
      approvedQuestion: "Есть кондиционер?",
      approvedAnswer: "Да."
    });
  });

  it("prefers the exact currency-exchange answer over the combined nearby-services FAQ", () => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: "Есть обмен валют?", messages: [] });

    expect(result.mandatoryAnswer).toBe("Да, есть недалеко от нас. Примерно 5–10 минут пешком.");
  });

  it.each([
    ["где у вас стоянка", "Парковка находится недалеко от нашего офиса и находится под охраной. Точный адрес парковки не сообщается."],
    ["авто в кредите", "К сожалению, мы не сможем оформить займ, если автомобиль в кредите."],
    ["А вещи надо забрать из авто?", "Вещи в автомобиле можно оставить или забрать — на Ваше усмотрение."],
    ["А по доверенности можно займ оформить?", "Нет, оформить займ по доверенности нельзя: собственник автомобиля должен лично присутствовать при осмотре и выдаче займа."],
    ["Можно оформить нотариальную доверенность на сотрудника?", "Да, оформление нотариальной доверенности может быть одним из условий выдачи займа. Более подробно порядок оформления и условия Вы сможете уточнить во время визита в офис у менеджера."],
    ["а куда ехать", "Наш офис находится на бульваре Молодой Гвардии, 22, в Бишкеке. Мы работаем с понедельника по пятницу с 11:00 до 19:00. Вы можете приехать в любое удобное время в рамках рабочего графика.\nhttps://go.2gis.com/Y34m4\nhttps://maps.app.goo.gl/9xiWLVvdyRgn3Sx4A"]
  ])("makes the approved answer mandatory for %s", (question, answer) => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: question, messages: [] });
    expect(result.mandatoryAnswer).toBe(answer);
  });

  it("puts the matching FAQ before section 3.18 and other knowledge-model context", () => {
    const packet = prioritizedKnowledgeForQuestion({ facts: {}, currentMessage: "Авто в кредите", messages: [] });

    expect(packet[0]).toMatchObject({ key: "faq_vehicle_in_credit" });
    expect(packet.findIndex((chunk) => chunk.section === "3.18")).toBeGreaterThan(0);
  });

  it("prioritizes spouse ownership clarification over the generic proxy-loan FAQ", () => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: "А доверенносить на жену?", messages: [] });
    const packet = prioritizedKnowledgeForQuestion({ facts: {}, currentMessage: "А доверенносить на жену?", messages: [] });

    expect(result.mandatoryAnswer).toBeUndefined();
    expect(packet.some((chunk) => chunk.section === "4.27")).toBe(true);
    expect(packet.some((chunk) => chunk.key === "faq_power_of_attorney")).toBe(false);
  });

  it("maps an ownership disclosure with typos to the approved UNA-registration answer", () => {
    const currentMessage = "А у меня мошина но оформлена не наменя";
    const result = selectRelevantDocumentation({ facts: {}, currentMessage, messages: [] });
    const packet = prioritizedKnowledgeForQuestion({ facts: {}, currentMessage, messages: [] });

    expect(result.mandatoryAnswer).toBe("Да. Для оформления займа автомобиль должен быть зарегистрирован в УНА на человека, который обращается за займом.");
    expect(result.knowledge).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "docx_0105",
        text: expect.stringContaining("автомобиль должен быть зарегистрирован в УНА")
      })
    ]));
    expect(packet[0]).toMatchObject({ key: "docx_0105" });
  });

  it("retrieves the free-evaluation answer instead of an unrelated application chunk", () => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: "Нужно платить за оценку автомобиля?", messages: [] });
    expect(result.mandatoryAnswer).toBe("Нет, оценка автомобиля бесплатна.");
    expect(result.knowledge[0]).toMatchObject({
      approvedAnswer: "Нет, оценка автомобиля бесплатна."
    });
  });

  it("retrieves a direct question-answer pair from the DOCX FAQ", () => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: "Можно приехать на такси?", messages: [] });
    expect(result.mandatoryAnswer).toBe("Да, конечно.");
    expect(result.knowledge[0]).toMatchObject({
      responsePolicy: "verbatim",
      approvedQuestion: "Можно приехать на такси?",
      approvedAnswer: "Да, конечно."
    });
  });

  it("retrieves the guarantor conditions as a direct DOCX FAQ answer", () => {
    const result = selectRelevantDocumentation({
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000,
        requestedProgram: "without_storage", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG"
      } as any,
      currentMessage: "какой поручитель",
      messages: []
    });

    expect(result.mandatoryAnswer).toContain("только по программе без изъятия автомобиля");
    expect(result.mandatoryAnswer).toContain("за пределами Бишкека и Чуйской области");
    expect(result.mandatoryAnswer).toContain("По программе со стоянкой поручитель не требуется");
    expect(result.knowledge[0]).toMatchObject({
      retrievalQuestion: "Какой поручитель?"
    });
  });

  it("does not force a previous FAQ answer onto an unrelated current question", () => {
    const result = selectRelevantDocumentation({
      facts: {},
      currentMessage: "А у вас есть пистолеты?",
      messages: [{ author: "client", body: "Ок а в офисе есть зона ожидания?", createdAt: "now" } as any, { author: "ai", body: "Да, у нас есть зона ожидания, вода и кулер для посетителей.", createdAt: "now" } as any]
    });

    expect(result.mandatoryAnswer).toBeUndefined();
  });

  it("keeps every relevant FAQ in a multi-question batch", () => {
    const result = selectRelevantDocumentation({
      facts: {},
      currentMessage: "датчик\nи сколько мне по максимуму можно получить под мою машину\nа вы датчики на машину ставите\nа доверенность надо оформлять",
      messages: []
    });
    expect(result.knowledge).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "faq_gps_requirement" }),
      expect.objectContaining({ key: "faq_power_of_attorney" })
    ]));
  });

  it("does not preload future family or guarantor branches into an application turn", () => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: "камри 2009 стоит 2 млн сом", messages: [] });

    expect(result.stages).toEqual(["application"]);
    expect(result.knowledge.some((chunk) => chunk.primaryStage === "family_status" || chunk.primaryStage === "guarantor")).toBe(false);
    const instruction = result.stageInstructions.find((item) => item.includes("марку отдельно не спрашивайте")) ?? "";
    expect(instruction).toContain("марку отдельно не спрашивайте");
    expect(instruction).toContain("До клиентского лимита");
  });

  it("supplies the approved locality reference during residence collection", () => {
    const result = selectRelevantDocumentation({
      facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "without_storage" } as any,
      currentMessage: "я из Токмока",
      messages: []
    });

    const instruction = result.stageInstructions.find((item) => item.includes("ЭТАП ПРОПИСКИ")) ?? "";
    expect(instruction).toContain("КАТЕГОРИЯ BISHKEK_CHUY");
    expect(instruction).toContain("Токмок, Кант, Кара-Балта");
    expect(instruction).toContain("Ошская, Джалал-Абадская, Иссык-Кульская");
    expect(instruction).toContain("официальный справочник СОАТЕ");
  });

  it("retrieves currency guidance when the client provides foreign-currency prices", () => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: "камри стоит 20 тысяч долларов, надо 10", messages: [] });

    expect(result.knowledge.some((chunk) => /^13\.1/u.test(chunk.section))).toBe(true);
    expect(result.stages).toContain("application");
  });

  it("retrieves family and guarantor guidance for a non-Bishkek without-storage application", () => {
    const result = selectRelevantDocumentation({
      facts: {
        vehicleMake: "Toyota", vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000,
        requestedProgram: "without_storage", residenceRegion: "Нарын", residenceCategory: "OTHER_KG",
        documents: { id_front: "received", id_back: "received", vehicle_registration_front: "received", vehicle_registration_back: "received" },
        declinedCarPhoto: true
      } as any,
      currentMessage: "я в браке, поручитель есть",
      messages: []
    });

    expect(result.stages).toEqual(expect.arrayContaining(["family_status", "guarantor"]));
    expect(result.knowledge.some((chunk) => chunk.section === "5.15")).toBe(true);
    expect(result.knowledge.some((chunk) => chunk.section === "5.16")).toBe(true);
    expect(result.stageInstructions).toHaveLength(2);
    expect(result.stageInstructions.some((instruction) => instruction.includes("разрешено только в первом объяснении условия"))).toBe(true);
    expect(result.stageInstructions.some((instruction) => instruction.includes("Возьмите с собой супругу (супруга) для нотариального оформления согласия"))).toBe(true);
  });

  it("requires a guarantor for an OTHER_KG without-storage card", () => {
    const result = selectRelevantDocumentation({
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000,
        requestedProgram: "without_storage", residenceRegion: "Иссык-Кульская область", residenceCategory: "OTHER_KG"
      } as any,
      currentMessage: "со стоянкой",
      messages: []
    });

    expect(result.stages[0]).toBe("guarantor");
    expect(result.stageInstructions.some((instruction) => instruction.includes("Сначала рассчитайте и сообщите предварительный лимит без изъятия"))).toBe(true);
    expect(result.stageInstructions.some((instruction) => instruction.includes("вопрос поручителя пока ЗАПРЕЩЁН"))).toBe(true);
    expect(result.stageInstructions.some((instruction) => instruction.includes("ЖЁСТКОЕ ПРАВИЛО"))).toBe(true);
  });

  it("does not activate or supply guarantor guidance for a Chuy without-storage card", () => {
    const result = selectRelevantDocumentation({
      facts: {
        vehicleMake: "Toyota", vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000,
        requestedProgram: "without_storage", residenceRegion: "Чуйская область", residenceCategory: "BISHKEK_CHUY"
      } as any,
      currentMessage: "прописка Чуйская область",
      messages: []
    });

    expect(result.stages).not.toContain("guarantor");
    expect(result.stageInstructions.some((instruction) => instruction.includes("ЭТАП ПОРУЧИТЕЛЯ"))).toBe(false);
    expect(result.knowledge.some((chunk) => /^5\.16/u.test(chunk.section))).toBe(false);
  });

  it("closes the car-photo stage after a client declines photos", () => {
    const result = selectRelevantDocumentation({
      facts: {
        vehicleMake: "Toyota", vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000,
        requestedProgram: "parking", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        documentsProvided: true, declinedCarPhoto: true
      } as any,
      currentMessage: "нет",
      messages: []
    });

    expect(result.stages).not.toContain("vehicle_photos");
  });

  it("brings back application guidance when a client changes an earlier price", () => {
    const result = selectRelevantDocumentation({
      facts: { vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "parking" } as any,
      currentMessage: "машина всё-таки стоит 25 тысяч долларов",
      messages: []
    });

    expect(result.stages).toContain("application");
    expect(result.knowledge.some((chunk) => /стоимост|валют|курс/u.test(chunk.text))).toBe(true);
  });

  it("brings back programme-limit guidance when the client switches to parking", () => {
    const result = selectRelevantDocumentation({
      facts: {
        vehicleModel: "Camry", vehicleYear: 2002, vehicleValue: 2_623_464, requestedAmount: 787_039,
        requestedProgram: "without_storage", residenceRegion: "Иссык-Кульская область", residenceCategory: "OTHER_KG"
      } as any,
      currentMessage: "стоянка тогда",
      messages: []
    });

    expect(result.stages).toContain("application");
    expect(result.stageInstructions.some((instruction) => instruction.includes("пересчитайте и сообщите новый preliminaryLimit"))).toBe(true);
  });

  it("retrieves vehicle-photo guidance immediately after all required documents arrive", () => {
    const result = selectRelevantDocumentation({
      facts: {
        vehicleMake: "Toyota", vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000,
        requestedProgram: "parking", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        documents: { id_front: "received", id_back: "received", vehicle_registration_front: "received", vehicle_registration_back: "received" }
      } as any,
      currentMessage: "отправляю документы",
      messages: []
    });

    expect(result.stages).toContain("vehicle_photos");
    expect(result.knowledge.some((chunk) => chunk.primaryStage === "vehicle_photos")).toBe(true);
    expect(result.stageInstructions.some((instruction) => instruction.includes("ЭТАП ФОТОГРАФИЙ АВТОМОБИЛЯ"))).toBe(true);
  });

  it("supplies multi-document and electronic-document recognition guidance during document collection", () => {
    const result = selectRelevantDocumentation({ facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "parking", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" } as any, currentMessage: "отправляю ID и СТС", messages: [] });

    const instruction = result.stageInstructions.find((item) => item.includes("ЭТАП ДОКУМЕНТОВ")) ?? "";
    expect(instruction).toContain("несколько документов на одном фото");
    expect(instruction).toContain("Электронный документ/скриншот Tunduk");
    expect(instruction).toContain("отметьте все уверенно различимые части");
  });

  it("continues past document collection after any client file was supplied", () => {
    const result = selectRelevantDocumentation({
      facts: {
        vehicleMake: "Toyota", vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000,
        requestedProgram: "parking", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        documentsProvided: true,
        documents: { unknown: "received" }
      } as any,
      currentMessage: "вот документы",
      messages: []
    });

    expect(result.stages[0]).toBe("vehicle_photos");
    expect(result.stageInstructions.some((instruction) => instruction.includes("этап документов окончательно закрыт"))).toBe(true);
  });
});
