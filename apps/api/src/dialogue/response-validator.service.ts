import { Injectable } from "@nestjs/common";
import type { DecisionResult } from "@ailyn/business-rules";
import type { ResponsePlanV62 } from "./pipeline.contracts.js";

export interface ResponseValidationResult { passed: boolean; errors: string[]; finalMessage: string; }

@Injectable()
export class ResponseValidatorService {
  validate(input: { message: string; decision: DecisionResult; plan?: ResponsePlanV62 }): ResponseValidationResult {
    const errors: string[] = [];
    const lower = input.message.toLowerCase();
    for (const forbidden of input.decision.forbiddenStatements) if (lower.includes(forbidden.toLowerCase())) errors.push(`forbidden_statement:${forbidden}`);
    if (/[😀-🙏🌀-🗿🚀-🛿🇦-🇿]/u.test(input.message)) errors.push("emoji");
    if (/(^|\s)ты(\s|$)|тебе|твой|твоя|пришли|отправь|укажи/i.test(input.message)) errors.push("informal_you");
    if (/проверка пройдена|условия соблюдены|stage|nextaction|rulesapplied|prompt injection/i.test(input.message)) errors.push("internal_status_leak");
    if (/я\s+ии|я\s+искусственный интеллект|язык(?:овая)? модель|chatgpt|openai/i.test(lower)) errors.push("ai_identity_leak");
    if (input.plan?.validation.requiresPreliminaryDisclaimer && !lower.includes("окончательная сумма определяется после осмотра автомобиля и проверки документов")) errors.push("missing_preliminary_disclaimer");
    for (const answer of input.plan?.answers ?? []) if (answer.exact && !input.message.includes(answer.text)) errors.push(`missing_approved_answer:${answer.key}`);
    for (const question of input.plan?.nextQuestions ?? []) if (!input.message.includes(question)) errors.push("missing_required_next_question");
    if (input.plan?.validation.firstMessage && !input.message.includes(firstContactGreeting)) errors.push("missing_first_contact_greeting");
    if (input.plan && input.decision.nextAction !== "target_reached" && input.decision.nextAction !== "refuse" && input.decision.nextAction !== "redirect_existing_contract" && !(input.plan.nextQuestions.length || input.message.includes("?"))) errors.push("missing_next_action");
    return errors.length ? { passed: false, errors, finalMessage: this.fallback(input.decision, input.plan) } : { passed: true, errors, finalMessage: input.message };
  }

  private fallback(decision: DecisionResult, plan?: ResponsePlanV62): string {
    const approved = plan?.answers.map((answer) => answer.text) ?? [];
    const next = plan?.nextQuestions ?? [];
    const statements = decision.requiredStatements.filter((item) => !item.startsWith("Попросить"));
    return [...approved, ...statements, ...next].filter(Boolean).join(" ") || "Подскажите, пожалуйста, недостающие данные, чтобы продолжить оформление.";
  }
}

const firstContactGreeting = "Здравствуйте! Меня зовут Айлин.";
