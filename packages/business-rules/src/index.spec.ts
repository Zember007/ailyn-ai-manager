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

    expect(result.status).toBe("refuse");
    expect(result.rulesApplied).toContain("future_vehicle_year");
  });

  it("requires residence before final regional limit decision", () => {
    const result = evaluateApplication({
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2021,
      vehicleValue: 1_500_000,
      requestedAmount: 400_000
    });

    expect(result.stage).toBe("COLLECTING_RESIDENCE");
    expect(result.rulesApplied).toContain("residence_before_regional_limits");
  });

  it("marks other-region guarantor requirements as blocked when exact approved data is absent", () => {
    const result = evaluateApplication({
      vehicleMake: "Toyota",
      vehicleModel: "Camry",
      vehicleYear: 2021,
      vehicleValue: 1_200_000,
      requestedAmount: 200_000,
      requestedProgram: "without_storage",
      residenceRegion: "Ош"
    });

    expect(result.status).toBe("blocked");
    expect(result.blockedRules).toContain("guarantor_requirements");
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
});
