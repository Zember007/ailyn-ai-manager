import { resolveKyrgyzstanLocality, type ApplicationFacts, type StageCompletion } from "@ailyn/business-rules";
import type { AgentTurnResult } from "./agent-turn.contracts.js";
import { calculateLoanPricing, type LoanPricingSettings } from "./loan-pricing.js";
import { roundSomAmount } from "./money-normalization.js";

export function effectiveFactsForTurn(input: {
  previous: ApplicationFacts;
  modelPatch: Partial<ApplicationFacts>;
  explicitFacts: Partial<ApplicationFacts>;
  currencyFacts: Partial<ApplicationFacts>;
  attachmentFacts: Partial<ApplicationFacts>;
}): ApplicationFacts {
  const merged = { ...input.previous, ...input.modelPatch, ...input.currencyFacts, ...input.attachmentFacts, ...input.explicitFacts };
  // `documents` is an inventory, not a replaceable snapshot. A model patch
  // frequently contains only the sides it sees in the current message; keep
  // all sides accepted earlier in the conversation as well.
  const documents = {
    ...(input.previous.documents ?? {}),
    ...(input.modelPatch.documents ?? {}),
    ...(input.currencyFacts.documents ?? {}),
    ...(input.attachmentFacts.documents ?? {}),
    ...(input.explicitFacts.documents ?? {})
  };
  const result = Object.keys(documents).length > 0 ? { ...merged, documents } : merged;
  // A locality detected in the current client turn is authoritative over a
  // stale generic category from an earlier model response. Without this,
  // "Токмок" can coexist with OTHER_KG and incorrectly open the guarantor
  // branch on the next turn.
  const currentResidence = input.explicitFacts.residenceText
    ?? input.explicitFacts.residenceRegion
    ?? input.modelPatch.residenceText
    ?? input.modelPatch.residenceRegion
    ?? result.residenceText
    ?? result.residenceRegion;
  const resolvedResidence = resolveKyrgyzstanLocality(currentResidence);
  if (resolvedResidence) {
    result.residenceRegion = resolvedResidence.residenceRegion;
    result.residenceCategory = resolvedResidence.category;
    result.residenceNeedsClarification = false;
  } else {
    // An explicit «это не в Чуйской» correction deliberately clears the old
    // locality while setting OTHER_KG. Do not restore that stale locality
    // below: it would immediately reclassify the client back to Chuy/Bishkek.
    const explicitlyClearedOtherResidence = input.modelPatch.residenceText === undefined
      && input.modelPatch.residenceRegion === "Другой регион Кыргызстана"
      && input.modelPatch.residenceCategory === "OTHER_KG"
      && input.modelPatch.residenceNeedsClarification === false;
    // A binary reply such as «нет» must not replace an already canonical
    // residence with an unresolvable text fragment. Explicit residence
    // corrections are admitted before this boundary; this is the last line
    // of defence against a stale model patch reopening a completed stage.
    const previousResidence = resolveKyrgyzstanLocality(input.previous.residenceText ?? input.previous.residenceRegion);
    if (!explicitlyClearedOtherResidence && previousResidence && input.previous.residenceRegion && input.previous.residenceCategory) {
      result.residenceText = input.previous.residenceText ?? previousResidence.locality;
      result.residenceRegion = input.previous.residenceRegion;
      result.residenceCategory = input.previous.residenceCategory;
    }
  }
  if (result.residenceRegion && result.residenceCategory) result.residenceNeedsClarification = false;
  for (const key of ["vehicleValue", "requestedAmount"] as const) {
    if (typeof result[key] === "number") result[key] = roundSomAmount(result[key]);
  }
  return result;
}

/**
 * Stage completion is a derived validation result, never a sticky workflow
 * cursor.  Each call evaluates the current card from scratch, so a correction
 * first invalidates the affected stage and only marks it complete again when
 * it still satisfies the current programme and limit rules.
 */
export function deriveStageCompletion(facts: ApplicationFacts, settings: LoanPricingSettings = {}): StageCompletion {
  const vehicle = Boolean(facts.vehicleModel && facts.vehicleYear && facts.vehicleValue !== undefined);
  const requestedAmountProvided = vehicle && facts.requestedAmount !== undefined;
  const programSelected = requestedAmountProvided && facts.requestedProgram !== undefined;
  const program = programSelected;
  const residence = program && Boolean(facts.residenceRegion && facts.residenceCategory);
  const selectedPricing = residence && facts.requestedProgram
    ? (facts.requestedProgram === "without_storage"
      ? calculateLoanPricing(facts, settings).withoutStorage
      : calculateLoanPricing(facts, settings).parking)
    : undefined;
  // Before locality/programme data is sufficient for a calculation, an
  // amount remains collected but unverified. Once the server can calculate a
  // limit, an over-limit amount deliberately reopens this stage.
  const requestedAmount = requestedAmountProvided
    && (!selectedPricing || (selectedPricing.available && typeof selectedPricing.publicMax === "number" && facts.requestedAmount! <= selectedPricing.publicMax));
  const guarantorRequired = residence && facts.requestedProgram === "without_storage" && facts.residenceCategory === "OTHER_KG";
  const guarantor = residence && (!guarantorRequired || facts.guarantorAvailable === true);
  const documents = guarantor && (facts.documentsProvided === true || facts.declinedDocuments === true);
  const carPhoto = documents && (facts.documents?.car_photo === "received" || facts.declinedCarPhoto === true);
  const family = carPhoto && Boolean(facts.familyStatus && facts.familyStatus !== "unknown") && (facts.familyStatus !== "married" || facts.spouseConsentReady === true || facts.spouseConsentAtOffice !== undefined) && (facts.familyStatus !== "divorced" || facts.vehicleBoughtDuringMarriage !== undefined);
  const readyForVisit = family;
  const visit = readyForVisit && Boolean(facts.visitDate && facts.visitTime);
  return { vehicle, requestedAmount, program, residence, guarantor, documents, carPhoto, family, readyForVisit, visit };
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
  if (!facts.requestedProgram) return null;
  const pricing = calculateLoanPricing(facts, settings as LoanPricingSettings);
  const selectedPricing = facts.requestedProgram === "without_storage" ? pricing.withoutStorage : pricing.parking;
  // Persistence and client output use the same public ten-thousand rounding.
  return selectedPricing.available ? selectedPricing.publicMax : null;
}
