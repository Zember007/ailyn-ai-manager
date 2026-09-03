import { calculateLoanLimits, defaultBusinessRuleSettings, type ApplicationFacts, type ApplicationStage, type BusinessRuleSettings } from "@ailyn/business-rules";
import type { AgentTurnResult } from "./agent-turn.contracts.js";

type DocumentCode = "id_front" | "id_back" | "vehicle_registration_front" | "vehicle_registration_back";

const requiredDocuments: DocumentCode[] = ["id_front", "id_back", "vehicle_registration_front", "vehicle_registration_back"];

const stageOrder: ApplicationStage[] = [
  "NEW", "COLLECTING_VEHICLE", "COLLECTING_VALUE", "COLLECTING_AMOUNT", "ELIGIBILITY_CHECK", "COLLECTING_RESIDENCE", "COLLECTING_DOCUMENTS", "COLLECTING_FAMILY_STATUS", "CHECKING_GUARANTOR", "SCHEDULING_VISIT", "TARGET_REACHED_DOCUMENTS", "TARGET_REACHED_VISIT"
];

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

export function selectedProgramLimit(facts: ApplicationFacts, settings: object): number | null {
  return programComparison(facts, settings)?.selectedLimit ?? null;
}

export interface ProgramComparison {
  selectedProgram: "without_storage" | "parking";
  selectedLimit: number;
  requestedAmount?: number;
  requestedAmountExceedsSelectedLimit: boolean;
  alternative?: { program: "without_storage" | "parking"; limit: number; coversRequestedAmount: boolean };
}

export function programComparison(facts: ApplicationFacts, settings: object): ProgramComparison | undefined {
  if (!facts.requestedProgram || !facts.residenceRegion) return undefined;
  const limits = calculateLoanLimits(facts, { ...defaultBusinessRuleSettings, ...(settings as Partial<BusinessRuleSettings>) });
  const selectedLimit = facts.requestedProgram === "without_storage" ? limits.withoutStorage : limits.parking;
  if (selectedLimit === undefined) return undefined;
  const alternativeProgram = facts.requestedProgram === "without_storage" ? "parking" : "without_storage";
  const alternativeLimit = alternativeProgram === "without_storage" ? limits.withoutStorage : limits.parking;
  const requestedAmountExceedsSelectedLimit = typeof facts.requestedAmount === "number" && facts.requestedAmount > selectedLimit;
  return {
    selectedProgram: facts.requestedProgram,
    selectedLimit,
    requestedAmount: facts.requestedAmount,
    requestedAmountExceedsSelectedLimit,
    ...(alternativeLimit === undefined ? {} : { alternative: { program: alternativeProgram, limit: alternativeLimit, coversRequestedAmount: typeof facts.requestedAmount === "number" && facts.requestedAmount <= alternativeLimit } })
  };
}

export interface AgentTurnReconciliation {
  state: AgentTurnResult["dialogueState"];
  targetEvent: "documents" | "visit" | null;
  preliminaryLimit: number | null;
  programComparison?: ProgramComparison;
  pendingRequirement?: { stage: ApplicationStage; fact: string; nextAction: string };
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
  const missing = firstMissingRequirement(input.effectiveFacts);
  const programComparisonResult = programComparison(input.effectiveFacts, input.settings);
  const preliminaryLimit = programComparisonResult?.selectedLimit ?? null;
  const semanticErrors: string[] = [];
  const corrections: string[] = [];
  let state = input.proposedState;

  if (missing && stageIndex(input.proposedState.stage) > stageIndex(missing.stage)) {
    semanticErrors.push(`invalid_stage_transition:${input.proposedState.stage}:missing:${missing.fact}`);
    corrections.push(`stage_corrected:${input.proposedState.stage}->${missing.stage}`);
    state = { stage: missing.stage, status: "need_more_data", nextAction: missing.nextAction };
  }

  if (programComparisonResult?.requestedAmountExceedsSelectedLimit) {
    corrections.push("program_limit_reconciled:offer_alternative_or_reduced_amount");
    // The specification explicitly continues the application after a suitable
    // parking alternative is offered, unless the client later refuses it.
    state = programComparisonResult.alternative?.coversRequestedAmount
      ? { stage: "COLLECTING_DOCUMENTS", status: "need_more_data", nextAction: "collect_documents" }
      : { stage: "ELIGIBILITY_CHECK", status: "need_more_data", nextAction: "confirm_reduced_amount" };
  }

  if (input.proposedPreliminaryLimit != null && preliminaryLimit != null && input.proposedPreliminaryLimit !== preliminaryLimit) {
    semanticErrors.push("preliminary_limit_conflict");
  }

  const documentsReady = requiredDocuments.every((key) => input.effectiveFacts.documents?.[key] === "received");
  const visitReady = documentsReady && Boolean(input.effectiveFacts.visitDate && input.effectiveFacts.visitTime);
  const targetEvent = visitReady ? "visit" : documentsReady ? "documents" : null;
  // `documents` can mean "request these next" in the model response, while
  // the persisted event means that all document sides have been received.
  if (input.proposedTargetEvent === "documents" && targetEvent === null) {
    corrections.push("target_event_cleared:documents_not_reached");
  } else if (input.proposedTargetEvent && input.proposedTargetEvent !== targetEvent) {
    semanticErrors.push(`invalid_target_event:${input.proposedTargetEvent}`);
  }

  return { state, targetEvent, preliminaryLimit, programComparison: programComparisonResult, ...(missing ? { pendingRequirement: missing } : {}), semanticErrors, corrections };
}

function firstMissingRequirement(facts: ApplicationFacts): { stage: ApplicationStage; fact: string; nextAction: string } | undefined {
  if ((!facts.vehicleMake && !facts.vehicleModel) || !facts.vehicleYear) return { stage: "COLLECTING_VEHICLE", fact: !facts.vehicleYear ? "vehicleYear" : "vehicleMake", nextAction: "collect_vehicle" };
  if (facts.vehicleValue === undefined) return { stage: "COLLECTING_VALUE", fact: "vehicleValue", nextAction: "collect_value" };
  if (facts.requestedAmount === undefined) return { stage: "COLLECTING_AMOUNT", fact: "requestedAmount", nextAction: "collect_amount" };
  if (!facts.requestedProgram) return { stage: "ELIGIBILITY_CHECK", fact: "requestedProgram", nextAction: "collect_program" };
  if (!facts.residenceRegion) return { stage: "COLLECTING_RESIDENCE", fact: "residenceRegion", nextAction: "collect_residence" };
  const document = requiredDocuments.find((key) => facts.documents?.[key] !== "received");
  if (document) return { stage: "COLLECTING_DOCUMENTS", fact: document, nextAction: "collect_documents" };
  if (!facts.familyStatus || facts.familyStatus === "unknown") return { stage: "COLLECTING_FAMILY_STATUS", fact: "familyStatus", nextAction: "collect_family_status" };
  // A refusal is a resolved answer, not a missing fact. The client can
  // arrange the consent with the building's notary during the visit.
  if (facts.familyStatus === "married" && facts.spouseConsentReady === undefined) return { stage: "COLLECTING_FAMILY_STATUS", fact: "spouseConsentReady", nextAction: "collect_spouse_consent" };
  if (requiresGuarantor(facts) && facts.guarantorAvailable === undefined) return { stage: "CHECKING_GUARANTOR", fact: "guarantorAvailable", nextAction: "check_guarantor" };
  if (!facts.visitDate || !facts.visitTime) return { stage: "SCHEDULING_VISIT", fact: !facts.visitDate ? "visitDate" : "visitTime", nextAction: "schedule_visit" };
  return undefined;
}

function requiresGuarantor(facts: ApplicationFacts): boolean {
  return facts.requestedProgram === "without_storage" && facts.residenceCategory === "OTHER_KG";
}

function stageIndex(stage: ApplicationStage): number {
  const index = stageOrder.indexOf(stage);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}
