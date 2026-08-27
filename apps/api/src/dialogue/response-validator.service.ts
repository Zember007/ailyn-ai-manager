import { Injectable } from "@nestjs/common";
import type { DecisionResult } from "@ailyn/business-rules";

export interface ResponseValidationResult {
  passed: boolean;
  errors: string[];
  finalMessage: string;
}

@Injectable()
export class ResponseValidatorService {
  validate(input: { message: string; decision: DecisionResult }): ResponseValidationResult {
    const errors: string[] = [];
    const lower = input.message.toLowerCase();

    for (const forbidden of input.decision.forbiddenStatements) {
      if (lower.includes(forbidden.toLowerCase())) {
        errors.push(`forbidden_statement:${forbidden}`);
      }
    }
    if (/[😀-🙏🌀-🗿🚀-🛿🇦-🇿]/u.test(input.message)) {
      errors.push("emoji");
    }
    if (/(^|\s)ты(\s|$)|тебе|твой|твоя/i.test(input.message)) {
      errors.push("informal_you");
    }
    if (/проверка пройдена|условия соблюдены|заявка продолжается|stage|nextaction|rulesapplied/i.test(input.message)) {
      errors.push("internal_status_leak");
    }

    if (errors.length === 0) {
      return { passed: true, errors, finalMessage: input.message };
    }

    return {
      passed: false,
      errors,
      finalMessage: this.fallback(input.decision)
    };
  }

  private fallback(decision: DecisionResult): string {
    if (decision.status === "refuse") {
      return decision.refusalReason ?? "По этим условиям оформить займ нельзя.";
    }
    if (decision.status === "redirect_existing_contract") {
      return "По действующему договору нужно обратиться к сотрудникам компании. Айлин не проверяет задолженность, оплату или реквизиты.";
    }
    return [...decision.requiredStatements, "Уточните, пожалуйста, недостающие данные, чтобы продолжить оформление."]
      .filter(Boolean)
      .join(" ");
  }
}
