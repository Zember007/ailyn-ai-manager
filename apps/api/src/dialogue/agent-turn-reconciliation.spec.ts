import { describe, expect, it } from "vitest";
import { deriveStageCompletion, effectiveFactsForTurn, selectedProgramLimit } from "./agent-turn-reconciliation.js";

describe("agent turn reconciliation pricing", () => {
  it("keeps the exact parking maximum for selected-program state", () => {
    const facts = {
      vehicleValue: 1_748_982,
      requestedProgram: "parking" as const,
      residenceRegion: "Токмок"
    };

    expect(selectedProgramLimit(facts, {})).toBe(870_000);
  });

  it("does not create a selected limit for unavailable without-storage pricing", () => {
    const facts = {
      vehicleValue: 999_999,
      requestedProgram: "without_storage" as const,
      residenceRegion: "Ош"
    };

    expect(selectedProgramLimit(facts, {})).toBeNull();
  });

  it("canonicalizes Tokmok over a stale other-region category", () => {
    const facts = effectiveFactsForTurn({
      previous: { residenceCategory: "OTHER_KG", residenceRegion: "Другой регион Кыргызстана" },
      modelPatch: { residenceRegion: "Токмок" },
      explicitFacts: {},
      currencyFacts: {},
      attachmentFacts: {}
    });

    expect(facts).toMatchObject({
      residenceRegion: "Чуйская область",
      residenceCategory: "BISHKEK_CHUY",
      residenceNeedsClarification: false
    });
  });

  it("normalizes a misspelled Cholpon-Ata residence into the other-Kyrgyzstan category", () => {
    const facts = effectiveFactsForTurn({
      previous: {},
      modelPatch: { residenceText: "чтолпон ата" },
      explicitFacts: {},
      currencyFacts: {},
      attachmentFacts: {}
    });

    expect(facts).toMatchObject({
      residenceText: "чтолпон ата",
      residenceRegion: "Другой регион Кыргызстана",
      residenceCategory: "OTHER_KG",
      residenceNeedsClarification: false
    });
  });

  it("normalizes a preposition-prefixed misspelled Cholpon-Ata residence", () => {
    const facts = effectiveFactsForTurn({
      previous: {},
      modelPatch: { residenceText: "В чтолпон ата" },
      explicitFacts: {}, currencyFacts: {}, attachmentFacts: {}
    });

    expect(facts).toMatchObject({
      residenceRegion: "Другой регион Кыргызстана",
      residenceCategory: "OTHER_KG",
      residenceNeedsClarification: false
    });
  });

  it("derives progress flags from facts instead of accepting a model-declared stage", () => {
    const facts = effectiveFactsForTurn({
      previous: {},
      modelPatch: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000,
        requestedAmount: 500_000, requestedProgram: "parking",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY"
      },
      explicitFacts: {}, currencyFacts: {}, attachmentFacts: {}
    });

    expect(deriveStageCompletion(facts)).toMatchObject({
      vehicle: true, requestedAmount: true, program: true, residence: true,
      guarantor: true, documents: false, readyForVisit: false, visit: false
    });
  });

  it("resets the amount stage and every dependent stage when a new preference invalidates amount and programme", () => {
    const facts = effectiveFactsForTurn({
      previous: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single"
      },
      modelPatch: { requestedMaximumAmount: true, requestedAmount: undefined, requestedProgram: undefined },
      explicitFacts: {}, currencyFacts: {}, attachmentFacts: {}
    });

    expect(deriveStageCompletion(facts)).toMatchObject({
      vehicle: true, requestedAmount: false, program: false, residence: false,
      guarantor: false, documents: false, carPhoto: false, family: false,
      readyForVisit: false, visit: false
    });
  });
});
