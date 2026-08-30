import { Injectable } from "@nestjs/common";
import type { ApplicationFacts, DecisionResult } from "@ailyn/business-rules";
import type { ResponsePlan } from "../ai/ai-provider.interface.js";
import type { KnowledgeAnswer, ResponsePlanV62 } from "./pipeline.contracts.js";

@Injectable()
export class ResponsePlanService {
  private readonly parkingRateBoundary = "Программа со стоянкой (авто на парковке): ставка 2,4% в месяц + стоимость парковки 130 сом/сутки; сумма до 2 000 000 сом.";
  private readonly withoutStorageRateBoundary = "По программе без изъятия ставка определяется индивидуально";
  build(input: {
    facts: ApplicationFacts;
    decision: DecisionResult;
    isFirstMessage: boolean;
    questions: { topic: string; text: string }[];
    intents?: string[];
    knowledgeAnswers?: KnowledgeAnswer[];
    previousAssistantMessages?: string[];
    recovery?: {
      unresolvedFacts: string[];
      reason: "unrecognized_reply" | "attachment_issue";
    };
  }): ResponsePlan & ResponsePlanV62 {
    const language = input.facts.language === "kg" ? "kg" : "ru";
    const previousAssistantMessages = input.previousAssistantMessages ?? [];
    const decisionAnswers = this.answerDecision(input.decision, input.facts)
      .filter((answer) => !previousAssistantMessages.some((message) => message.includes(answer.text)));
    const requiredAnswers = input.decision.requiredStatements
      .filter(isClientFacingRequiredStatement)
      .filter((statement) => !previousAssistantMessages.some((message) => message.includes(statement)))
      .map((text, index) => ({ key: `required_statement_${index}`, text, exact: true }));
    const answers = [...(input.knowledgeAnswers ?? []), ...decisionAnswers, ...requiredAnswers].map((answer) => ({ topic: answer.key, meaning: answer.text, exactText: answer.text, ...answer }));
    const nextQuestions = this.nextQuestions(input.decision, input.facts, input.isFirstMessage, input.recovery);
    const hasPersonalLimit = answers.some((answer) => answer.topic === "personal_limits");
    return {
      answers,
      nextAction: input.decision.nextAction,
      nextQuestions,
      allowedFacts: input.facts as Record<string, unknown>,
      allowedFinancialValues: input.facts.requestedProgram && input.facts.residenceRegion ? Object.values(input.decision.calculatedLimits).filter((value): value is number => typeof value === "number") : [],
      requiredStatements: input.decision.requiredStatements.filter((statement) => !previousAssistantMessages.some((message) => message.includes(statement))),
      forbiddenStatements: input.decision.forbiddenStatements,
      language,
      knownFactKeys: Object.keys(input.facts) as (keyof ApplicationFacts)[],
      validation: { requiresPreliminaryDisclaimer: hasPersonalLimit, firstMessage: input.isFirstMessage, visitConfirmation: input.facts.visitDate && input.facts.visitTime ? { date: input.facts.visitDate, time: input.facts.visitTime, address: "Б. Молодой Гвардии, 22, Бишкек", latestArrivalTime: "18:00" } : undefined },
      trace: {
        intents: input.intents ?? [],
        questionCount: input.questions.length,
        kbKeys: answers.map((answer) => answer.topic),
        blocked: input.decision.blockedRules,
        recovery: input.recovery
      }
    };
  }

  private answerDecision(decision: DecisionResult, facts: ApplicationFacts): KnowledgeAnswer[] {
    if (decision.status === "refuse") return [{ key: "refusal", text: decision.refusalReason ?? "По этим условиям оформить займ нельзя.", exact: true }];
    if (decision.status === "redirect_existing_contract") return [{ key: "existing_contract", text: "Я Айлин — виртуальный помощник по вопросам оформления новых займов. Если у Вас уже оформлен займ, пожалуйста, позвоните по телефону +996 502 108 108 или напишите в WhatsApp +996 776 108 108. Наши специалисты проверят информацию по Вашему договору и помогут решить Ваш вопрос.", exact: true }];
    if (decision.nextAction === "arrived") return [{ key: "client_arrived", text: "Вы можете пройти в офис, сотрудники встретят Вас и помогут с оформлением.", exact: true }];
    if (decision.nextAction === "on_the_way") return [{ key: "client_on_the_way", text: "Наш адрес: Б. Молодой Гвардии, 22, Бишкек. Желаю Вам безопасной дороги.", exact: true }];
    const answers: KnowledgeAnswer[] = [];
    if (facts.requestedProgram && facts.residenceRegion && (decision.calculatedLimits.withoutStorage || decision.calculatedLimits.parking)) {
      const limit = facts.requestedProgram === "without_storage" ? decision.calculatedLimits.withoutStorage : decision.calculatedLimits.parking;
      if (limit) answers.push({ key: "personal_limits", text: `Предварительно возможная сумма — до ${formatMoney(limit)} сом. Окончательная сумма определяется после осмотра автомобиля и проверки документов.`, exact: true });
    }
    if (facts.visitDate && facts.visitTime) {
      answers.push({ key: "visit_confirmation", text: visitConfirmationText(facts), exact: true });
    }
    if (facts.clientPaused) answers.push({ key: "pause", text: "Хорошо, данные и история сохранятся. Когда будете готовы, можно продолжить с этого места.", exact: true });
    return answers;
  }

  private nextQuestions(
    decision: DecisionResult,
    facts: ApplicationFacts,
    isFirstMessage: boolean,
    recovery?: {
      unresolvedFacts: string[];
      reason: "unrecognized_reply" | "attachment_issue";
    }
  ): string[] {
    if (["refuse", "redirect_existing_contract", "pause", "target_reached", "on_the_way", "arrived"].includes(decision.nextAction)) return [];
    if (isFirstMessage) {
      const missing = this.firstContactMissingFacts(facts);
      if (missing.length === 3) return [firstContactMessage];
      if (missing.length > 0) return [`${firstContactIntroduction}\n\n${formatFirstContactRequest(missing)}`];
    }
    const questionByFact: Record<string, string> = {
      vehicleMake: "Подскажите, пожалуйста, модель и год выпуска автомобиля.", vehicleModel: "Подскажите, пожалуйста, модель автомобиля.", vehicleYear: "Подскажите, пожалуйста, год выпуска автомобиля.", vehicleValue: "Какая ориентировочная стоимость автомобиля?", requestedAmount: "Какая сумма займа Вам необходима?", requestedProgram: "Подскажите, пожалуйста, Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?", residenceRegion: "Какая прописка у собственника автомобиля?", ownerFullName: "Подскажите, пожалуйста, ФИО собственника автомобиля.", ownerResidenceRegion: "Какая прописка у собственника автомобиля?", ownerCanVisit: "Сможет ли собственник лично приехать на осмотр автомобиля и выдачу займа?", ownerFamilyStatus: "Подскажите, пожалуйста, собственник автомобиля состоит в браке, никогда не состоял в браке или в разводе?", id_front: "Пришлите, пожалуйста, фото лицевой стороны ID.", id_back: "Пришлите, пожалуйста, фото обратной стороны ID.", vehicle_registration_front: "Пришлите, пожалуйста, лицевую сторону свидетельства о регистрации ТС.", vehicle_registration_back: "Пришлите, пожалуйста, обратную сторону свидетельства о регистрации ТС.", familyStatus: "Подскажите, пожалуйста, собственник автомобиля состоит в браке, никогда не состоял в браке или в разводе?", vehicleBoughtDuringMarriage: "Автомобиль был приобретён во время брака или после развода?", spouseConsentReady: facts.spouseConsentReady === false ? "Сообщите, пожалуйста, когда нотариальное согласие будет готово. Его можно оформить у любого нотариуса или у нотариуса в нашем здании." : "Нотариальное согласие супруга или супруги уже оформлено?", divorceCertificateReady: "Свидетельство о разводе уже есть?", guarantorAvailable: "Подскажите, пожалуйста, есть ли у Вас поручитель?", visitDate: "На какую дату Вам удобно приехать?", visitTime: "Уточните, пожалуйста, конкретное время визита. Для оформления нужно приехать не позднее 18:00."
    };
    if (facts.residenceNeedsClarification) {
      questionByFact.residenceRegion = "Уточните, пожалуйста, в каком городе или области прописан собственник автомобиля?";
      questionByFact.ownerResidenceRegion = "Уточните, пожалуйста, в каком городе или области прописан собственник автомобиля?";
    }
    if (facts.requestedProgram === "without_storage" && decision.rulesApplied.includes("other_region_guarantor_unavailable")) {
      questionByFact.requestedProgram = "Хотите продолжить по программе с постановкой автомобиля на охраняемую стоянку?";
    }
    if (recovery?.unresolvedFacts.length) {
      return buildRecoveryQuestions(recovery, facts, decision);
    }
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

function isClientFacingRequiredStatement(statement: string): boolean {
  return !statement.startsWith("Попросить") &&
    !statement.startsWith("Сохранить") &&
    !statement.startsWith("Карточка") &&
    !statement.startsWith("Предварительная запись");
}

function visitConfirmationText(facts: ApplicationFacts): string {
  const reminders: string[] = [];
  if (facts.guarantorAvailable) reminders.push("Поручитель должен присутствовать лично и иметь с собой ID или паспорт.");
  if (facts.familyStatus === "married" && facts.spouseConsentReady) reminders.push("Возьмите с собой оригинал нотариального согласия супруга или супруги.");
  return [
    "Спасибо. Предварительно записала Вас на указанное время. Для подтверждения времени визита с Вами свяжется менеджер.",
    `Дата и время: ${facts.visitDate}, ${facts.visitTime}.`,
    "Б. Молодой Гвардии, 22, Бишкек.",
    "https://go.2gis.com/Y34m4",
    "https://maps.app.goo.gl/9xiWLVvdyRgn3Sx4A",
    ...reminders
  ].join("\n");
}

function formatMoney(value: number): string { return new Intl.NumberFormat("ru-RU").format(value).replace(/\u00a0/g, " "); }

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

function buildRecoveryQuestions(
  recovery: { unresolvedFacts: string[]; reason: "unrecognized_reply" | "attachment_issue" },
  facts: ApplicationFacts,
  decision: DecisionResult
): string[] {
  const unresolved = recovery.unresolvedFacts.map(String);
  const unresolvedDocuments = unresolved.filter(isDocumentFact);
  if (recovery.reason === "attachment_issue" && unresolvedDocuments.length > 0) {
    return [documentsRecoveryRequest(unresolvedDocuments)];
  }
  return unresolved.map((fact) => clarificationQuestion(fact, facts, decision)).filter((item, index, source) => Boolean(item) && source.indexOf(item) === index);
}

function clarificationQuestion(fact: string, facts: ApplicationFacts, decision: DecisionResult): string {
  const clarificationByFact: Record<string, string> = {
    vehicleMake: "Я не до конца поняла марку автомобиля. Уточните, пожалуйста, марку, модель и год выпуска автомобиля.",
    vehicleModel: "Я не до конца поняла модель автомобиля. Уточните, пожалуйста, марку, модель и год выпуска автомобиля.",
    vehicleYear: "Я не до конца поняла год выпуска автомобиля. Напишите, пожалуйста, только год выпуска автомобиля.",
    vehicleValue: "Я не до конца поняла ориентировочную стоимость автомобиля. Напишите, пожалуйста, примерную стоимость в сомах.",
    requestedAmount: "Я не до конца поняла, какая сумма займа Вам нужна. Напишите, пожалуйста, нужную сумму в сомах.",
    requestedProgram: decision.rulesApplied.includes("other_region_guarantor_unavailable")
      ? "Я не до конца поняла Ваш выбор. Хотите продолжить по программе с постановкой автомобиля на охраняемую стоянку?"
      : "Я не до конца поняла, какая программа Вам нужна. Уточните, пожалуйста, Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?",
    residenceRegion: facts.residenceNeedsClarification
      ? "Я не до конца поняла прописку. Уточните, пожалуйста, в каком городе или области прописан собственник автомобиля?"
      : "Я не до конца поняла прописку. Уточните, пожалуйста, в каком городе или области прописан собственник автомобиля?",
    ownerResidenceRegion: "Я не до конца поняла прописку собственника. Уточните, пожалуйста, в каком городе или области прописан собственник автомобиля?",
    ownerFullName: "Я не до конца поняла ФИО собственника. Напишите, пожалуйста, фамилию, имя и отчество собственника полностью.",
    ownerCanVisit: "Я не до конца поняла, сможет ли собственник приехать лично. Уточните, пожалуйста, сможет ли собственник лично приехать на осмотр автомобиля и выдачу займа?",
    ownerFamilyStatus: "Я не до конца поняла семейный статус собственника. Уточните, пожалуйста, собственник автомобиля состоит в браке, никогда не состоял в браке или в разводе?",
    familyStatus: "Я не до конца поняла семейный статус. Уточните, пожалуйста, собственник автомобиля состоит в браке, никогда не состоял в браке или в разводе?",
    vehicleBoughtDuringMarriage: "Я не до конца поняла, когда был куплен автомобиль. Уточните, пожалуйста, автомобиль был приобретён во время брака или после развода?",
    spouseConsentReady: facts.spouseConsentReady === false
      ? "Я не до конца поняла ответ по нотариальному согласию. Сообщите, пожалуйста, когда нотариальное согласие будет готово."
      : "Я не до конца поняла ответ по нотариальному согласию. Уточните, пожалуйста, нотариальное согласие супруга или супруги уже оформлено?",
    divorceCertificateReady: "Я не до конца поняла ответ по свидетельству о разводе. Уточните, пожалуйста, свидетельство о разводе уже есть?",
    guarantorAvailable: "Я не до конца поняла ответ по поручителю. Уточните, пожалуйста, есть ли у Вас поручитель?",
    visitDate: "Я не до конца поняла дату визита. Напишите, пожалуйста, удобную дату визита.",
    visitTime: "Я не до конца поняла время визита. Напишите, пожалуйста, удобное время визита не позднее 18:00."
  };
  if (isDocumentFact(fact)) {
    return documentsRecoveryRequest([fact]);
  }
  return clarificationByFact[fact] ?? "Я не до конца поняла Ваш ответ. Уточните, пожалуйста, детали ещё раз.";
}

function documentsRecoveryRequest(requiredFacts: string[]): string {
  const labels: Record<string, string> = {
    id_front: "лицевую сторону ID",
    id_back: "обратную сторону ID",
    vehicle_registration_front: "лицевую сторону свидетельства о регистрации ТС",
    vehicle_registration_back: "обратную сторону свидетельства о регистрации ТС"
  };
  const missing = requiredFacts.map((fact) => labels[fact]).filter((value): value is string => Boolean(value));
  return `Я не смогла надёжно распознать документы. Если удобно, пришлите, пожалуйста, фото: ${missing.join(", ")}.`;
}

function isDocumentFact(value: string): boolean {
  return value === "id_front" || value === "id_back" || value === "vehicle_registration_front" || value === "vehicle_registration_back";
}
