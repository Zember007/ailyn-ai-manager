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
});
