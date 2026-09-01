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

  it("uses natural owner residence wording", () => {
    const service = new ResponsePlanService();
    const facts = {
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2021,
      vehicleValue: 1_500_000,
      requestedAmount: 500_000,
      requestedProgram: "without_storage"
    } as const;
    const plan = service.build({
      facts,
      decision: evaluateApplication(facts),
      isFirstMessage: false,
      questions: []
    });

    expect(plan.nextQuestions).toEqual(["Где прописан собственник автомобиля?"]);
  });

  it("answers a limit objection with deterministic programme alternatives instead of document recovery", () => {
    const service = new ResponsePlanService();
    const facts = {
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2022,
      vehicleValue: 1_749_000,
      requestedAmount: 800_000,
      requestedProgram: "without_storage",
      residenceRegion: "Бишкек",
      residenceCategory: "BISHKEK"
    } as const;
    const plan = service.build({
      facts,
      decision: evaluateApplication(facts),
      isFirstMessage: false,
      questions: [],
      intents: ["limit_objection"]
    });

    expect(plan.answers.map((answer) => answer.text).join(" ")).toContain("без изъятия предварительно возможная сумма — до 600 000 сом");
    expect(plan.answers.map((answer) => answer.text).join(" ")).toContain("со стоянкой предварительно возможная сумма — до 874 500 сом");
    expect(plan.nextQuestions).toEqual([
      "Если Вам нужна сумма больше лимита без изъятия, можем продолжить по программе с постановкой автомобиля на охраняемую стоянку?"
    ]);
    expect(plan.nextQuestions.join(" ")).not.toContain("не смогла надёжно распознать документы");
    expect(plan.nextQuestions.join(" ")).not.toContain("Пришлите, пожалуйста, фото");
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

    expect(plan.answers[0]?.text).toContain("10 000 долларов США");
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

  it("suppresses first-contact onboarding for owner and family special flows", () => {
    const service = new ResponsePlanService();

    const ownerPlan = service.build({
      facts: { borrowerIsOwner: false },
      decision: evaluateApplication({ borrowerIsOwner: false }),
      isFirstMessage: true,
      questions: []
    });
    const familyPlan = service.build({
      facts: { familyStatus: "married" },
      decision: evaluateApplication({ familyStatus: "married" }),
      isFirstMessage: true,
      questions: []
    });

    expect(ownerPlan.nextQuestions.join(" ")).toContain("ФИО собственника");
    expect(ownerPlan.nextQuestions.join(" ")).not.toContain("Меня зовут Айлин");
    expect(familyPlan.answers.map((answer) => answer.text).join(" ")).toContain("нотариального согласия");
    expect(familyPlan.nextQuestions.join(" ")).not.toContain("Меня зовут Айлин");
  });

  it("adds visit and document-decline guidance before the generic flow restarts", () => {
    const service = new ResponsePlanService();

    const declinedDocumentsPlan = service.build({
      facts: {
        vehicleMake: "Toyota",
        vehicleModel: "Camry",
        vehicleYear: 2021,
        vehicleValue: 1_500_000,
        requestedAmount: 500_000,
        requestedProgram: "without_storage",
        residenceRegion: "Бишкек",
        declinedDocuments: true
      },
      decision: evaluateApplication({
        vehicleMake: "Toyota",
        vehicleModel: "Camry",
        vehicleYear: 2021,
        vehicleValue: 1_500_000,
        requestedAmount: 500_000,
        requestedProgram: "without_storage",
        residenceRegion: "Бишкек",
        declinedDocuments: true
      }),
      isFirstMessage: false,
      questions: []
    });

    const scheduledVisitPlan = service.build({
      facts: { visitRequested: true, visitDate: "2026-09-01" },
      decision: evaluateApplication({ visitRequested: true, visitDate: "2026-09-01" }),
      isFirstMessage: true,
      questions: []
    });

    expect(declinedDocumentsPlan.answers.map((answer) => answer.text).join(" ")).toContain("возьмите с собой оригиналы документов");
    expect(scheduledVisitPlan.answers.map((answer) => answer.text).join(" ")).toContain("ПН–ПТ 11:00–19:00");
    expect(scheduledVisitPlan.answers.map((answer) => answer.text).join(" ")).toContain("конкретное время визита");
  });

  it("asks only for the missing side or a clearer image when a partial document is already known", () => {
    const service = new ResponsePlanService();

    const missingBackPlan = service.build({
      facts: { documents: { id_front: "received" } },
      decision: evaluateApplication({ documents: { id_front: "received" } }),
      isFirstMessage: true,
      questions: []
    });
    const poorRegistrationPlan = service.build({
      facts: { documents: { vehicle_registration_front: "poor_quality" } },
      decision: evaluateApplication({ documents: { vehicle_registration_front: "poor_quality" } }),
      isFirstMessage: false,
      questions: []
    });

    expect(missingBackPlan.nextQuestions).toEqual(["Пришлите, пожалуйста, фото обратной стороны ID."]);
    expect(poorRegistrationPlan.nextQuestions).toEqual(["Пришлите, пожалуйста, более качественное фото лицевой стороны свидетельства о регистрации ТС."]);
  });
});
