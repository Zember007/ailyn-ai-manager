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
    if (/(^|\s)ты(\s|$)|(?:^|[\s,.!?])(?:тебе|твой|твоя|пришли|отправь|укажи)(?:$|[\s,.!?])/i.test(input.message)) errors.push("informal_you");
    if (/проверка пройдена|условия соблюдены|stage|nextaction|rulesapplied|prompt injection/i.test(input.message)) errors.push("internal_status_leak");
    if (/я\s+ии|я\s+искусственный интеллект|язык(?:овая)? модель|chatgpt|openai/i.test(lower)) errors.push("ai_identity_leak");
    if (input.plan?.knownFactKeys?.includes("residenceRegion") && /какая\s+прописка[^?]{0,80}\?/i.test(input.message)) errors.push("repeated_known_fact:residenceRegion");
    if (input.plan?.knownFactKeys?.includes("requestedAmount") && /какая\s+сумма\s+займа[^?]{0,80}\?/i.test(input.message)) errors.push("repeated_known_fact:requestedAmount");
    if (input.plan?.knownFactKeys?.includes("vehicleValue") && /какая\s+(?:ориентировочная\s+)?стоимость[^?]{0,80}\?/i.test(input.message)) errors.push("repeated_known_fact:vehicleValue");
    if (input.plan?.knownFactKeys?.includes("requestedProgram") && /вас\s+интересует\s+займ\s+без\s+изъятия[^?]{0,160}\?/i.test(input.message)) errors.push("repeated_known_fact:requestedProgram");
    if (/(?:какая|ваша|у\s+собственника)[^.!?]{0,40}регистрац/i.test(input.message)) errors.push("residence_registration_wording");
    if (input.plan?.validation.requiresPreliminaryDisclaimer && !lower.includes("окончательная сумма определяется после осмотра автомобиля и проверки документов")) errors.push("missing_preliminary_disclaimer");
    for (const answer of input.plan?.answers ?? []) if (answer.exact && !input.message.includes(answer.text)) errors.push(`missing_approved_answer:${answer.key}`);
    for (const question of input.plan?.nextQuestions ?? []) if (!input.message.includes(question)) errors.push("missing_required_next_question");
    if (
      input.plan?.validation.firstMessage &&
      !["refuse", "redirect_existing_contract", "pause", "on_the_way", "arrived"].includes(input.decision.nextAction) &&
      !input.message.includes(firstContactGreeting)
    ) errors.push("missing_first_contact_greeting");
    if (input.plan?.validation.visitConfirmation) {
      const requiredVisitParts = [
        "Предварительно записала Вас",
        "Для подтверждения времени визита с Вами свяжется менеджер",
        "Б. Молодой Гвардии, 22, Бишкек",
        "https://go.2gis.com/Y34m4",
        "https://maps.app.goo.gl/9xiWLVvdyRgn3Sx4A"
      ];
      if (!requiredVisitParts.every((part) => input.message.includes(part))) errors.push("incomplete_visit_confirmation");
    }
    if (input.plan && !["target_reached", "refuse", "redirect_existing_contract", "pause", "on_the_way", "arrived"].includes(input.decision.nextAction) && !(input.plan.nextQuestions.length || input.message.includes("?"))) errors.push("missing_next_action");
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
