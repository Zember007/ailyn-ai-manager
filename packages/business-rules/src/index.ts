export type BusinessRuleStatus =
  | "continue"
  | "refuse"
  | "need_more_data"
  | "redirect_existing_contract"
  | "target_reached"
  | "blocked";

export type LoanProgram = "without_storage" | "parking";

export type NextActionCode =
  | "answer_questions"
  | "collect_vehicle"
  | "collect_value"
  | "collect_amount"
  | "collect_residence"
  | "collect_documents"
  | "collect_family_status"
  | "check_guarantor"
  | "schedule_visit"
  | "redirect_existing_contract"
  | "refuse"
  | "pause"
  | "target_reached";

export type ResidenceCategory = "BISHKEK" | "CHUY" | "OTHER_KG" | "FOREIGN";

export type ApplicationStage =
  | "NEW"
  | "COLLECTING_VEHICLE"
  | "COLLECTING_VALUE"
  | "COLLECTING_AMOUNT"
  | "COLLECTING_RESIDENCE"
  | "ELIGIBILITY_CHECK"
  | "COLLECTING_DOCUMENTS"
  | "COLLECTING_FAMILY_STATUS"
  | "CHECKING_GUARANTOR"
  | "SCHEDULING_VISIT"
  | "TARGET_REACHED_DOCUMENTS"
  | "TARGET_REACHED_VISIT"
  | "REFUSED"
  | "PAUSED"
  | "EXISTING_CONTRACT_REDIRECT";

export interface ApplicationFacts {
  language?: "ru" | "kg" | "mixed" | "unknown";
  fullName?: string;
  phone?: string;
  citizenship?: string;
  residenceRegion?: string;
  vehicleRegistrationCountry?: string;
  vehicleRegistrationRegion?: string;
  vehicleType?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleYear?: number;
  vehicleValue?: number;
  requestedAmount?: number;
  requestedProgram?: LoanProgram;
  ownerChanged?: boolean;
  plateChanged?: boolean;
  ownerIsLegalEntity?: boolean;
  borrowerIsLegalEntity?: boolean;
  vehicleInCredit?: boolean;
  vehiclePledged?: boolean;
  vehicleArrested?: boolean;
  registrationRestricted?: boolean;
  refinancingRequested?: boolean;
  buyoutRequested?: boolean;
  accidentNotDrivable?: boolean;
  foreignTravelQuestion?: boolean;
  existingContractQuestion?: boolean;
  existingContractPaymentMessage?: boolean;
  borrowerIsOwner?: boolean;
  ownerCanVisit?: boolean;
  familyStatus?: "married" | "single" | "divorced" | "unknown";
  vehicleBoughtDuringMarriage?: boolean;
  spouseConsentReady?: boolean;
  spouseAway?: boolean;
  guarantorAvailable?: boolean;
  documents?: Partial<Record<DocumentCode, DocumentStatus>>;
  visitRequested?: boolean;
  visitDate?: string;
  visitTime?: string;
  clientPaused?: boolean;
  clientClosed?: boolean;
  declinedDocuments?: boolean;
  declinedCarPhoto?: boolean;
  ownerFullName?: string;
  ownerResidenceRegion?: string;
  ownerFamilyStatus?: "married" | "single" | "divorced" | "unknown";
  vehiclePurchasedDuringMarriage?: boolean;
  divorceCertificateReady?: boolean;
  visitConfirmationPending?: boolean;
  handedToManager?: boolean;
}

export type DocumentCode =
  | "id_front"
  | "id_back"
  | "vehicle_registration_front"
  | "vehicle_registration_back"
  | "car_photo"
  | "unknown";

export type DocumentStatus = "missing" | "received" | "poor_quality" | "blocked";

export interface BusinessRuleSettings {
  currentYear: number;
  withoutStoragePercent: number;
  parkingPercent: number;
  withoutStorageLimitBishkekChuy: number;
  withoutStorageLimitOtherRegion: number;
  parkingLimit: number;
  minimumLoan: number;
  otherRegionMinVehicleValue: number;
  latestArrivalTime: string;
  workingDays: number[];
  blockedRules?: string[];
}

export interface DecisionResult {
  status: BusinessRuleStatus;
  stage: ApplicationStage;
  rulesApplied: string[];
  eligiblePrograms: LoanProgram[];
  calculatedLimits: {
    withoutStorage?: number;
    parking?: number;
  };
  refusalReason?: string;
  requiredFacts: (keyof ApplicationFacts | DocumentCode)[];
  nextAction: NextActionCode;
  requiredStatements: string[];
  forbiddenStatements: string[];
  blockedRules: string[];
  residenceCategory?: ResidenceCategory;
  targetEvent?: "documents" | "visit";
}

export const defaultBusinessRuleSettings: BusinessRuleSettings = {
  currentYear: new Date().getFullYear(),
  withoutStoragePercent: 0.4,
  parkingPercent: 0.5,
  withoutStorageLimitBishkekChuy: 600_000,
  withoutStorageLimitOtherRegion: 200_000,
  parkingLimit: 2_000_000,
  minimumLoan: 50_000,
  otherRegionMinVehicleValue: 1_000_000,
  latestArrivalTime: "18:00",
  workingDays: [1, 2, 3, 4, 5],
  blockedRules: [
    "guarantor_requirements",
    "parking_interest_rate",
    "foreign_currency_rate_source",
    "kg_holidays"
  ]
};

const supportedVehicleTypes = new Set(["car", "passenger_car", "minivan"]);
const bishkekChuy = new Set(["bishkek", "chuy", "чуй", "чуйская область", "бишкек"]);

export function evaluateApplication(
  facts: ApplicationFacts,
  settings: BusinessRuleSettings = defaultBusinessRuleSettings
): DecisionResult {
  const rulesApplied: string[] = [];
  const forbiddenStatements = [
    "окончательно одобрено",
    "гарантированно одобрено",
    "можно оформить по доверенности",
    "рефинансирование возможно",
    "выкупим займ",
    "можно свободно выезжать за границу"
  ];
  const blockedRules: string[] = [];

  const refusal = firstRefusal(facts, settings, rulesApplied);
  if (refusal) {
    return {
      status: "refuse",
      stage: "REFUSED",
      rulesApplied,
      eligiblePrograms: [],
      calculatedLimits: {},
      refusalReason: refusal,
      requiredFacts: [],
      nextAction: "refuse",
      requiredStatements: [refusal],
      forbiddenStatements,
      blockedRules
    };
  }

  if (facts.existingContractQuestion || facts.existingContractPaymentMessage) {
    rulesApplied.push("existing_contract_redirect");
    return {
      status: "redirect_existing_contract",
      stage: "EXISTING_CONTRACT_REDIRECT",
      rulesApplied,
      eligiblePrograms: [],
      calculatedLimits: {},
      requiredFacts: [],
      nextAction: "redirect_existing_contract",
      requiredStatements: ["По действующему договору нужно обратиться к сотрудникам компании."],
      forbiddenStatements,
      blockedRules
    };
  }

  if (facts.clientPaused || facts.clientClosed) {
    rulesApplied.push("conversation_paused");
    return {
      status: "target_reached",
      stage: "PAUSED",
      rulesApplied,
      eligiblePrograms: [],
      calculatedLimits: {},
      requiredFacts: [],
      nextAction: "pause",
      requiredStatements: ["Сохранить заявку и историю."],
      forbiddenStatements,
      blockedRules
    };
  }

  const calculatedLimits = calculateLoanLimits(facts, settings);
  const eligiblePrograms = determineAvailablePrograms(facts, settings, blockedRules);

  if (facts.vehicleYear !== undefined && facts.vehicleYear > settings.currentYear) {
    rulesApplied.push("future_vehicle_year_correction");
    return needMore("COLLECTING_VEHICLE", "collect_vehicle", ["vehicleYear"], rulesApplied, [], {}, [
      `Подскажите, пожалуйста, Вы, возможно, допустили опечатку. Автомобиля ${facts.vehicleYear} года выпуска пока не существует. Напишите, пожалуйста, правильный год выпуска автомобиля.`
    ], forbiddenStatements, blockedRules);
  }

  if (facts.requestedAmount !== undefined && facts.requestedAmount < settings.minimumLoan) {
    rulesApplied.push("minimum_loan");
    return needMore("COLLECTING_AMOUNT", "collect_amount", ["requestedAmount"], rulesApplied, eligiblePrograms, calculatedLimits, [
      `Минимальная сумма займа — ${settings.minimumLoan} сом.`
    ], forbiddenStatements, blockedRules);
  }

  if (!facts.vehicleMake && !facts.vehicleModel) {
    return needMore("COLLECTING_VEHICLE", "collect_vehicle", ["vehicleMake", "vehicleModel", "vehicleYear"], rulesApplied, eligiblePrograms, calculatedLimits, [], forbiddenStatements, blockedRules);
  }

  if (!facts.vehicleValue) {
    return needMore("COLLECTING_VALUE", "collect_value", ["vehicleValue"], rulesApplied, eligiblePrograms, calculatedLimits, [], forbiddenStatements, blockedRules);
  }

  if (!facts.requestedAmount) {
    return needMore("COLLECTING_AMOUNT", "collect_amount", ["requestedAmount"], rulesApplied, eligiblePrograms, calculatedLimits, [], forbiddenStatements, blockedRules);
  }

  if (!facts.requestedProgram) {
    return needMore("ELIGIBILITY_CHECK", "collect_residence", ["requestedProgram"], rulesApplied, [], {}, [], forbiddenStatements, blockedRules);
  }

  if (!facts.residenceRegion) {
    rulesApplied.push("residence_before_regional_limits");
    return needMore("COLLECTING_RESIDENCE", "collect_residence", ["residenceRegion"], rulesApplied, eligiblePrograms, calculatedLimits, [], forbiddenStatements, blockedRules);
  }

  if (needsGuarantor(facts, settings)) {
    rulesApplied.push("other_region_guarantor");
    blockedRules.push("guarantor_requirements");
    return {
      status: "blocked",
      stage: "CHECKING_GUARANTOR",
      rulesApplied,
      eligiblePrograms,
      calculatedLimits,
      requiredFacts: ["guarantorAvailable"],
      nextAction: "check_guarantor",
      requiredStatements: ["Требования к поручителю не подтверждены."],
      forbiddenStatements,
      blockedRules
    };
  }

  const missingDocuments = getMissingDocuments(facts);
  if (missingDocuments.length > 0 && !facts.visitRequested && !facts.declinedDocuments) {
    return needMore("COLLECTING_DOCUMENTS", "collect_documents", missingDocuments, rulesApplied, eligiblePrograms, calculatedLimits, [
      "Попросить только недостающие документы."
    ], forbiddenStatements, blockedRules);
  }

  if (missingDocuments.length > 0 && facts.declinedDocuments && !facts.visitRequested) {
    rulesApplied.push("documents_declined_originals_on_visit");
    return needMore("SCHEDULING_VISIT", "schedule_visit", ["visitDate", "visitTime"], rulesApplied, eligiblePrograms, calculatedLimits, [
      "Оригиналы документов нужно взять с собой на визит."
    ], forbiddenStatements, blockedRules);
  }

  if (facts.familyStatus === "married" && facts.spouseConsentReady !== true) {
    rulesApplied.push("spouse_consent_required");
    return needMore("COLLECTING_FAMILY_STATUS", "collect_family_status", ["spouseConsentReady"], rulesApplied, eligiblePrograms, calculatedLimits, [
      "Для визита потребуется оригинал нотариального согласия супруга или супруги."
    ], forbiddenStatements, blockedRules);
  }

  if (facts.visitRequested && (!facts.visitDate || !facts.visitTime)) {
    return needMore("SCHEDULING_VISIT", "schedule_visit", facts.visitDate ? ["visitTime"] : ["visitDate", "visitTime"], rulesApplied, eligiblePrograms, calculatedLimits, [
      "Для оформления нужно приехать не позднее 18:00."
    ], forbiddenStatements, blockedRules);
  }

  if (facts.familyStatus === "divorced" && facts.vehicleBoughtDuringMarriage && facts.divorceCertificateReady !== true) {
    rulesApplied.push("divorce_certificate_required");
    return needMore("COLLECTING_FAMILY_STATUS", "collect_family_status", ["divorceCertificateReady"], rulesApplied, eligiblePrograms, calculatedLimits, [
      "Для визита потребуется оригинал свидетельства о разводе."
    ], forbiddenStatements, blockedRules);
  }

  if (facts.visitDate && facts.visitTime) {
    rulesApplied.push("target_reached_visit");
    return {
      status: "target_reached",
      stage: "TARGET_REACHED_VISIT",
      rulesApplied,
      eligiblePrograms,
      calculatedLimits,
      requiredFacts: [],
      nextAction: "target_reached",
      requiredStatements: ["Предварительная запись; менеджер подтвердит визит."],
      forbiddenStatements,
      blockedRules,
      residenceCategory: categorizeResidence(facts.residenceRegion),
      targetEvent: "visit"
    };
  }

  rulesApplied.push("target_reached_documents");
  return {
    status: "target_reached",
    stage: "TARGET_REACHED_DOCUMENTS",
    rulesApplied,
    eligiblePrograms,
    calculatedLimits,
    requiredFacts: [],
    nextAction: "target_reached",
    requiredStatements: ["Карточка готова по полученным документам."],
    forbiddenStatements,
    blockedRules,
    residenceCategory: categorizeResidence(facts.residenceRegion),
    targetEvent: "documents"
  };
}

export function calculateLoanLimits(
  facts: ApplicationFacts,
  settings: BusinessRuleSettings = defaultBusinessRuleSettings
): DecisionResult["calculatedLimits"] {
  if (!facts.vehicleValue) {
    return {};
  }

  const parking = Math.min(Math.floor(facts.vehicleValue * settings.parkingPercent), settings.parkingLimit);
  const residence = normalize(facts.residenceRegion);
  const withoutStorageRegionalLimit = bishkekChuy.has(residence)
    ? settings.withoutStorageLimitBishkekChuy
    : settings.withoutStorageLimitOtherRegion;
  const withoutStorageAllowed =
    residence === "" || bishkekChuy.has(residence) || facts.vehicleValue >= settings.otherRegionMinVehicleValue;
  const withoutStorage = withoutStorageAllowed
    ? Math.min(Math.floor(facts.vehicleValue * settings.withoutStoragePercent), withoutStorageRegionalLimit)
    : undefined;

  return { withoutStorage, parking };
}

export function determineAvailablePrograms(
  facts: ApplicationFacts,
  settings: BusinessRuleSettings = defaultBusinessRuleSettings,
  blockedRules: string[] = []
): LoanProgram[] {
  const programs: LoanProgram[] = ["parking"];
  const residence = normalize(facts.residenceRegion);
  if (!facts.vehicleValue || residence === "" || bishkekChuy.has(residence)) {
    programs.unshift("without_storage");
    return programs;
  }
  if (facts.vehicleValue >= settings.otherRegionMinVehicleValue) {
    if (!blockedRules.includes("guarantor_requirements")) {
      blockedRules.push("guarantor_requirements");
    }
    programs.unshift("without_storage");
  }
  return programs;
}

export function evaluateRefusalReasons(
  facts: ApplicationFacts,
  settings: BusinessRuleSettings = defaultBusinessRuleSettings
): string[] {
  const rulesApplied: string[] = [];
  const reason = firstRefusal(facts, settings, rulesApplied);
  return reason ? [reason] : [];
}

function firstRefusal(
  facts: ApplicationFacts,
  settings: BusinessRuleSettings,
  rulesApplied: string[]
): string | undefined {
  if (facts.vehicleType && !supportedVehicleTypes.has(normalize(facts.vehicleType))) {
    rulesApplied.push("unsupported_vehicle_type");
    return "Компания оформляет займы только под легковые автомобили и минивэны.";
  }
  if (normalize(facts.vehicleRegistrationRegion) === "10") {
    rulesApplied.push("region_10_refusal");
    return "По автомобилям с регионом 10 компания займ не оформляет.";
  }
  if (facts.vehicleRegistrationCountry && normalize(facts.vehicleRegistrationCountry) !== "kg" && normalize(facts.vehicleRegistrationCountry) !== "кр" && normalize(facts.vehicleRegistrationCountry) !== "кыргызстан") {
    rulesApplied.push("foreign_vehicle_registration");
    return "Автомобиль должен быть зарегистрирован в Кыргызской Республике.";
  }
  if (facts.citizenship && normalize(facts.citizenship) !== "kg" && normalize(facts.citizenship) !== "кр" && normalize(facts.citizenship) !== "кыргызстан") {
    rulesApplied.push("foreign_citizen");
    return "Займ оформляется только гражданам Кыргызской Республики.";
  }
  if (facts.ownerIsLegalEntity || facts.borrowerIsLegalEntity) {
    rulesApplied.push("legal_entity_refusal");
    return "Займ оформляется только на физическое лицо.";
  }
  if (facts.vehicleInCredit || facts.vehiclePledged) {
    rulesApplied.push("credit_or_pledge_refusal");
    return "Если автомобиль в кредите или залоге, оформить займ нельзя.";
  }
  if (facts.vehicleArrested || facts.registrationRestricted) {
    rulesApplied.push("arrest_or_restriction_refusal");
    return "При аресте или ограничениях регистрационных действий оформить займ нельзя.";
  }
  if (facts.refinancingRequested) {
    rulesApplied.push("refinancing_refusal");
    return "Компания не занимается рефинансированием.";
  }
  if (facts.buyoutRequested) {
    rulesApplied.push("buyout_refusal");
    return "Компания не выкупает займы из других автоломбардов.";
  }
  if (facts.vehicleYear && settings.currentYear - facts.vehicleYear > 15) {
    rulesApplied.push("vehicle_older_than_15");
    return "Для автомобиля старше 15 лет по общему правилу возможен вариант со стоянкой; без изъятия только индивидуальное рассмотрение.";
  }
  if (facts.accidentNotDrivable) {
    rulesApplied.push("accident_not_drivable");
    return "Автомобиль после серьезного ДТП и не на ходу не принимается как подходящий залог.";
  }
  if (facts.ownerCanVisit === false) {
    rulesApplied.push("owner_presence_required");
    return "Собственник автомобиля должен присутствовать лично; по доверенности оформить займ нельзя.";
  }
  return undefined;
}

export function categorizeResidence(value: string | undefined): ResidenceCategory | undefined {
  const residence = normalize(value);
  if (!residence) return undefined;
  if (residence.includes("бишкек") || residence === "bishkek") return "BISHKEK";
  if (bishkekChuy.has(residence) || residence.includes("чуй")) return "CHUY";
  if (["foreign", "иностран", "зарубеж"].some((token) => residence.includes(token))) return "FOREIGN";
  return "OTHER_KG";
}

function needMore(
  stage: ApplicationStage,
  nextAction: NextActionCode,
  requiredFacts: (keyof ApplicationFacts | DocumentCode)[],
  rulesApplied: string[],
  eligiblePrograms: LoanProgram[],
  calculatedLimits: DecisionResult["calculatedLimits"],
  requiredStatements: string[],
  forbiddenStatements: string[],
  blockedRules: string[]
): DecisionResult {
  return {
    status: "need_more_data",
    stage,
    rulesApplied,
    eligiblePrograms,
    calculatedLimits,
    requiredFacts,
    nextAction,
    requiredStatements,
    forbiddenStatements,
    blockedRules
  };
}

function getMissingDocuments(facts: ApplicationFacts): DocumentCode[] {
  const docs = facts.documents ?? {};
  return (["id_front", "id_back", "vehicle_registration_front", "vehicle_registration_back"] as DocumentCode[]).filter(
    (doc) => docs[doc] !== "received"
  );
}

function needsGuarantor(facts: ApplicationFacts, settings: BusinessRuleSettings): boolean {
  const residence = normalize(facts.residenceRegion);
  return Boolean(
    residence &&
      !bishkekChuy.has(residence) &&
      facts.vehicleValue &&
      facts.vehicleValue >= settings.otherRegionMinVehicleValue &&
      facts.requestedProgram === "without_storage" &&
      facts.guarantorAvailable !== true
  );
}

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}
