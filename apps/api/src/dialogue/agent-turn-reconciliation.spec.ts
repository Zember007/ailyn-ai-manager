import { describe, expect, it } from "vitest";
import {
  buildProgramAssessment,
  contextualGuardFacts,
  reconcileAgentTurn
} from "./agent-turn-reconciliation.js";

describe("agent turn reconciliation guards", () => {
  it("distinguishes the generic parking cap from the personal parking limit", () => {
    const assessment = buildProgramAssessment({
      vehicleValue: 1_900_000,
      requestedAmount: 650_000,
      requestedProgram: "parking",
      residenceRegion: "Другой регион Кыргызстана",
      residenceCategory: "OTHER_KG"
    }, {});

    expect(assessment.parking.genericCap).toBe(2_000_000);
    expect(assessment.parking.personalLimit).toBe(950_000);
    expect(assessment.parking.requestFits).toBe(true);
    expect(assessment.parking.status).toBe("fits");
    expect(assessment.selected?.personalLimit).toBe(950_000);
  });

  it("pre-screens without-storage when the requested amount exceeds its maximum possible limit", () => {
    const assessment = buildProgramAssessment({
      vehicleValue: 1_749_000,
      requestedAmount: 699_600
    }, {});

    expect(assessment.withoutStorage.maximumPossibleLimit).toBe(600_000);
    expect(assessment.withoutStorage.requestFits).toBe(false);
    expect(assessment.withoutStorage.status).toBe("does_not_fit");
  });

  it("uses the regional personal limit after residence is known", () => {
    const assessment = buildProgramAssessment({
      vehicleValue: 1_900_000,
      requestedAmount: 650_000,
      requestedProgram: "without_storage",
      residenceRegion: "Бостери",
      residenceCategory: "OTHER_KG"
    }, {});

    expect(assessment.withoutStorage.personalLimit).toBe(200_000);
    expect(assessment.withoutStorage.requestFits).toBe(false);
    expect(assessment.selected?.status).toBe("does_not_fit");
  });

  it("reports the deterministic expected limit in a preliminary-limit conflict", () => {
    const result = reconcileAgentTurn({
      effectiveFacts: {
        vehicleMake: "Omoda",
        vehicleYear: 2009,
        vehicleValue: 1_900_000,
        requestedAmount: 650_000,
        requestedProgram: "parking",
        residenceRegion: "Бостери",
        residenceCategory: "OTHER_KG"
      },
      proposedState: { stage: "COLLECTING_DOCUMENTS", status: "continue", nextAction: "request_documents" },
      proposedTargetEvent: null,
      proposedPreliminaryLimit: 2_000_000,
      settings: {}
    });

    expect(result.preliminaryLimit).toBe(950_000);
    expect(result.semanticErrors).toContain("preliminary_limit_conflict:expected:950000:proposed:2000000");
  });

  it("does not allow a proactive document stage to skip residence", () => {
    const result = reconcileAgentTurn({
      effectiveFacts: {
        vehicleMake: "Toyota",
        vehicleYear: 2022,
        vehicleValue: 1_749_000,
        requestedAmount: 500_000,
        requestedProgram: "without_storage"
      },
      proposedState: { stage: "COLLECTING_DOCUMENTS", status: "continue", nextAction: "request_documents" },
      proposedTargetEvent: null,
      proposedPreliminaryLimit: null,
      settings: {}
    });

    expect(result.state.stage).toBe("COLLECTING_RESIDENCE");
    expect(result.semanticErrors).toContain("stage_missing_required_fact:residenceRegion:proposed:COLLECTING_DOCUMENTS:expected:COLLECTING_RESIDENCE");
  });

  it("does not allow visit scheduling to skip family status after documents", () => {
    const result = reconcileAgentTurn({
      effectiveFacts: {
        vehicleMake: "Toyota",
        vehicleYear: 2022,
        vehicleValue: 1_749_000,
        requestedAmount: 500_000,
        requestedProgram: "parking",
        residenceRegion: "Бишкек",
        residenceCategory: "BISHKEK",
        documents: {
          id_front: "received",
          id_back: "received",
          vehicle_registration_front: "received",
          vehicle_registration_back: "received"
        }
      },
      proposedState: { stage: "SCHEDULING_VISIT", status: "continue", nextAction: "schedule_visit" },
      proposedTargetEvent: null,
      proposedPreliminaryLimit: 874_500,
      settings: {}
    });

    expect(result.state.stage).toBe("COLLECTING_FAMILY_STATUS");
    expect(result.semanticErrors).toContain("stage_missing_required_fact:familyStatus:proposed:SCHEDULING_VISIT:expected:COLLECTING_FAMILY_STATUS");
  });

  it("binds a short refusal to an optional car-photo request", () => {
    const facts = contextualGuardFacts({
      text: "нет",
      messages: [{ author: "ai", body: "Если есть возможность, пожалуйста, отправьте также 2–3 фотографии автомобиля.", createdAt: "now" } as any]
    });

    expect(facts.declinedCarPhoto).toBe(true);
    expect(facts.declinedDocuments).toBeUndefined();
  });
});
