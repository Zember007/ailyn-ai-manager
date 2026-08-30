import { describe, expect, it } from "vitest";
import { calculateLoanLimits, evaluateApplication } from "./index.js";

describe("business rules", () => {
  it("calculates Bishkek/Chuy without-storage limit as min 40 percent and 600000", () => {
    expect(
      calculateLoanLimits({
        vehicleValue: 2_000_000,
        residenceRegion: "Бишкек"
      }).withoutStorage
    ).toBe(600_000);

    expect(
      calculateLoanLimits({
        vehicleValue: 1_000_000,
        residenceRegion: "Чуй"
      }).withoutStorage
    ).toBe(400_000);
  });

  it("calculates parking limit as min 50 percent and 2000000", () => {
    expect(calculateLoanLimits({ vehicleValue: 1_000_000 }).parking).toBe(500_000);
    expect(calculateLoanLimits({ vehicleValue: 6_000_000 }).parking).toBe(2_000_000);
  });

  it("refuses unsupported critical vehicle and ownership conditions deterministically", () => {
    expect(evaluateApplication({ vehicleType: "truck" }).rulesApplied).toContain("unsupported_vehicle_type");
    expect(evaluateApplication({ vehicleRegistrationRegion: "10" }).rulesApplied).toContain("region_10_refusal");
    expect(evaluateApplication({ vehicleInCredit: true }).rulesApplied).toContain("credit_or_pledge_refusal");
    expect(evaluateApplication({ ownerCanVisit: false }).rulesApplied).toContain("owner_presence_required");
  });

  it("does not save or calculate with a future vehicle year", () => {
    const result = evaluateApplication({ vehicleMake: "Toyota", vehicleModel: "Camry", vehicleYear: 2099 });

    expect(result.status).toBe("need_more_data");
    expect(result.rulesApplied).toContain("future_vehicle_year_correction");
    expect(result.requiredFacts).toEqual(["vehicleYear"]);
  });

  it("does not calculate a personal programme until programme and residence are both known", () => {
    const result = evaluateApplication({ vehicleMake: "Toyota", vehicleModel: "Camry", vehicleYear: 2021, vehicleValue: 1_500_000, requestedAmount: 500_000 });
    expect(result.requiredFacts).toEqual(["requestedProgram"]);
  });

  it("does not request documents again after the client declined to send them", () => {
    const result = evaluateApplication({ vehicleMake: "Toyota", vehicleModel: "Camry", vehicleYear: 2021, vehicleValue: 1_500_000, requestedAmount: 500_000, requestedProgram: "parking", residenceRegion: "Бишкек", declinedDocuments: true });
    expect(result.nextAction).toBe("collect_family_status");
    expect(result.requiredFacts).toEqual(["familyStatus"]);
  });

  it("requires residence before final regional limit decision", () => {
    const result = evaluateApplication({
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2021,
      vehicleValue: 1_500_000,
      requestedAmount: 400_000,
      requestedProgram: "without_storage"
    });

    expect(result.stage).toBe("COLLECTING_RESIDENCE");
    expect(result.rulesApplied).toContain("residence_before_regional_limits");
  });

  it("continues the other-region guarantor flow while preserving only the residence-policy conflict", () => {
    const result = evaluateApplication({
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2021,
      vehicleValue: 1_200_000,
      requestedAmount: 200_000,
      requestedProgram: "without_storage",
      residenceRegion: "Ош"
    });

    expect(result.status).toBe("need_more_data");
    expect(result.nextAction).toBe("check_guarantor");
    expect(result.blockedRules).toContain("SPEC_CONFLICT_C1");
    expect(result.requiredStatements.join(" ")).toContain("25");
  });

  it("flags loan amount below confirmed minimum", () => {
    const result = evaluateApplication({
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleValue: 900_000,
      requestedAmount: 30_000
    });

    expect(result.stage).toBe("COLLECTING_AMOUNT");
    expect(result.requiredStatements.join(" ")).toContain("50");
  });

  it("does not refuse a vehicle older than 15 years", () => {
    const result = evaluateApplication({
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2000,
      vehicleValue: 900_000,
      requestedAmount: 300_000,
      requestedProgram: "without_storage",
      residenceCategory: "BISHKEK",
      residenceRegion: "Бишкек"
    });

    expect(result.status).not.toBe("refuse");
    expect(result.rulesApplied).toContain("vehicle_older_than_15_individual_review");
    expect(result.requiredStatements.join(" ")).toContain("старше 15 лет");
  });

  it("offers parking when an other-region client has no guarantor", () => {
    const result = evaluateApplication({
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2021,
      vehicleValue: 1_200_000,
      requestedAmount: 200_000,
      requestedProgram: "without_storage",
      residenceCategory: "OTHER_KG",
      residenceRegion: "Ош",
      guarantorAvailable: false
    });

    expect(result.status).toBe("need_more_data");
    expect(result.requiredFacts).toEqual(["requestedProgram"]);
    expect(result.requiredStatements.join(" ")).toContain("стоянк");
  });

  it("hands off complete documents but keeps collecting family status", () => {
    const result = evaluateApplication({
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2021,
      vehicleValue: 1_200_000,
      requestedAmount: 200_000,
      requestedProgram: "parking",
      residenceCategory: "BISHKEK",
      residenceRegion: "Бишкек",
      documents: {
        id_front: "received",
        id_back: "received",
        vehicle_registration_front: "received",
        vehicle_registration_back: "received"
      }
    });

    expect(result.targetEvent).toBe("documents");
    expect(result.nextAction).toBe("collect_family_status");
    expect(result.requiredFacts).toEqual(["familyStatus"]);
  });

  it("does not schedule a visit before family status is known", () => {
    const result = evaluateApplication({
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2021,
      vehicleValue: 1_200_000,
      requestedAmount: 200_000,
      requestedProgram: "parking",
      residenceCategory: "BISHKEK",
      residenceRegion: "Бишкек",
      visitRequested: true
    });

    expect(result.nextAction).toBe("collect_family_status");
    expect(result.requiredFacts).toEqual(["familyStatus"]);
  });

  it("requires spouse consent before scheduling a visit with original documents", () => {
    const result = evaluateApplication({
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2021,
      vehicleValue: 1_200_000,
      requestedAmount: 200_000,
      requestedProgram: "parking",
      residenceCategory: "BISHKEK",
      residenceRegion: "Бишкек",
      declinedDocuments: true,
      familyStatus: "married",
      spouseConsentReady: false
    });

    expect(result.rulesApplied).toContain("spouse_consent_required");
    expect(result.nextAction).toBe("collect_family_status");
    expect(result.requiredFacts).toEqual(["spouseConsentReady"]);
  });
});
