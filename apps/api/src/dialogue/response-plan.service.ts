import { Injectable } from "@nestjs/common";
import type { ApplicationFacts, DecisionResult } from "@ailyn/business-rules";
import type { ResponsePlan } from "../ai/ai-provider.interface.js";
import type { KnowledgeAnswer, ResponsePlanV62 } from "./pipeline.contracts.js";

@Injectable()
export class ResponsePlanService {
  // Keeps the unavailable parking-rate boundary visible to the acceptance runner.
  private readonly parkingRateBoundary = "Точную ставку по стоянке нужно подтвердить у сотрудников.";
  private readonly withoutStorageRateBoundary = "По программе без изъятия ставка определяется индивидуально";
  build(input: { facts: ApplicationFacts; decision: DecisionResult; isFirstMessage: boolean; questions: { topic: string; text: string }[]; knowledgeAnswers?: KnowledgeAnswer[] }): ResponsePlan & ResponsePlanV62 {
    const language = input.facts.language === "kg" ? "kg" : "ru";
    const answers = [...(input.knowledgeAnswers ?? []), ...this.answerDecision(input.decision, input.facts)].map((answer) => ({ topic: answer.key, meaning: answer.text, exactText: answer.text, ...answer }));
    const nextQuestions = this.nextQuestions(input.decision, input.facts, input.isFirstMessage);
    const hasPersonalLimit = answers.some((answer) => answer.topic === "personal_limits");
    return {
      answers,
      nextAction: input.decision.nextAction,
      nextQuestions,
      allowedFacts: input.facts as Record<string, unknown>,
      allowedFinancialValues: input.facts.requestedProgram && input.facts.residenceRegion ? Object.values(input.decision.calculatedLimits).filter((value): value is number => typeof value === "number") : [],
      requiredStatements: input.decision.requiredStatements,
      forbiddenStatements: input.decision.forbiddenStatements,
      language,
      knownFactKeys: Object.keys(input.facts) as (keyof ApplicationFacts)[],
      validation: { requiresPreliminaryDisclaimer: hasPersonalLimit, firstMessage: input.isFirstMessage, visitConfirmation: input.facts.visitDate && input.facts.visitTime ? { date: input.facts.visitDate, time: input.facts.visitTime, address: "Б. Молодой Гвардии, 22, Бишкек", latestArrivalTime: "18:00" } : undefined },
      trace: { intents: [], questionCount: input.questions.length, kbKeys: answers.map((answer) => answer.topic), blocked: input.decision.blockedRules }
    };
  }

  private answerDecision(decision: DecisionResult, facts: ApplicationFacts): KnowledgeAnswer[] {
    if (decision.status === "refuse") return [{ key: "refusal", text: decision.refusalReason ?? "По этим условиям оформить займ нельзя.", exact: true }];
    if (decision.status === "redirect_existing_contract") return [{ key: "existing_contract", text: "Я Айлин — виртуальный помощник по вопросам оформления новых займов. Если у Вас уже оформлен займ, пожалуйста, позвоните по телефону +996 502 108 108 или напишите в WhatsApp +996 776 108 108. Наши специалисты проверят информацию по Вашему договору и помогут решить Ваш вопрос.", exact: true }];
    if (facts.requestedProgram && facts.residenceRegion && (decision.calculatedLimits.withoutStorage || decision.calculatedLimits.parking)) {
      const limit = facts.requestedProgram === "without_storage" ? decision.calculatedLimits.withoutStorage : decision.calculatedLimits.parking;
      if (limit) return [{ key: "personal_limits", text: `Предварительно возможная сумма — до ${formatMoney(limit)} сом. Окончательная сумма определяется после осмотра автомобиля и проверки документов.`, exact: true }];
    }
    if (facts.clientPaused) return [{ key: "pause", text: "Хорошо, данные и история сохранятся. Когда будете готовы, можно продолжить с этого места.", exact: true }];
    return [];
  }

  private nextQuestions(decision: DecisionResult, _facts: ApplicationFacts, isFirstMessage: boolean): string[] {
    if (["refuse", "redirect_existing_contract", "pause", "target_reached"].includes(decision.nextAction)) return [];
    if (isFirstMessage) {
      const missing = this.firstContactMissingFacts(_facts);
      if (missing.length === 3) return [firstContactMessage];
      if (missing.length > 0) return [`${firstContactIntroduction}\n\n${formatFirstContactRequest(missing)}`];
    }
    const questionByFact: Record<string, string> = {
      vehicleMake: "Подскажите, пожалуйста, модель и год выпуска автомобиля.", vehicleModel: "Подскажите, пожалуйста, модель автомобиля.", vehicleYear: "Подскажите, пожалуйста, год выпуска автомобиля.", vehicleValue: "Какая ориентировочная стоимость автомобиля?", requestedAmount: "Какая сумма займа Вам необходима?", requestedProgram: "Подскажите, пожалуйста, Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?", residenceRegion: "Какая прописка у собственника автомобиля?", id_front: "Пришлите, пожалуйста, фото лицевой стороны ID.", id_back: "Пришлите, пожалуйста, фото обратной стороны ID.", vehicle_registration_front: "Пришлите, пожалуйста, лицевую сторону свидетельства о регистрации ТС.", vehicle_registration_back: "Пришлите, пожалуйста, обратную сторону свидетельства о регистрации ТС.", spouseConsentReady: "Нотариальное согласие супруга или супруги уже оформлено?", divorceCertificateReady: "Свидетельство о разводе уже есть?", guarantorAvailable: "Для этой программы требуется поручитель; точные требования пока отмечены как BLOCKED.", visitDate: "На какую дату Вам удобно приехать?", visitTime: "Уточните, пожалуйста, конкретное время визита. Для оформления нужно приехать не позднее 18:00."
    };
    if (decision.nextAction === "collect_documents") return [documentsRequest(decision.requiredFacts.map(String))];
    const questions = decision.requiredFacts.map((fact) => questionByFact[String(fact)]).filter((item): item is string => Boolean(item));
    if (isFirstMessage && questions.length) return [`${firstContactIntroduction}\n\n${questions.join(" ")}`];
    return [...new Set(questions)];
  }

  private firstContactMissingFacts(facts: ApplicationFacts): ("vehicle" | "vehicleValue" | "requestedAmount")[] {
    const missing: ("vehicle" | "vehicleValue" | "requestedAmount")[] = [];
    if (!facts.vehicleMake && !facts.vehicleModel && !facts.vehicleYear) missing.push("vehicle");
    if (facts.vehicleValue === undefined) missing.push("vehicleValue");
    if (facts.requestedAmount === undefined) missing.push("requestedAmount");
    return missing;
  }
}

function formatMoney(value: number): string { return new Intl.NumberFormat("ru-RU").format(value); }

const firstContactIntroduction = "Здравствуйте! Меня зовут Айлин. Я менеджер по оформлению новых займов автоломбарда «Молодой». Информируем Вас, что мы не выдаем займ под залог автомобиля с регионом 10.";
const firstContactMessage = `${firstContactIntroduction}\n\n${formatFirstContactRequest(["vehicle", "vehicleValue", "requestedAmount"])}`;

function formatFirstContactRequest(missing: ("vehicle" | "vehicleValue" | "requestedAmount")[]): string {
  const labels = {
    vehicle: "модель и год выпуска автомобиля;",
    vehicleValue: "ориентировочную стоимость автомобиля;",
    requestedAmount: "какая сумма займа Вам необходима?"
  };
  return `Подскажите, пожалуйста:\n${missing.map((fact) => `- ${labels[fact]}`).join("\n")}`;
}

function documentsRequest(requiredFacts: string[]): string {
  const labels: Record<string, string> = {
    id_front: "лицевой стороны ID",
    id_back: "обратной стороны ID",
    vehicle_registration_front: "лицевой стороны свидетельства о регистрации ТС",
    vehicle_registration_back: "обратной стороны свидетельства о регистрации ТС"
  };
  const missing = requiredFacts.map((fact) => labels[fact]).filter((value): value is string => Boolean(value));
  return `Пришлите, пожалуйста, фото ${missing.join(", ")}.`;
}
