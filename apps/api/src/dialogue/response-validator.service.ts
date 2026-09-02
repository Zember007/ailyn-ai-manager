import { Injectable } from "@nestjs/common";
import type { DecisionResult } from "@ailyn/business-rules";
import type { ResponsePlanV62 } from "./pipeline.contracts.js";

export interface ResponseValidationResult { passed: boolean; errors: string[]; finalMessage: string; }

@Injectable()
export class ResponseValidatorService {
  validate(input: { message: string; decision: DecisionResult; plan?: ResponsePlanV62 }): ResponseValidationResult {
    const errors = this.collectErrors(input.message, input.decision, input.plan);
    if (errors.length === 0) {
      return { passed: true, errors: [], finalMessage: input.message };
    }

    const fallback = this.fallback(input.decision, input.plan);
    const fallbackErrors = this.collectErrors(fallback, input.decision, input.plan);
    if (input.decision.nextAction === "refuse" && fallbackErrors.length === 0) {
      return { passed: true, errors: [], finalMessage: fallback };
    }

    return { passed: false, errors, finalMessage: fallback };
  }

  private fallback(decision: DecisionResult, plan?: ResponsePlanV62): string {
    const approved = plan?.answers.map((answer) => answer.text) ?? [];
    const next = plan?.nextQuestions ?? [];
    const statements = decision.requiredStatements.filter((item) => !item.startsWith("Попросить"));
    return deduplicateResponseParts([...approved, ...statements, ...next]).join(" ")
      || "Подскажите, пожалуйста, недостающие данные, чтобы продолжить оформление.";
  }

  private collectErrors(message: string, decision: DecisionResult, plan?: ResponsePlanV62): string[] {
    const errors: string[] = [];
    const lower = message.toLowerCase();
    for (const forbidden of decision.forbiddenStatements) if (lower.includes(forbidden.toLowerCase())) errors.push(`forbidden_statement:${forbidden}`);
    if (/[😀-🙏🌀-🗿🚀-🛿🇦-🇿]/u.test(message)) errors.push("emoji");
    if (/(^|\s)ты(\s|$)|(?:^|[\s,.!?])(?:тебе|твой|твоя|пришли|отправь|укажи)(?:$|[\s,.!?])/i.test(message)) errors.push("informal_you");
    if (/проверка пройдена|условия соблюдены|stage|nextaction|rulesapplied|prompt injection/i.test(message)) errors.push("internal_status_leak");
    if (/я\s+ии|я\s+искусственный интеллект|язык(?:овая)? модель|chatgpt|openai/i.test(lower)) errors.push("ai_identity_leak");
    if (plan?.knownFactKeys?.includes("residenceRegion") && /какая\s+прописка[^?]{0,80}\?/i.test(message)) errors.push("repeated_known_fact:residenceRegion");
    if (plan?.knownFactKeys?.includes("requestedAmount") && /какая\s+сумма\s+займа[^?]{0,80}\?/i.test(message)) errors.push("repeated_known_fact:requestedAmount");
    if (plan?.knownFactKeys?.includes("vehicleValue") && /какая\s+(?:ориентировочная\s+)?стоимость[^?]{0,80}\?/i.test(message)) errors.push("repeated_known_fact:vehicleValue");
    if (plan?.knownFactKeys?.includes("requestedProgram") && /вас\s+интересует\s+займ\s+без\s+изъятия[^?]{0,160}\?/i.test(message)) errors.push("repeated_known_fact:requestedProgram");
    if (/(?:какая|ваша|у\s+собственника)[^.!?]{0,40}регистрац/i.test(message)) errors.push("residence_registration_wording");
    if (plan?.validation.requiresPreliminaryDisclaimer && !lower.includes("окончательная сумма определяется после осмотра автомобиля и проверки документов")) errors.push("missing_preliminary_disclaimer");
    for (const answer of plan?.answers ?? []) if (answer.exact && !message.includes(answer.text)) errors.push(`missing_approved_answer:${answer.key}`);
    for (const question of plan?.nextQuestions ?? []) if (!message.includes(question)) errors.push("missing_required_next_question");
    if (
      plan?.validation.firstMessage &&
      !["refuse", "redirect_existing_contract", "pause", "on_the_way", "arrived"].includes(decision.nextAction) &&
      !message.includes(firstContactGreeting)
    ) errors.push("missing_first_contact_greeting");
    if (plan?.validation.visitConfirmation) {
      const requiredVisitParts = [
        "Предварительно записала Вас",
        "Для подтверждения времени визита с Вами свяжется менеджер",
        "Б. Молодой Гвардии, 22, Бишкек",
        "https://go.2gis.com/Y34m4",
        "https://maps.app.goo.gl/9xiWLVvdyRgn3Sx4A"
      ];
      if (!requiredVisitParts.every((part) => message.includes(part))) errors.push("incomplete_visit_confirmation");
    }
    const hasRequiredDirective = (plan?.requiredStatements ?? []).some((statement) =>
      !statement.startsWith("Попросить") && message.includes(statement)
    );
    if (plan && (plan.trace?.questionCount ?? 0) === 0 && !["target_reached", "refuse", "redirect_existing_contract", "pause", "on_the_way", "arrived"].includes(decision.nextAction) && !(plan.nextQuestions.length || hasRequiredDirective || message.includes("?"))) errors.push("missing_next_action");
    if (decision.nextAction === "refuse" && /(?:подскажите|уточните|пришлите|какая\s+|какой\s+|сможет\s+ли|когда\s+будет|вас\s+интересует)/i.test(message)) {
      errors.push("unexpected_followup_after_refusal");
    }
    return errors;
  }
}

const firstContactGreeting = "Здравствуйте! Меня зовут Айлин.";

function deduplicateResponseParts(parts: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const part of parts) {
    const normalized = part.trim();
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase("ru-RU");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
  }

  return unique;
}
