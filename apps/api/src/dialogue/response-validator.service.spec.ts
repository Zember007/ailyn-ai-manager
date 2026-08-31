import { describe, expect, it } from "vitest";
import { ResponseValidatorService } from "./response-validator.service.js";

const decision = { status: "need_more_data", stage: "COLLECTING_VALUE", nextAction: "collect_value", requiredFacts: ["vehicleValue"], rulesApplied: [], eligiblePrograms: [], calculatedLimits: {}, requiredStatements: [], forbiddenStatements: [], blockedRules: [] } as any;

describe("ResponseValidatorService", () => {
  it("falls back when an approved KB answer is omitted", () => {
    const service = new ResponseValidatorService();
    const result = service.validate({ message: "Какая сумма Вам необходима?", decision, plan: { answers: [{ key: "office_location", text: "Офис в Бишкеке.", exact: true }], nextQuestions: ["Какая сумма Вам необходима?"], validation: { requiresPreliminaryDisclaimer: false, firstMessage: false } } as any });
    expect(result.passed).toBe(false);
    expect(result.errors).toContain("missing_approved_answer:office_location");
    expect(result.finalMessage).toContain("Офис в Бишкеке.");
  });

  it("rejects invented AI identity and informal address", () => {
    const service = new ResponseValidatorService();
    const result = service.validate({ message: "Я ИИ, пришли мне фото.", decision });
    expect(result.errors).toEqual(expect.arrayContaining(["ai_identity_leak", "informal_you"]));
  });

  it("allows polite imperative forms addressed to Вы", () => {
    const service = new ResponseValidatorService();
    const result = service.validate({ message: "Пришлите, пожалуйста, фото ID.", decision });
    expect(result.errors).not.toContain("informal_you");
  });

  it("rejects a repeated residence question when the fact is already known", () => {
    const service = new ResponseValidatorService();
    const result = service.validate({
      message: "Какая прописка у собственника автомобиля?",
      decision,
      plan: {
        answers: [], nextQuestions: [], knownFactKeys: ["residenceRegion"],
        validation: { requiresPreliminaryDisclaimer: false, firstMessage: false }
      } as any
    });

    expect(result.errors).toContain("repeated_known_fact:residenceRegion");
  });

  it("rejects an incomplete visit confirmation", () => {
    const service = new ResponseValidatorService();
    const result = service.validate({
      message: "Предварительно записала Вас на 17:00.",
      decision: { ...decision, nextAction: "target_reached" },
      plan: {
        answers: [], nextQuestions: [], knownFactKeys: [],
        validation: {
          requiresPreliminaryDisclaimer: false,
          firstMessage: false,
          visitConfirmation: { date: "2026-09-01", time: "17:00", address: "Б. Молодой Гвардии, 22, Бишкек", latestArrivalTime: "18:00" }
        }
      } as any
    });

    expect(result.errors).toContain("incomplete_visit_confirmation");
  });

  it("repairs a refusal that incorrectly continues data collection", () => {
    const service = new ResponseValidatorService();
    const refusalDecision = {
      status: "refuse",
      stage: "REFUSED",
      nextAction: "refuse",
      requiredFacts: [],
      rulesApplied: ["region_10_refusal"],
      eligiblePrograms: [],
      calculatedLimits: {},
      requiredStatements: [],
      forbiddenStatements: [],
      blockedRules: [],
      refusalReason: "По автомобилям с регионом 10 компания займ не оформляет. Если у Вас есть другой автомобиль, можете написать его марку, модель, год выпуска, примерную стоимость и нужную сумму займа. Если другого автомобиля нет, по этой заявке мы, к сожалению, не сможем продолжить оформление."
    } as any;
    const result = service.validate({
      message: "Здравствуйте! По автомобилям с регионом 10 компания займ не оформляет. Подскажите, пожалуйста, модель и год выпуска автомобиля.",
      decision: refusalDecision,
      plan: {
        answers: [{ key: "refusal", text: refusalDecision.refusalReason, exact: true }],
        nextQuestions: [],
        validation: { requiresPreliminaryDisclaimer: false, firstMessage: false },
        knownFactKeys: []
      } as any
    });

    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.finalMessage).toBe(refusalDecision.refusalReason);
  });

  it("deduplicates the refusal text when it is present in both answers and required statements", () => {
    const service = new ResponseValidatorService();
    const refusalReason = "К сожалению, мы не выдаем суммы меньше 50 тыс. сом. Будем рады Вам помочь, если сумма будет нужна более 50 тыс.";
    const refusalDecision = {
      status: "refuse",
      stage: "REFUSED",
      nextAction: "refuse",
      requiredFacts: [],
      rulesApplied: ["minimum_loan"],
      eligiblePrograms: [],
      calculatedLimits: {},
      requiredStatements: [refusalReason],
      forbiddenStatements: [],
      blockedRules: [],
      refusalReason
    } as any;

    const result = service.validate({
      message: `${refusalReason} ${refusalReason} Здравствуйте! Какая сумма займа Вам необходима?`,
      decision: refusalDecision,
      plan: {
        answers: [{ key: "refusal", text: refusalReason, exact: true }],
        nextQuestions: [],
        validation: { requiresPreliminaryDisclaimer: false, firstMessage: false },
        knownFactKeys: ["requestedAmount"]
      } as any
    });

    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.finalMessage).toBe(refusalReason);
  });
});
