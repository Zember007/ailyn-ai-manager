import { Injectable } from "@nestjs/common";
import type { ApplicationFacts, DecisionResult } from "@ailyn/business-rules";
import type { ResponsePlan } from "../ai/ai-provider.interface.js";

@Injectable()
export class ResponsePlanService {
  build(input: { facts: ApplicationFacts; decision: DecisionResult; isFirstMessage: boolean; questions: { topic: string; text: string }[] }): ResponsePlan {
    const answers = [...this.answerQuestions(input.questions, input.facts), ...this.answerDecision(input.decision, input.facts)];
    const nextQuestions = this.nextQuestions(input.decision, input.facts, input.isFirstMessage);
    const allowedFinancialValues = Object.values(input.decision.calculatedLimits).filter(
      (value): value is number => typeof value === "number"
    );

    return {
      answers,
      nextAction: input.decision.nextAction,
      nextQuestions,
      allowedFacts: input.facts as Record<string, unknown>,
      allowedFinancialValues,
      requiredStatements: input.decision.requiredStatements,
      forbiddenStatements: input.decision.forbiddenStatements,
      language: "ru"
    };
  }

  private answerQuestions(questions: { topic: string; text: string }[], facts: ApplicationFacts): ResponsePlan["answers"] {
    const text = questions.map((question) => question.text.toLowerCase()).join(" ");
    const answers: ResponsePlan["answers"] = [];
    if (text.includes("ставк") && text.includes("стоян")) {
      answers.push({
        topic: "parking_rate",
        meaning: "parking rate is blocked until approved",
        exactText: "Точную ставку по стоянке нужно подтвердить у сотрудников, потому что этот параметр пока отмечен как неподтвержденный."
      });
    } else if (text.includes("ставк") || text.includes("процент")) {
      answers.push({
        topic: "without_storage_rate",
        meaning: "without-storage rate is individual",
        exactText: "По программе без изъятия ставка определяется индивидуально после осмотра автомобиля и проверки документов."
      });
    }
    if (text.includes("документ")) {
      answers.push({
        topic: "documents",
        meaning: "required documents",
        exactText: "Для предварительного оформления нужны фото ID и свидетельства о регистрации автомобиля с обеих сторон; оригиналы нужно взять на визит."
      });
    }
    if (text.includes("границ")) {
      answers.push({
        topic: "foreign_travel",
        meaning: "travel abroad needs approval",
        exactText: "Выезд за пределы Кыргызской Республики на заложенном автомобиле возможен только по согласованию с компанией."
      });
    }
    if (text.includes("лимит") || text.includes("сколько")) {
      const withoutStorage = facts.vehicleValue ? undefined : "до 600 000 сом без изъятия для Бишкек/Чуй и до 2 000 000 сом по стоянке";
      if (withoutStorage) {
        answers.push({ topic: "general_limits", meaning: "general company limits", exactText: `Общие лимиты: ${withoutStorage}.` });
      }
    }
    return answers;
  }

  private answerDecision(decision: DecisionResult, facts: ApplicationFacts): ResponsePlan["answers"] {
    if (decision.status === "refuse") {
      return [{ topic: "refusal", meaning: "deterministic refusal", exactText: decision.refusalReason }];
    }
    if (decision.status === "redirect_existing_contract") {
      return [
        {
          topic: "existing_contract",
          meaning: "redirect existing contract",
          exactText: "По действующему договору лучше обратиться к сотрудникам компании: Айлин не проверяет задолженность, оплату, реквизиты или возврат документов."
        }
      ];
    }
    if (decision.calculatedLimits.withoutStorage || decision.calculatedLimits.parking) {
      const parts: string[] = [];
      if (decision.calculatedLimits.withoutStorage) {
        parts.push(`без изъятия предварительно до ${formatMoney(decision.calculatedLimits.withoutStorage)} сом`);
      }
      if (decision.calculatedLimits.parking) {
        parts.push(`по стоянке предварительно до ${formatMoney(decision.calculatedLimits.parking)} сом`);
      }
      return [
        {
          topic: "personal_limits",
          meaning: "preliminary calculated limits",
          exactText: `${parts.join(", ")}. Окончательная сумма определяется после осмотра автомобиля и проверки документов.`
        }
      ];
    }
    if (facts.clientPaused) {
      return [{ topic: "pause", meaning: "client paused", exactText: "Хорошо, данные и история сохранятся. Когда будете готовы, можно продолжить с этого места." }];
    }
    return [];
  }

  private nextQuestions(decision: DecisionResult, _facts: ApplicationFacts, isFirstMessage: boolean): string[] {
    if (decision.status === "refuse" || decision.status === "redirect_existing_contract" || decision.nextAction === "pause") {
      return [];
    }
    const prefix = isFirstMessage
      ? "Здравствуйте. Сразу отмечу: по автомобилям с регионом 10 компания займ не оформляет."
      : "";
    const questionByFact: Record<string, string> = {
      vehicleMake: "Уточните, пожалуйста, модель и год автомобиля.",
      vehicleModel: "Уточните, пожалуйста, модель автомобиля.",
      vehicleYear: "Уточните, пожалуйста, год выпуска автомобиля.",
      vehicleValue: "Какая ориентировочная стоимость автомобиля?",
      requestedAmount: "Какая сумма Вам нужна?",
      residenceRegion: "Какая прописка у собственника автомобиля?",
      id_front: "Пришлите, пожалуйста, фото лицевой стороны ID.",
      id_back: "Пришлите, пожалуйста, фото обратной стороны ID.",
      vehicle_registration_front: "Пришлите, пожалуйста, лицевую сторону свидетельства о регистрации ТС.",
      vehicle_registration_back: "Пришлите, пожалуйста, обратную сторону свидетельства о регистрации ТС.",
      spouseConsentReady: "Нотариальное согласие супруга или супруги уже оформлено?",
      guarantorAvailable: "Нужен поручитель; точные требования пока неподтверждены, поэтому сценарий отмечен BLOCKED.",
      visitDate: "На какую дату и время Вам удобно приехать?",
      visitTime: "Уточните, пожалуйста, конкретное время визита. Для оформления нужно приехать не позднее 18:00."
    };
    const questions = decision.requiredFacts.map((fact) => questionByFact[String(fact)]).filter(Boolean);
    if (prefix && questions.length > 0) {
      questions[0] = `${prefix} ${questions[0]}`;
    }
    return [...new Set(questions)];
  }
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat("ru-RU").format(value);
}
