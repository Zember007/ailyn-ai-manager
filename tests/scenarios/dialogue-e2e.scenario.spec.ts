import { describe, expect, it } from "vitest";
import { evaluateApplication, type ApplicationFacts, type DecisionResult, type DocumentCode } from "@ailyn/business-rules";
import { RouterAiProvider } from "../../apps/api/src/ai/router-ai/router-ai.provider.js";
import type { InboundAttachment } from "../../apps/api/src/ai/ai-provider.interface.js";
import { normalizeTurnFacts } from "../../apps/api/src/dialogue/fact-normalizer.js";
import { ResponsePlanService } from "../../apps/api/src/dialogue/response-plan.service.js";
import { ResponseValidatorService } from "../../apps/api/src/dialogue/response-validator.service.js";

process.env.DATABASE_URL ??= "postgresql://ailyn:ailyn@localhost:5432/ailyn_test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.AI_PROVIDER ??= "routerai";

class DialogueHarness {
  private readonly ai = new RouterAiProvider({ isConfigured: () => false } as any);
  private readonly planner = new ResponsePlanService();
  private readonly validator = new ResponseValidatorService();
  private facts: ApplicationFacts = {};
  private decision: DecisionResult = evaluateApplication(this.facts);
  private assistantMessages: string[] = [];
  private started = false;

  constructor(seedFacts: ApplicationFacts = {}) {
    this.facts = { ...seedFacts };
    this.decision = evaluateApplication(this.facts);
    this.started = Object.keys(seedFacts).length > 0;
  }

  get currentFacts(): ApplicationFacts {
    return this.facts;
  }

  get currentDecision(): DecisionResult {
    return this.decision;
  }

  async send(text: string, attachments: InboundAttachment[] = []): Promise<string> {
    const pendingFacts = this.decision.requiredFacts;
    const extraction = await this.ai.extract({ text, attachments, facts: this.facts, pendingFacts });
    const normalized = normalizeTurnFacts({ text, pendingFacts, currentFacts: this.facts });
    const extractedFacts = extraction.facts.reduce<Partial<ApplicationFacts>>((acc, fact) => {
      (acc as Record<string, unknown>)[fact.key] = fact.value;
      return acc;
    }, {});
    if (normalized.residenceNeedsClarification) {
      delete extractedFacts.residenceRegion;
      delete extractedFacts.residenceCategory;
    }

    this.facts = { ...this.facts, ...extractedFacts, ...normalized, documents: { ...(this.facts.documents ?? {}) } };
    for (const attachment of attachments) {
      const vision = await this.ai.analyzeImage({ attachment });
      const documentKey = vision.type === "car" ? "car_photo" : vision.type === "poor_quality" ? "unknown" : vision.type;
      this.facts.documents = {
        ...(this.facts.documents ?? {}),
        [documentKey]: vision.quality === "poor" ? "poor_quality" : "received"
      };
    }

    this.decision = evaluateApplication(this.facts);
    const plan = this.planner.build({
      facts: this.facts,
      decision: this.decision,
      isFirstMessage: !this.started,
      questions: extraction.questions,
      intents: extraction.intents,
      previousAssistantMessages: this.assistantMessages
    });
    this.started = true;

    const generated = await this.ai.generateResponse({ userText: text, facts: this.facts, decision: this.decision, responsePlan: plan });
    const validation = this.validator.validate({ message: generated.message, decision: this.decision, plan });
    this.assistantMessages.push(validation.finalMessage);
    expect(validation.errors).toEqual([]);
    return validation.finalMessage;
  }

  async uploadDocuments(codes: DocumentCode[]): Promise<string> {
    return this.send("Отправляю документы", codes.map((code) => ({
      id: code,
      fileName: code === "id_front"
        ? "id-front.jpg"
        : code === "id_back"
          ? "id-back.jpg"
          : code === "vehicle_registration_front"
          ? "registration-front.jpg"
          : "registration-back.jpg",
      mimeType: "image/jpeg"
    })));
  }

  async uploadImages(names: string[]): Promise<string> {
    return this.send("Отправляю фото", names.map((name) => ({
      id: name,
      fileName: name,
      mimeType: "image/jpeg"
    })));
  }
}

describe("Dialogue pipeline e2e scenarios", () => {
  it("does not repeat the generic residence question after a vague city residence answer", async () => {
    const dialogue = new DialogueHarness({
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2018,
      vehicleValue: 1_500_000,
      requestedAmount: 500_000,
      requestedProgram: "without_storage"
    });

    const answer = await dialogue.send("Прописка городская");

    expect(dialogue.currentFacts.residenceNeedsClarification).toBe(true);
    expect(answer).toContain("Уточните, пожалуйста, в каком городе или области прописан собственник автомобиля?");
    expect(answer).not.toContain("Какая прописка у собственника автомобиля?");
  });

  it("calculates the approved Bishkek limit and moves to document collection", async () => {
    const dialogue = new DialogueHarness();

    await dialogue.send("Toyota Camry 2018, машина стоит 1.5 млн, хочу 500к");
    await dialogue.send("без изъятия");
    const answer = await dialogue.send("Бишкек");

    expect(dialogue.currentDecision.calculatedLimits.withoutStorage).toBe(600_000);
    expect(answer).toContain("Предварительно возможная сумма — до 600 000 сом");
    expect(answer).toContain("Пришлите, пожалуйста, фото");
  });

  it("applies the parking cap and exact parking boundary", async () => {
    const dialogue = new DialogueHarness({
      vehicleMake: "Toyota",
      vehicleModel: "Land Cruiser",
      vehicleYear: 2020,
      vehicleValue: 5_000_000,
      requestedAmount: 3_000_000,
      residenceRegion: "Бишкек",
      residenceCategory: "BISHKEK"
    });

    const answer = await dialogue.send("на стоянку");

    expect(dialogue.currentDecision.calculatedLimits.parking).toBe(2_000_000);
    expect(answer).toContain("Предварительно возможная сумма — до 2 000 000 сом");
  });

  it("refuses vehicle registration region 10 deterministically", async () => {
    const dialogue = new DialogueHarness();

    const answer = await dialogue.send("Меня зовут Иванов Иван Иванович, телефон +996 555 123 456. Toyota Camry 2018, регион 10, стоит 1 млн, хочу 300к");

    expect(dialogue.currentDecision.status).toBe("refuse");
    expect(answer).toContain("По автомобилям с регионом 10 компания займ не оформляет.");
    expect(answer).toContain("Если у Вас есть другой автомобиль");
    expect(answer).not.toContain("Подскажите, пожалуйста, модель и год выпуска автомобиля.");
  });

  it("refuses unsupported motorcycle collateral", async () => {
    const dialogue = new DialogueHarness();

    const answer = await dialogue.send("Меня зовут Иванов Иван Иванович, телефон +996 555 123 456. Хочу займ под мото, стоит 300к");

    expect(dialogue.currentDecision.status).toBe("refuse");
    expect(answer).toContain("только под легковые автомобили и минивэны");
  });

  it("requires a guarantor for other-region without-storage applications", async () => {
    const dialogue = new DialogueHarness({
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2019,
      vehicleValue: 1_500_000,
      requestedAmount: 500_000,
      requestedProgram: "without_storage"
    });

    const answer = await dialogue.send("Ош");

    expect(dialogue.currentDecision.nextAction).toBe("check_guarantor");
    expect(dialogue.currentDecision.blockedRules).toContain("SPEC_CONFLICT_C1");
    expect(answer).toContain("нужен поручитель от 25 лет");
  });

  it("offers parking when an other-region borrower has no guarantor", async () => {
    const dialogue = new DialogueHarness({
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2019,
      vehicleValue: 1_500_000,
      requestedAmount: 500_000,
      requestedProgram: "without_storage",
      residenceRegion: "Ош",
      residenceCategory: "OTHER_KG"
    });

    const answer = await dialogue.send("поручителя нет");

    expect(dialogue.currentDecision.eligiblePrograms).toEqual(["parking"]);
    expect(answer).toContain("Без поручителя оформление без изъятия продолжить нельзя");
    expect(answer).toContain("Хотите продолжить по программе с постановкой автомобиля на охраняемую стоянку?");
  });

  it("asks only for missing document sides after partial upload", async () => {
    const dialogue = new DialogueHarness({
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2018,
      vehicleValue: 1_500_000,
      requestedAmount: 500_000,
      requestedProgram: "without_storage",
      residenceRegion: "Бишкек",
      residenceCategory: "BISHKEK"
    });

    const answer = await dialogue.uploadDocuments(["id_front", "vehicle_registration_front"]);

    expect(answer).toContain("обратной стороны ID");
    expect(answer).toContain("обратной стороны свидетельства о регистрации ТС");
    expect(answer).not.toContain("лицевой стороны ID");
  });

  it("continues with family status when the client declines document photos", async () => {
    const dialogue = new DialogueHarness({
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2018,
      vehicleValue: 1_500_000,
      requestedAmount: 500_000,
      requestedProgram: "without_storage",
      residenceRegion: "Бишкек",
      residenceCategory: "BISHKEK"
    });

    const answer = await dialogue.send("Не могу сейчас отправить фото документов");

    expect(dialogue.currentDecision.nextAction).toBe("collect_family_status");
    expect(answer).toContain("собственник автомобиля состоит в браке");
  });

  it("blocks visit scheduling until married owner has notarized spouse consent", async () => {
    const dialogue = new DialogueHarness({
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2018,
      vehicleValue: 1_500_000,
      requestedAmount: 500_000,
      requestedProgram: "without_storage",
      residenceRegion: "Бишкек",
      residenceCategory: "BISHKEK",
      declinedDocuments: true,
      visitRequested: true,
      visitDate: "2026-08-31",
      visitTime: "15:00"
    });

    const answer = await dialogue.send("Я женат, согласие не готово");

    expect(dialogue.currentDecision.nextAction).toBe("collect_family_status");
    expect(answer).toContain("Для визита потребуется оригинал нотариального согласия");
    expect(answer).toContain("когда нотариальное согласие будет готово");
  });

  it("confirms an admissible visit with address, maps, and manager confirmation", async () => {
    const dialogue = new DialogueHarness({
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2018,
      vehicleValue: 1_500_000,
      requestedAmount: 500_000,
      requestedProgram: "without_storage",
      residenceRegion: "Бишкек",
      residenceCategory: "BISHKEK",
      declinedDocuments: true,
      familyStatus: "single"
    });

    const answer = await dialogue.send("Хочу приехать 31.08.2026 в 15:00");

    expect(dialogue.currentDecision.status).toBe("target_reached");
    expect(answer).toContain("Предварительно записала Вас");
    expect(answer).toContain("Б. Молодой Гвардии, 22, Бишкек");
    expect(answer).toContain("https://go.2gis.com/Y34m4");
    expect(answer).toContain("https://maps.app.goo.gl/9xiWLVvdyRgn3Sx4A");
  });

  it("redirects payment questions on existing contracts to human contacts", async () => {
    const dialogue = new DialogueHarness();

    const answer = await dialogue.send("Я оплатил, проверьте оплату по действующему договору");

    expect(dialogue.currentDecision.status).toBe("redirect_existing_contract");
    expect(answer).toContain("+996 502 108 108");
    expect(answer).toContain("+996 776 108 108");
  });

  it("completes a full dialogue and leaves the lead-card facts populated after image uploads", async () => {
    const dialogue = new DialogueHarness();

    await dialogue.send("Меня зовут Иванов Иван Иванович, телефон +996 555 123 456. Toyota Camry 2018, машина стоит 1.5 млн, хочу 500к");
    await dialogue.send("без изъятия");
    const clarification = await dialogue.send("Прописка городская");
    await dialogue.send("Бишкек");
    await dialogue.uploadImages([
      "id-front.jpg",
      "id-back.jpg",
      "registration-front.jpg",
      "registration-back.jpg",
      "car-photo.jpg"
    ]);
    await dialogue.send("Не женат");
    const finalAnswer = await dialogue.send("Хочу приехать 01.09.2026 в 15:00");

    expect(clarification).toContain("Уточните, пожалуйста, в каком городе или области прописан собственник автомобиля?");
    expect(dialogue.currentDecision.status).toBe("target_reached");
    expect(dialogue.currentFacts.fullName).toBe("Иванов Иван Иванович");
    expect(dialogue.currentFacts.phone).toBe("+996555123456");
    expect(dialogue.currentFacts.residenceRegion).toBe("Бишкек");
    expect(dialogue.currentFacts.familyStatus).toBe("single");
    expect(dialogue.currentFacts.visitDate).toBe("2026-09-01");
    expect(dialogue.currentFacts.visitTime).toBe("15:00");
    expect(dialogue.currentFacts.documents).toEqual(expect.objectContaining({
      id_front: "received",
      id_back: "received",
      vehicle_registration_front: "received",
      vehicle_registration_back: "received",
      car_photo: "received"
    }));
    expect(finalAnswer).toContain("Предварительно записала Вас");
  });
});
