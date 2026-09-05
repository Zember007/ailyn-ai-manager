import { resolveKyrgyzstanLocality, type ApplicationFacts } from "@ailyn/business-rules";
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
  }
  for (const key of ["vehicleValue", "requestedAmount"] as const) {
    if (typeof result[key] === "number") result[key] = roundSomAmount(result[key]);
  }
  return result;
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
