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
  if (!facts.requestedProgram || !facts.residenceRegion) return null;
  const limits = calculateLoanLimits(facts, { ...defaultBusinessRuleSettings, ...(settings as Partial<BusinessRuleSettings>) });
  return facts.requestedProgram === "without_storage" ? limits.withoutStorage ?? null : limits.parking ?? null;
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
  const missing = firstMissingRequirement(input.effectiveFacts);
  const preliminaryLimit = selectedProgramLimit(input.effectiveFacts, input.settings);
  const semanticErrors: string[] = [];
  const corrections: string[] = [];
  let state = input.proposedState;

  if (missing && stageIndex(input.proposedState.stage) > stageIndex(missing.stage)) {
    semanticErrors.push(`invalid_stage_transition:${input.proposedState.stage}:missing:${missing.fact}`);
    corrections.push(`stage_corrected:${input.proposedState.stage}->${missing.stage}`);
    state = { stage: missing.stage, status: "need_more_data", nextAction: missing.nextAction };
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

  return { state, targetEvent, preliminaryLimit, semanticErrors, corrections };
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
  if (facts.familyStatus === "married" && facts.spouseConsentReady !== true) return { stage: "COLLECTING_FAMILY_STATUS", fact: "spouseConsentReady", nextAction: "collect_spouse_consent" };
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
