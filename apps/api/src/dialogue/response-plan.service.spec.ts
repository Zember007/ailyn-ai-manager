import { describe, expect, it } from "vitest";
import { evaluateApplication } from "@ailyn/business-rules";
import { ResponsePlanService } from "./response-plan.service.js";

describe("ResponsePlanService first contact", () => {
  it("uses the approved full first-contact block when no data is known", () => {
    const service = new ResponsePlanService();
    const plan = service.build({ facts: {}, decision: evaluateApplication({}), isFirstMessage: true, questions: [] });
    expect(plan.nextQuestions).toEqual([
      "Здравствуйте! Меня зовут Айлин. Я менеджер по оформлению новых займов автоломбарда «Молодой». Информируем Вас, что мы не выдаем займ под залог автомобиля с регионом 10.\n\nПодскажите, пожалуйста:\n- модель и год выпуска автомобиля;\n- ориентировочную стоимость автомобиля;\n- какая сумма займа Вам необходима?"
    ]);
  });

  it("does not ask first-contact facts that are already provided", () => {
    const service = new ResponsePlanService();
    const facts = { vehicleMake: "Toyota", vehicleModel: "Camry", vehicleYear: 2021, vehicleValue: 1_500_000, requestedAmount: 500_000 } as const;
    const plan = service.build({ facts, decision: evaluateApplication(facts), isFirstMessage: true, questions: [] });
    expect(plan.nextQuestions[0]).toContain("Здравствуйте! Меня зовут Айлин.");
    expect(plan.nextQuestions[0]).toContain("без изъятия автомобиля");
  });

  it("clarifies a vague residence answer instead of repeating the generic question", () => {
    const service = new ResponsePlanService();
    const facts = {
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2021,
      vehicleValue: 1_500_000,
      requestedAmount: 500_000,
      requestedProgram: "without_storage",
      residenceText: "городская",
      residenceNeedsClarification: true
    } as const;
    const plan = service.build({ facts, decision: evaluateApplication(facts), isFirstMessage: false, questions: [] });

    expect(plan.nextQuestions).toEqual([
      "Уточните, пожалуйста, в каком городе или области прописан собственник автомобиля?"
    ]);
    expect(plan.nextQuestions.join(" ")).not.toContain("Какая прописка у собственника автомобиля?");
  });

  it("builds the complete deterministic visit confirmation block", () => {
    const service = new ResponsePlanService();
    const facts = {
      vehicleMake: "Toyota", vehicleModel: "Camry", vehicleYear: 2021,
      vehicleValue: 1_500_000, requestedAmount: 500_000,
      requestedProgram: "parking", residenceRegion: "Бишкек",
      familyStatus: "single", visitDate: "2026-09-01", visitTime: "17:00"
    } as const;
    const plan = service.build({ facts, decision: evaluateApplication(facts), isFirstMessage: false, questions: [] });
    const confirmation = plan.answers.find((answer) => answer.key === "visit_confirmation")?.text ?? "";

    expect(confirmation).toContain("Предварительно записала Вас");
    expect(confirmation).toContain("менеджер");
    expect(confirmation).toContain("Б. Молодой Гвардии, 22, Бишкек");
    expect(confirmation).toContain("https://go.2gis.com/Y34m4");
    expect(confirmation).toContain("https://maps.app.goo.gl/9xiWLVvdyRgn3Sx4A");
  });

  it("uses a clarification question instead of repeating the same requested-program prompt", () => {
    const service = new ResponsePlanService();
    const facts = {
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2021,
      vehicleValue: 1_500_000,
      requestedAmount: 500_000
    } as const;
    const plan = service.build({
      facts,
      decision: evaluateApplication(facts),
      isFirstMessage: false,
      questions: [],
      recovery: {
        unresolvedFacts: ["requestedProgram"],
        reason: "unrecognized_reply"
      }
    });

    expect(plan.nextQuestions).toEqual([
      "Я не до конца поняла, какая программа Вам нужна. Уточните, пожалуйста, Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?"
    ]);
  });

  it("asks for a clearer document photo when attachment recognition failed", () => {
    const service = new ResponsePlanService();
    const facts = {
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2021,
      vehicleValue: 1_500_000,
      requestedAmount: 500_000,
      requestedProgram: "without_storage",
      residenceRegion: "Бишкек"
    } as const;
    const plan = service.build({
      facts,
      decision: evaluateApplication(facts),
      isFirstMessage: false,
      questions: [],
      recovery: {
        unresolvedFacts: ["id_front", "id_back"],
        reason: "attachment_issue"
      }
    });

    expect(plan.nextQuestions).toEqual([
      "Я не смогла надёжно распознать документы. Если удобно, пришлите, пожалуйста, фото: лицевую сторону ID, обратную сторону ID."
    ]);
  });

  it("adds an FX equivalent note before continuing the normal flow", () => {
    const service = new ResponsePlanService();
    const facts = {
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2010,
      vehicleValue: 1_600_000,
      requestedAmount: 874_500
    } as const;
    const plan = service.build({
      facts,
      decision: evaluateApplication(facts),
      isFirstMessage: false,
      questions: [],
      fxConversions: [{
        role: "requestedAmount",
        sourceText: "10 тыс долларов",
        currency: "USD",
        amount: 10_000,
        somValue: 874_500,
        status: "converted",
        source: "NBKR",
        sourceUrl: "https://www.nbkr.kg/XML/daily.xml",
        effectiveDate: "2026-08-31"
      }]
    });

    expect(plan.answers[0]?.text).toContain("10 тыс долларов");
    expect(plan.answers[0]?.text).toContain("874 500 сом");
  });

  it("uses a targeted clarification when FX conversion is unavailable", () => {
    const service = new ResponsePlanService();
    const facts = {
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2010
    } as const;
    const plan = service.build({
      facts,
      decision: evaluateApplication(facts),
      isFirstMessage: false,
      questions: [],
      recovery: {
        unresolvedFacts: ["requestedAmount"],
        reason: "fx_unavailable"
      }
    });

    expect(plan.nextQuestions).toEqual([
      "Я увидела сумму в иностранной валюте, но не смогла сейчас надёжно перевести её в сомы. Напишите, пожалуйста, нужную сумму займа в сомах."
    ]);
  });
});
