import { calculateLoanLimits, defaultBusinessRuleSettings, type ApplicationFacts, type ApplicationStage, type BusinessRuleSettings, type LoanProgram } from "@ailyn/business-rules";
import type { AgentTurnResult } from "./agent-turn.contracts.js";
import type { Stage1Message } from "./stage1-store.service.js";

type DocumentCode = "id_front" | "id_back" | "vehicle_registration_front" | "vehicle_registration_back";
type ProgramFitStatus = "fits" | "does_not_fit" | "needs_more_data" | "individual_review";

const requiredDocuments: DocumentCode[] = ["id_front", "id_back", "vehicle_registration_front", "vehicle_registration_back"];

// This is an ordering guard, not a scripted conversation engine. Data sent by
// the client out of order is still accepted and persisted; the guard only
// prevents the model from proactively skipping unresolved prerequisites.
const stageOrder: ApplicationStage[] = [
  "NEW", "COLLECTING_VEHICLE", "COLLECTING_VALUE", "COLLECTING_AMOUNT", "ELIGIBILITY_CHECK", "COLLECTING_RESIDENCE", "CHECKING_GUARANTOR", "COLLECTING_DOCUMENTS", "COLLECTING_FAMILY_STATUS", "SCHEDULING_VISIT", "TARGET_REACHED_DOCUMENTS", "TARGET_REACHED_VISIT"
];

export interface ProgramOptionAssessment {
  program: LoanProgram;
  genericCap: number;
  personalLimit: number | null;
  maximumPossibleLimit: number | null;
  requestedAmount: number | null;
  requestFits: boolean | null;
  status: ProgramFitStatus;
  reason?: string;
}

export interface ProgramAssessment {
  selectedProgram: LoanProgram | null;
  vehicleValue: number | null;
  requestedAmount: number | null;
  withoutStorage: ProgramOptionAssessment;
  parking: ProgramOptionAssessment;
  selected: ProgramOptionAssessment | null;
}

export interface RuntimeGuardContext {
  programAssessment: ProgramAssessment;
  missingRequirement: { stage: ApplicationStage; fact: string; nextAction: string } | null;
  missingRequiredDocuments: DocumentCode[];
}

export function effectiveFactsForTurn(input: {
  previous: ApplicationFacts;
  modelPatch: Partial<ApplicationFacts>;
  explicitFacts: Partial<ApplicationFacts>;
  currencyFacts: Partial<ApplicationFacts>;
  attachmentFacts: Partial<ApplicationFacts>;
}): ApplicationFacts {
  return { ...input.previous, ...input.modelPatch, ...input.currencyFacts, ...input.attachmentFacts, ...input.explicitFacts };
}

export function attachmentFactsFromResult(previous: ApplicationFacts, attachments: AgentTurnResult["attachments"]): Partial<ApplicationFacts> {
  const documents = { ...(previous.documents ?? {}) };
  for (const attachment of attachments) {
    if (attachment.status !== "received") continue;
    if (attachment.type === "id_front" || attachment.type === "id_back" || attachment.type === "vehicle_registration_front" || attachment.type === "vehicle_registration_back") {
      documents[attachment.type] = "received";
    }
    if (attachment.type === "car") documents.car_photo = "received";
  }
  return Object.keys(documents).length ? { documents } : {};
}

/** Narrow context binding for facts that are unsafe to leave only to free-form model interpretation. */
export function contextualGuardFacts(input: { text?: string; messages: Stage1Message[] }): Partial<ApplicationFacts> {
  const text = input.text?.trim().toLocaleLowerCase("ru-RU");
  if (!text) return {};
  const lastAi = [...input.messages].reverse().find((message) => message.author === "ai")?.body.toLocaleLowerCase("ru-RU") ?? "";
  const shortRefusal = /^(?:нет|нету|не\s+могу|не\s+смогу|не\s+буду|не\s+хочу|не получится|не получится отправить)$/u.test(text);
  if (shortRefusal && /(?:2\s*[–-]?\s*3\s+)?(?:фото|фотограф)[^.!?]{0,80}(?:авто|автомоб|машин)|(?:авто|автомоб|машин)[^.!?]{0,80}(?:фото|фотограф)/u.test(lastAi)) {
    return { declinedCarPhoto: true };
  }
  return {};
}

export function buildProgramAssessment(facts: ApplicationFacts, settings: object): ProgramAssessment {
  const ruleSettings = mergedSettings(settings);
  const vehicleValue = facts.vehicleValue ?? null;
  const requestedAmount = facts.requestedAmount ?? null;
  const limits = calculateLoanLimits(facts, ruleSettings);
  const hasResidence = Boolean(facts.residenceRegion || facts.residenceCategory);
  const withoutStorageMaximumPossible = vehicleValue == null
    ? null
    : Math.min(Math.floor(vehicleValue * ruleSettings.withoutStoragePercent), ruleSettings.withoutStorageLimitBishkekChuy);
  const parkingLimit = vehicleValue == null ? null : limits.parking ?? null;
  const withoutStoragePersonal = hasResidence ? limits.withoutStorage ?? null : null;
  const olderThan15 = Boolean(facts.vehicleYear && ruleSettings.currentYear - facts.vehicleYear > 15);

  const withoutStorage = assessOption({
    program: "without_storage",
    genericCap: ruleSettings.withoutStorageLimitBishkekChuy,
    personalLimit: withoutStoragePersonal,
    maximumPossibleLimit: withoutStorageMaximumPossible,
    requestedAmount,
    needsResidence: !hasResidence,
    olderThan15
  });
  const parking = assessOption({
    program: "parking",
    genericCap: ruleSettings.parkingLimit,
    personalLimit: parkingLimit,
    maximumPossibleLimit: parkingLimit,
    requestedAmount,
    needsResidence: false,
    olderThan15: false
  });

  const selected = facts.requestedProgram === "without_storage"
    ? withoutStorage
    : facts.requestedProgram === "parking"
      ? parking
      : null;
  return { selectedProgram: facts.requestedProgram ?? null, vehicleValue, requestedAmount, withoutStorage, parking, selected };
}

export function buildRuntimeGuardContext(facts: ApplicationFacts, settings: object): RuntimeGuardContext {
  return {
    programAssessment: buildProgramAssessment(facts, settings),
    missingRequirement: firstMissingRequirement(facts, settings) ?? null,
    missingRequiredDocuments: requiredDocuments.filter((key) => facts.documents?.[key] !== "received")
  };
}

export function selectedProgramLimit(facts: ApplicationFacts, settings: object): number | null {
  if (!facts.requestedProgram || !facts.vehicleValue) return null;
  const limits = calculateLoanLimits(facts, mergedSettings(settings));
  if (facts.requestedProgram === "parking") return limits.parking ?? null;
  if (!facts.residenceRegion && !facts.residenceCategory) return null;
  return limits.withoutStorage ?? null;
}

export interface AgentTurnReconciliation {
  state: AgentTurnResult["dialogueState"];
  targetEvent: "documents" | "visit" | null;
  preliminaryLimit: number | null;
  semanticErrors: string[];
  corrections: string[];
}

export function reconcileAgentTurn(input: {
  effectiveFacts: ApplicationFacts;
  proposedState: AgentTurnResult["dialogueState"];
  proposedTargetEvent: AgentTurnResult["targetEvent"];
  proposedPreliminaryLimit: number | null | undefined;
  settings: object;
}): AgentTurnReconciliation {
  const missing = firstMissingRequirement(input.effectiveFacts, input.settings);
  const preliminaryLimit = selectedProgramLimit(input.effectiveFacts, input.settings);
  const semanticErrors: string[] = [];
  const corrections: string[] = [];
  let state = input.proposedState;

  if (missing && stageIndex(input.proposedState.stage) > stageIndex(missing.stage)) {
    semanticErrors.push(`stage_missing_required_fact:${missing.fact}:proposed:${input.proposedState.stage}:expected:${missing.stage}`);
    corrections.push(`stage_corrected:${input.proposedState.stage}->${missing.stage}`);
    state = { stage: missing.stage, status: "need_more_data", nextAction: missing.nextAction };
  }

  if (input.proposedPreliminaryLimit != null && preliminaryLimit != null && input.proposedPreliminaryLimit !== preliminaryLimit) {
    semanticErrors.push(`preliminary_limit_conflict:expected:${preliminaryLimit}:proposed:${input.proposedPreliminaryLimit}`);
  }

  const documentsReady = requiredDocuments.every((key) => input.effectiveFacts.documents?.[key] === "received");
  const visitReady = Boolean(input.effectiveFacts.visitDate && input.effectiveFacts.visitTime) && !firstBlockingVisitRequirement(input.effectiveFacts);
  const targetEvent = visitReady ? "visit" : documentsReady ? "documents" : null;
  if (input.proposedTargetEvent === "documents" && targetEvent === null) {
    corrections.push("target_event_cleared:documents_not_reached");
  } else if (input.proposedTargetEvent && input.proposedTargetEvent !== targetEvent) {
    semanticErrors.push(`invalid_target_event:${input.proposedTargetEvent}`);
  }

  return { state, targetEvent, preliminaryLimit, semanticErrors, corrections };
}

function assessOption(input: {
  program: LoanProgram;
  genericCap: number;
  personalLimit: number | null;
  maximumPossibleLimit: number | null;
  requestedAmount: number | null;
  needsResidence: boolean;
  olderThan15: boolean;
}): ProgramOptionAssessment {
  const base = {
    program: input.program,
    genericCap: input.genericCap,
    personalLimit: input.personalLimit,
    maximumPossibleLimit: input.maximumPossibleLimit,
    requestedAmount: input.requestedAmount
  };
  if (input.requestedAmount == null || input.maximumPossibleLimit == null) {
    return { ...base, requestFits: null, status: "needs_more_data", reason: "amount_or_vehicle_value_missing" };
  }
  if (input.requestedAmount > input.maximumPossibleLimit) {
    return { ...base, requestFits: false, status: "does_not_fit", reason: "requested_amount_exceeds_maximum_possible_limit" };
  }
  if (input.personalLimit != null && input.requestedAmount > input.personalLimit) {
    return { ...base, requestFits: false, status: "does_not_fit", reason: "requested_amount_exceeds_personal_limit" };
  }
  if (input.needsResidence) {
    return { ...base, requestFits: null, status: "needs_more_data", reason: "residence_required_for_exact_limit" };
  }
  if (input.personalLimit == null) {
    return { ...base, requestFits: false, status: "does_not_fit", reason: "program_unavailable_for_current_facts" };
  }
  if (input.olderThan15 && input.program === "without_storage") {
    return { ...base, requestFits: true, status: "individual_review", reason: "vehicle_older_than_15_individual_review" };
  }
  return { ...base, requestFits: true, status: "fits" };
}

function firstMissingRequirement(facts: ApplicationFacts, settings: object): { stage: ApplicationStage; fact: string; nextAction: string } | undefined {
  if ((!facts.vehicleMake && !facts.vehicleModel) || !facts.vehicleYear) return { stage: "COLLECTING_VEHICLE", fact: !facts.vehicleYear ? "vehicleYear" : "vehicleMake", nextAction: "collect_vehicle" };
  if (facts.vehicleValue === undefined) return { stage: "COLLECTING_VALUE", fact: "vehicleValue", nextAction: "collect_value" };
  if (facts.requestedAmount === undefined) return { stage: "COLLECTING_AMOUNT", fact: "requestedAmount", nextAction: "collect_amount" };
  if (!facts.requestedProgram) return { stage: "ELIGIBILITY_CHECK", fact: "requestedProgram", nextAction: "collect_program" };

  const assessment = buildProgramAssessment(facts, settings).selected;
  if (assessment?.status === "does_not_fit") {
    return { stage: "ELIGIBILITY_CHECK", fact: "requestedProgramCompatibility", nextAction: "resolve_program_mismatch" };
  }

  if (!facts.residenceRegion && !facts.residenceCategory) return { stage: "COLLECTING_RESIDENCE", fact: "residenceRegion", nextAction: "collect_residence" };

  const assessedWithResidence = buildProgramAssessment(facts, settings).selected;
  if (assessedWithResidence?.status === "does_not_fit") {
    return { stage: "ELIGIBILITY_CHECK", fact: "requestedProgramCompatibility", nextAction: "resolve_program_mismatch" };
  }

  if (requiresGuarantor(facts) && facts.guarantorAvailable === undefined) return { stage: "CHECKING_GUARANTOR", fact: "guarantorAvailable", nextAction: "check_guarantor" };

  if (!facts.declinedDocuments) {
    const document = requiredDocuments.find((key) => facts.documents?.[key] !== "received");
    if (document) return { stage: "COLLECTING_DOCUMENTS", fact: document, nextAction: "collect_documents" };
  }

  if (!facts.familyStatus || facts.familyStatus === "unknown") return { stage: "COLLECTING_FAMILY_STATUS", fact: "familyStatus", nextAction: "collect_family_status" };
  if (facts.familyStatus === "married" && facts.spouseConsentReady !== true) return { stage: "COLLECTING_FAMILY_STATUS", fact: "spouseConsentReady", nextAction: "collect_spouse_consent" };
  if (!facts.visitDate || !facts.visitTime) return { stage: "SCHEDULING_VISIT", fact: !facts.visitDate ? "visitDate" : "visitTime", nextAction: "schedule_visit" };
  return undefined;
}

function firstBlockingVisitRequirement(facts: ApplicationFacts): string | undefined {
  if (!facts.familyStatus || facts.familyStatus === "unknown") return "familyStatus";
  if (facts.familyStatus === "married" && facts.spouseConsentReady !== true) return "spouseConsentReady";
  return undefined;
}

function requiresGuarantor(facts: ApplicationFacts): boolean {
  return facts.requestedProgram === "without_storage" && facts.residenceCategory === "OTHER_KG";
}

function mergedSettings(settings: object): BusinessRuleSettings {
  return { ...defaultBusinessRuleSettings, ...(settings as Partial<BusinessRuleSettings>) };
}

function stageIndex(stage: ApplicationStage): number {
  const index = stageOrder.indexOf(stage);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}
