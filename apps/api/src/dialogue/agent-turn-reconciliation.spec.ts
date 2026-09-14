import { describe, expect, it } from "vitest";
import { attachmentFactsForCurrentStage, deriveStageCompletion, effectiveFactsForTurn, selectedProgramLimit } from "./agent-turn-reconciliation.js";

describe("agent turn reconciliation pricing", () => {
  it("keeps any future vehicle year out of the completed vehicle stage", () => {
    const facts = effectiveFactsForTurn({
      previous: {},
      modelPatch: { vehicleModel: "Li 9", vehicleYear: 2031, vehicleValue: 6_000_000 },
      explicitFacts: {},
      currencyFacts: {},
      attachmentFacts: {}
    });

    expect(facts.vehicleYear).toBeUndefined();
    expect(facts.reportedInvalidVehicleYear).toBe(2031);
    expect(deriveStageCompletion(facts).vehicle).toBe(false);
  });

  it("replaces a previously rejected future year with a later valid correction", () => {
    const facts = effectiveFactsForTurn({
      previous: { vehicleModel: "Camry", reportedInvalidVehicleYear: 2029 },
      modelPatch: { vehicleYear: 2020 },
      explicitFacts: {},
      currencyFacts: {},
      attachmentFacts: {}
    });

    expect(facts.vehicleYear).toBe(2020);
    expect(facts.reportedInvalidVehicleYear).toBeNull();
  });

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

  it("keeps a canonical residence closed when a later binary reply is not a locality", () => {
    const facts = effectiveFactsForTurn({
      previous: {
        residenceText: "Бишкек", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        residenceNeedsClarification: true
      },
      modelPatch: { residenceText: "нет", residenceNeedsClarification: true },
      explicitFacts: {}, currencyFacts: {}, attachmentFacts: {}
    });

    expect(facts).toMatchObject({
      residenceText: "Бишкек", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
      residenceNeedsClarification: false
    });
    expect(deriveStageCompletion({
      ...facts,
      vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
      requestedAmount: 600_000, requestedProgram: "without_storage",
      declinedDocuments: true
    })).toMatchObject({ residence: true, guarantor: true, documents: true });
  });

  it("completes the car-photo stage for any upload after its prompt, even when vision returns unknown", () => {
    const previous = {
      vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000,
      requestedAmount: 600_000, requestedProgram: "without_storage",
      residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY", documentsProvided: true
    } as const;
    const attachmentFacts = attachmentFactsForCurrentStage({
      previous,
      attachments: [{ attachmentId: "photo", type: "unknown", status: "received" }],
      inboundAttachmentCount: 1,
      lastAssistantReply: "Пожалуйста, отправьте 2–3 фотографии автомобиля."
    });
    const facts = effectiveFactsForTurn({ previous, modelPatch: {}, explicitFacts: {}, currencyFacts: {}, attachmentFacts });

    expect(facts.documents).toMatchObject({ car_photo: "received" });
    expect(deriveStageCompletion(facts)).toMatchObject({ documents: true, carPhoto: true });
  });

  it("resets the amount stage and every dependent stage when the amount changes", () => {
    const facts = effectiveFactsForTurn({
      previous: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000,
        requestedAmount: 200_000, requestedProgram: "without_storage",
        residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        documentsProvided: true, documents: { car_photo: "received" }, familyStatus: "single"
      },
      modelPatch: { requestedAmount: undefined, requestedProgram: undefined },
      explicitFacts: {}, currencyFacts: {}, attachmentFacts: {}
    });

    expect(deriveStageCompletion(facts)).toMatchObject({
      vehicle: true, requestedAmount: false, program: false, residence: false,
      guarantor: false, documents: false, carPhoto: false, family: false,
      readyForVisit: false, visit: false
    });
  });

  it("reopens the amount stage and invalidates dependent stages when the current programme limit is exceeded", () => {
    const completion = deriveStageCompletion({
      vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 2_000_000,
      requestedAmount: 2_000_000, requestedProgram: "parking",
      residenceText: "Ош", residenceRegion: "Другой регион Кыргызстана", residenceCategory: "OTHER_KG",
      documentsProvided: true, declinedCarPhoto: true, familyStatus: "single", visitDate: "2026-09-15", visitTime: "17:00"
    } as any);

    expect(completion).toMatchObject({
      vehicle: true, requestedAmount: false, program: true, residence: true,
      guarantor: false, documents: false, carPhoto: false, family: false,
      readyForVisit: false, visit: false
    });
  });
});
