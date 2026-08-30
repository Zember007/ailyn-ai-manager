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
});
