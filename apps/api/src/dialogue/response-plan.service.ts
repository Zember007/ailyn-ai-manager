import { Injectable } from "@nestjs/common";
import type { ApplicationFacts, DecisionResult, DocumentCode } from "@ailyn/business-rules";
import type { ResponsePlan } from "../ai/ai-provider.interface.js";
import type { FxConversionTrace, KnowledgeAnswer, ResponsePlanV62 } from "./pipeline.contracts.js";
import { formatSomMoney as formatMoney } from "./money-normalization.js";

export const PARKING_AFTER_WITHOUT_STORAGE_LIMIT_OFFER =
  "Если Вам нужна сумма больше лимита без изъятия, можем продолжить по программе с постановкой автомобиля на охраняемую стоянку?";

@Injectable()
export class ResponsePlanService {
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
      reason: "unrecognized_reply" | "attachment_issue" | "fx_unavailable";
    };
    fxConversions?: FxConversionTrace[];
    supportPhone?: string;
    receivedDocuments?: DocumentCode[];
  }): ResponsePlan & ResponsePlanV62 {
    const language = input.facts.language === "kg" ? "kg" : "ru";
    const previousAssistantMessages = input.previousAssistantMessages ?? [];
    const firstContactAnswer = input.isFirstMessage && !shouldSuppressFirstContactIntroduction(input.decision, input.facts)
      ? { key: "first_contact_greeting", text: firstContactIntroduction, exact: true }
      : undefined;
    const specialAnswers = buildSpecialAnswers(
      input.facts,
      input.decision,
      input.questions,
      input.intents ?? [],
      input.supportPhone,
      buildDocumentAcknowledgement(input.receivedDocuments ?? [])
    );
    const deferLegacyFlow = input.questions.length > 0 || input.intents?.some((intent) => ["complaint", "pause", "on_the_way", "arrived"].includes(intent));
    const decisionAnswers = (deferLegacyFlow ? [] : this.answerDecision(input.decision, input.facts, input.intents ?? []))
      .filter((answer) => !previousAssistantMessages.some((message) => message.includes(answer.text)));
    const requiredAnswers = input.decision.requiredStatements
      .filter(isClientFacingRequiredStatement)
      .filter((statement) => !previousAssistantMessages.some((message) => message.includes(statement)))
      .map((text, index) => ({ key: `required_statement_${index}`, text, exact: true }));
    const answers = [firstContactAnswer, ...specialAnswers, ...(input.knowledgeAnswers ?? []), ...decisionAnswers, ...requiredAnswers]
      .filter((answer): answer is KnowledgeAnswer => Boolean(answer))
      .filter((answer) => !previousAssistantMessages.some((message) => message.includes(answer.text)))
      .map((answer) => ({ topic: answer.key, meaning: answer.text, exactText: answer.text, ...answer }));
    const nextQuestions = deferLegacyFlow ? [] : this.nextQuestions(input.decision, input.facts, input.isFirstMessage, input.recovery, input.intents ?? []);
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
        fxConversions: input.fxConversions,
        recovery: input.recovery
      }
    };
  }

  private answerDecision(decision: DecisionResult, facts: ApplicationFacts, intents: string[]): KnowledgeAnswer[] {
    if (decision.status === "refuse") return [{ key: "refusal", text: decision.refusalReason ?? "По этим условиям оформить займ нельзя.", exact: true }];
    if (decision.status === "redirect_existing_contract") return [{ key: "existing_contract", text: "Я Айлин — виртуальный помощник по вопросам оформления новых займов. Если у Вас уже оформлен займ, пожалуйста, позвоните по телефону +996 502 108 108 или напишите в WhatsApp +996 776 108 108. Наши специалисты проверят информацию по Вашему договору и помогут решить Ваш вопрос.", exact: true }];
    if (decision.nextAction === "arrived") return [{ key: "client_arrived", text: "Вы можете пройти в офис, сотрудники встретят Вас и помогут с оформлением.", exact: true }];
    if (decision.nextAction === "on_the_way") return [{ key: "client_on_the_way", text: "Наш адрес: Б. Молодой Гвардии, 22, Бишкек. Желаю Вам безопасной дороги.", exact: true }];
    const answers: KnowledgeAnswer[] = [];
    if (facts.requestedProgram && facts.residenceRegion && (decision.calculatedLimits.withoutStorage || decision.calculatedLimits.parking)) {
      const limit = facts.requestedProgram === "without_storage" ? decision.calculatedLimits.withoutStorage : decision.calculatedLimits.parking;
      const needsLimitOptions = facts.requestedProgram === "without_storage" &&
        !decision.rulesApplied.includes("other_region_guarantor_unavailable") &&
        typeof limit === "number" &&
        typeof decision.calculatedLimits.parking === "number" &&
        decision.calculatedLimits.parking > limit &&
        (intents.some((intent) => intent === "limit_objection" || intent === "clarification_request") || (typeof facts.requestedAmount === "number" && facts.requestedAmount > limit));
      if (needsLimitOptions) {
        answers.push({
          key: "personal_limit_options",
          text: `По программе без изъятия предварительно возможная сумма — до ${formatMoney(limit)} сом. По программе со стоянкой предварительно возможная сумма — до ${formatMoney(decision.calculatedLimits.parking ?? 0)} сом. Окончательная сумма определяется после осмотра автомобиля и проверки документов.`,
          exact: true
        });
      } else if (limit) {
        answers.push({ key: "personal_limits", text: `Предварительно возможная сумма — до ${formatMoney(limit)} сом. Окончательная сумма определяется после осмотра автомобиля и проверки документов.`, exact: true });
      }
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
      reason: "unrecognized_reply" | "attachment_issue" | "fx_unavailable";
    },
    intents: string[] = []
  ): string[] {
    if (intents.includes("complaint")) return [];
    if (["refuse", "redirect_existing_contract", "pause", "target_reached", "on_the_way", "arrived"].includes(decision.nextAction)) return [];
    // The required statement already asks for the corrected year. Adding the
    // generic collection prompt duplicates that question and can make the
    // correction look optional.
    if (decision.rulesApplied.includes("future_vehicle_year_correction")) return [];
    if (recovery?.unresolvedFacts.length) {
      return buildRecoveryQuestions(recovery, facts, decision);
    }
    const documentFollowUp = buildPartialDocumentFollowUp(facts);
    if (documentFollowUp.length > 0) return documentFollowUp;
    if (isFirstMessage && !shouldSuppressFirstContactIntroduction(decision, facts)) {
      if (facts.vehicleMake && !facts.vehicleModel) return ["Подскажите, пожалуйста, модель автомобиля."];
      if ((facts.vehicleMake || facts.vehicleModel) && !facts.vehicleYear) return ["Подскажите, пожалуйста, год выпуска автомобиля."];
      const missing = this.firstContactMissingFacts(facts);
      if (missing.length === 3) return [formatFirstContactRequest(missing)];
      if (missing.length > 0) return [formatFirstContactRequest(missing)];
    }
    const questionByFact: Record<string, string> = {
      vehicleMake: "Подскажите, пожалуйста, модель и год выпуска автомобиля.", vehicleModel: "Подскажите, пожалуйста, модель автомобиля.", vehicleYear: "Подскажите, пожалуйста, год выпуска автомобиля.", vehicleValue: "Какая ориентировочная стоимость автомобиля?", requestedAmount: "Какая сумма займа Вам необходима?", requestedProgram: "Подскажите, пожалуйста, Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?", residenceRegion: "Где прописан собственник автомобиля?", ownerFullName: "Подскажите, пожалуйста, ФИО собственника автомобиля.", ownerResidenceRegion: "Где прописан собственник автомобиля?", ownerCanVisit: "Сможет ли собственник лично приехать на осмотр автомобиля и выдачу займа?", ownerFamilyStatus: "Подскажите, пожалуйста, собственник автомобиля состоит в браке, никогда не состоял в браке или в разводе?", id_front: "Пришлите, пожалуйста, фото лицевой стороны ID.", id_back: "Пришлите, пожалуйста, фото обратной стороны ID.", vehicle_registration_front: "Пришлите, пожалуйста, лицевую сторону свидетельства о регистрации ТС.", vehicle_registration_back: "Пришлите, пожалуйста, обратную сторону свидетельства о регистрации ТС.", familyStatus: "Подскажите, пожалуйста, собственник автомобиля состоит в браке, никогда не состоял в браке или в разводе?", vehicleBoughtDuringMarriage: "Автомобиль был приобретён во время брака или после развода?", spouseConsentReady: facts.spouseConsentReady === false ? "Сообщите, пожалуйста, когда нотариальное согласие будет готово. Его можно оформить у любого нотариуса или у нотариуса в нашем здании." : "Нотариальное согласие супруга или супруги уже оформлено?", divorceCertificateReady: "Свидетельство о разводе уже есть?", guarantorAvailable: "Подскажите, пожалуйста, есть ли у Вас поручитель?", visitDate: "На какую дату Вам удобно приехать?", visitTime: "Уточните, пожалуйста, конкретное время визита. Для оформления нужно приехать не позднее 18:00."
    };
    if (facts.residenceNeedsClarification) {
      questionByFact.residenceRegion = "Уточните, пожалуйста, в каком городе или области прописан собственник автомобиля?";
      questionByFact.ownerResidenceRegion = "Уточните, пожалуйста, в каком городе или области прописан собственник автомобиля?";
    }
    if (facts.requestedProgram === "without_storage" && decision.rulesApplied.includes("other_region_guarantor_unavailable")) {
      questionByFact.requestedProgram = "Хотите продолжить по программе с постановкой автомобиля на охраняемую стоянку?";
    }
    if (shouldOfferParkingAfterLimit(facts, decision, intents)) {
      return [PARKING_AFTER_WITHOUT_STORAGE_LIMIT_OFFER];
    }
    if (decision.nextAction === "collect_documents") return [documentsRequest(decision.requiredFacts.map(String))];
    const questions = decision.requiredFacts.map((fact) => questionByFact[String(fact)]).filter((item): item is string => Boolean(item));
    return [...new Set(questions)].slice(0, 1);
  }

  private firstContactMissingFacts(facts: ApplicationFacts): ("vehicle" | "vehicleValue" | "requestedAmount")[] {
    const missing: ("vehicle" | "vehicleValue" | "requestedAmount")[] = [];
    if (!facts.vehicleMake || !facts.vehicleModel || !facts.vehicleYear) missing.push("vehicle");
    if (facts.vehicleValue === undefined) missing.push("vehicleValue");
    if (facts.requestedAmount === undefined) missing.push("requestedAmount");
    return missing;
  }
}

function shouldOfferParkingAfterLimit(facts: ApplicationFacts, decision: DecisionResult, intents: string[]): boolean {
  if (facts.requestedProgram !== "without_storage") return false;
  if (decision.rulesApplied.includes("other_region_guarantor_unavailable")) return false;
  if (!facts.residenceRegion) return false;
  const withoutStorage = decision.calculatedLimits.withoutStorage;
  const parking = decision.calculatedLimits.parking;
  if (typeof withoutStorage !== "number" || typeof parking !== "number" || parking <= withoutStorage) return false;
  return intents.includes("limit_objection") || (typeof facts.requestedAmount === "number" && facts.requestedAmount > withoutStorage);
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

function buildSpecialAnswers(
  facts: ApplicationFacts,
  decision: DecisionResult,
  questions: { topic: string; text: string }[],
  intents: string[],
  supportPhone = "+996 502 108 108",
  documentAcknowledgement?: KnowledgeAnswer
): KnowledgeAnswer[] {
  const answers: KnowledgeAnswer[] = [];

  if (documentAcknowledgement) answers.push(documentAcknowledgement);

  if (intents.includes("complaint")) {
    answers.push({ key: "complaint", text: `Понимаю, что условия могут вызвать вопросы. Я готова уточнить всё, что важно для Вас. Если удобнее обсудить это с сотрудником, пожалуйста, позвоните по номеру ${supportPhone}.`, exact: true });
    return answers;
  }

  if (facts.declinedDocuments) {
    answers.push({
      key: "documents_declined",
      text: "Хорошо, поняла. При визите в офис, пожалуйста, возьмите с собой оригиналы документов.",
      exact: true
    });
  }

  const effectiveFamilyStatus = facts.borrowerIsOwner === false ? facts.ownerFamilyStatus : facts.familyStatus;

  if (effectiveFamilyStatus === "married" && decision.nextAction !== "refuse") {
    answers.push({
      key: "family_married_guidance",
      text: "Для оформления потребуется оригинал нотариального согласия супруга или супруги. Его можно оформить у любого нотариуса или у нотариуса в нашем здании. Ориентировочная стоимость оформления согласия — 1500 сом.",
      exact: true
    });
  }

  if (effectiveFamilyStatus === "single") {
    answers.push({
      key: "family_single_guidance",
      text: "Поняла, нотариальное согласие супруга или супруги в таком случае не требуется. Можем перейти к следующему этапу оформления.",
      exact: true
    });
  }

  if (effectiveFamilyStatus === "divorced" && facts.vehicleBoughtDuringMarriage === undefined) {
    answers.push({
      key: "family_divorced_guidance",
      text: "Нотариальное согласие бывшего супруга или супруги не требуется. Подскажите, пожалуйста, автомобиль был приобретён во время брака или после развода?",
      exact: true
    });
  }

  if (effectiveFamilyStatus === "divorced" && facts.vehicleBoughtDuringMarriage) {
    answers.push({
      key: "family_divorce_certificate",
      text: "Для визита потребуется оригинал свидетельства о расторжении брака. Если удобно, можете заранее прислать его фотографию.",
      exact: true
    });
  }

  if (effectiveFamilyStatus === "divorced" && facts.vehicleBoughtDuringMarriage === false) {
    answers.push({
      key: "family_after_divorce_guidance",
      text: "Поняла, в таком случае свидетельство о расторжении брака для этого условия не требуется. Можем перейти к следующему этапу оформления.",
      exact: true
    });
  }

  const visitAnswer = buildVisitAnswer(facts, decision);
  if (visitAnswer) answers.push(visitAnswer);

  if (questions.some((question) => /когда[^?]*менеджер[^?]*позвон/i.test(question.text))) {
    answers.push({
      key: "manager_callback_timing",
      text: facts.visitDate && facts.visitTime
        ? "Обычно менеджер связывается с клиентами в течение часа."
        : "Менеджер свяжется с Вами до 12:00 первого рабочего дня.",
      exact: true
    });
  }

  if (questions.some((question) => /wi.?fi|wifi/i.test(question.text)) && questions.some((question) => /парков/i.test(question.text))) {
    answers.push({
      key: "office_amenities",
      text: "По Wi-Fi и парковке точную информацию лучше уточнить у сотрудников при визите в офис.",
      exact: true
    });
  }

  return answers;
}

function buildDocumentAcknowledgement(receivedDocuments: DocumentCode[]): KnowledgeAnswer | undefined {
  const received = new Set(receivedDocuments);
  const parts: string[] = [];

  if (received.has("id_front") && received.has("id_back")) {
    parts.push("лицевую и обратную стороны ID");
  } else {
    if (received.has("id_front")) parts.push("лицевую сторону ID");
    if (received.has("id_back")) parts.push("обратную сторону ID");
  }
  if (received.has("vehicle_registration_front") && received.has("vehicle_registration_back")) {
    parts.push("лицевую и обратную стороны свидетельства о регистрации ТС");
  } else {
    if (received.has("vehicle_registration_front")) parts.push("лицевую сторону свидетельства о регистрации ТС");
    if (received.has("vehicle_registration_back")) parts.push("обратную сторону свидетельства о регистрации ТС");
  }

  if (parts.length === 0) return undefined;
  return {
    key: "documents_received",
    text: `Спасибо, получили: ${parts.join(", ")}.`,
    exact: true
  };
}

function buildVisitAnswer(facts: ApplicationFacts, decision: DecisionResult): KnowledgeAnswer | undefined {
  if (!facts.visitRequested && !facts.visitDate && !facts.visitTime) return undefined;
  if (facts.visitDate && !isWorkingDayText(facts.visitDate)) {
    const nextWorkingDate = nextWorkingDateFrom(facts.visitDate);
    return {
      key: "visit_non_working_day_guidance",
      text: `Воскресенье, ${facts.visitDate}, у нас выходной. Ближайший рабочий день — ${nextWorkingDate}. Мы работаем ПН–ПТ 11:00–19:00. Для оформления нужно подъехать не позднее 18:00.`,
      exact: true
    };
  }
  if (facts.visitTime && facts.visitTime > "18:00") {
    return {
      key: "visit_latest_arrival_guidance",
      text: "Мы работаем ПН–ПТ 11:00–19:00. Для оформления нужно подъехать не позднее 18:00. Подскажите, пожалуйста, другое конкретное время.",
      exact: true
    };
  }
  if (facts.visitRequested && facts.visitDate && !facts.visitTime) {
    return {
      key: "visit_time_required_guidance",
      text: "Мы работаем ПН–ПТ 11:00–19:00. Для оформления нужно подъехать не позднее 18:00. Уточните, пожалуйста, конкретное время визита.",
      exact: true
    };
  }
  if (facts.visitRequested && !facts.visitDate && !facts.visitTime) {
    return {
      key: "visit_schedule_guidance",
      text: "Мы работаем ПН–ПТ 11:00–19:00. Для оформления нужно подъехать не позднее 18:00. Уточните, пожалуйста, конкретные дату и время визита.",
      exact: true
    };
  }
  if (facts.visitDate && facts.visitTime && decision.nextAction !== "refuse") {
    return { key: "visit_confirmation", text: visitConfirmationText(facts), exact: true };
  }
  return undefined;
}

function shouldSuppressFirstContactIntroduction(decision: DecisionResult, facts: ApplicationFacts): boolean {
  if (["collect_owner", "collect_family_status", "schedule_visit", "arrived", "on_the_way"].includes(decision.nextAction)) return true;
  if (facts.declinedDocuments || facts.familyStatus || facts.visitRequested || facts.visitDate || facts.visitTime) return true;
  return false;
}

const firstContactIntroduction = "Здравствуйте! Меня зовут Айлин. Я менеджер по оформлению новых займов автоломбарда «Молодой». Информируем Вас, что мы не выдаем займ под залог автомобиля с регионом 10.";

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
  recovery: { unresolvedFacts: string[]; reason: "unrecognized_reply" | "attachment_issue" | "fx_unavailable" },
  facts: ApplicationFacts,
  decision: DecisionResult
): string[] {
  const unresolved = recovery.unresolvedFacts.map(String);
  const unresolvedDocuments = unresolved.filter(isDocumentFact);
  if (recovery.reason === "attachment_issue" && unresolvedDocuments.length > 0) {
    return [documentsRecoveryRequest(unresolvedDocuments)];
  }
  return unresolved.map((fact) => clarificationQuestion(fact, facts, decision, recovery.reason)).filter((item, index, source) => Boolean(item) && source.indexOf(item) === index);
}

function clarificationQuestion(
  fact: string,
  facts: ApplicationFacts,
  decision: DecisionResult,
  recoveryReason: "unrecognized_reply" | "attachment_issue" | "fx_unavailable" = "unrecognized_reply"
): string {
  if (recoveryReason === "fx_unavailable") {
    if (fact === "requestedAmount") {
      return "Я увидела сумму в иностранной валюте, но не смогла сейчас надёжно перевести её в сомы. Напишите, пожалуйста, нужную сумму займа в сомах.";
    }
    if (fact === "vehicleValue") {
      return "Я увидела стоимость автомобиля в иностранной валюте, но не смогла сейчас надёжно перевести её в сомы. Напишите, пожалуйста, ориентировочную стоимость автомобиля в сомах.";
    }
  }
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

function buildPartialDocumentFollowUp(facts: ApplicationFacts): string[] {
  const docs = facts.documents ?? {};
  const receivedMissing: string[] = [];
  if (docs.id_front === "received" && docs.id_back !== "received") receivedMissing.push("обратной стороны ID");
  if (docs.id_back === "received" && docs.id_front !== "received") receivedMissing.push("лицевой стороны ID");
  if (docs.vehicle_registration_front === "received" && docs.vehicle_registration_back !== "received") receivedMissing.push("обратной стороны свидетельства о регистрации ТС");
  if (docs.vehicle_registration_back === "received" && docs.vehicle_registration_front !== "received") receivedMissing.push("лицевой стороны свидетельства о регистрации ТС");
  if (receivedMissing.length > 0) {
    return [`Пришлите, пожалуйста, фото ${receivedMissing.join(", ")}.`];
  }
  if (docs.vehicle_registration_front === "poor_quality") {
    return ["Пришлите, пожалуйста, более качественное фото лицевой стороны свидетельства о регистрации ТС."];
  }
  if (docs.vehicle_registration_back === "poor_quality") {
    return ["Пришлите, пожалуйста, более качественное фото обратной стороны свидетельства о регистрации ТС."];
  }
  if (docs.id_front === "poor_quality") {
    return ["Пришлите, пожалуйста, более качественное фото лицевой стороны ID."];
  }
  if (docs.id_back === "poor_quality") {
    return ["Пришлите, пожалуйста, более качественное фото обратной стороны ID."];
  }
  return [];
}

function isWorkingDayText(value: string): boolean {
  const date = new Date(`${value}T12:00:00Z`);
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
}

function nextWorkingDateFrom(value: string): string {
  const next = new Date(`${value}T12:00:00Z`);
  do {
    next.setUTCDate(next.getUTCDate() + 1);
  } while (!isWorkingDayText(next.toISOString().slice(0, 10)));
  return next.toISOString().slice(0, 10);
}
