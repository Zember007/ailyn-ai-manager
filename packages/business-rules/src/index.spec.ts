import { describe, expect, it } from "vitest";
import { calculateLoanLimits, evaluateApplication, normalizeKyrgyzstanLocality, resolveKyrgyzstanLocality } from "./index.js";

describe("business rules", () => {
  it.each([
    ["Токмок", "BISHKEK_CHUY", "Чуйская область"],
    ["Кант", "BISHKEK_CHUY", "Чуйская область"],
    ["Кара-Балта", "BISHKEK_CHUY", "Чуйская область"],
    ["Шопоков", "BISHKEK_CHUY", "Чуйская область"],
    ["Кемин", "BISHKEK_CHUY", "Чуйская область"],
    ["Орловка", "BISHKEK_CHUY", "Чуйская область"],
    ["Каинды", "BISHKEK_CHUY", "Чуйская область"],
    ["Ош", "OTHER_KG", "Другой регион Кыргызстана"],
    ["Каракол", "OTHER_KG", "Другой регион Кыргызстана"],
    ["Нарын", "OTHER_KG", "Другой регион Кыргызстана"],
    ["Талас", "OTHER_KG", "Другой регион Кыргызстана"],
    ["Манас", "OTHER_KG", "Другой регион Кыргызстана"],
    ["Джалал-Абад", "OTHER_KG", "Другой регион Кыргызстана"],
    ["Раззаков", "OTHER_KG", "Другой регион Кыргызстана"],
    ["Исфана", "OTHER_KG", "Другой регион Кыргызстана"],
    ["в такмоке", "BISHKEK_CHUY", "Чуйская область"],
    ["tokmok", "BISHKEK_CHUY", "Чуйская область"],
    ["Сокулук", "BISHKEK_CHUY", "Чуйская область"],
    ["Беловодское", "BISHKEK_CHUY", "Чуйская область"],
    ["Лебединовка", "BISHKEK_CHUY", "Чуйская область"]
    ,["Бостери", "OTHER_KG", "Другой регион Кыргызстана"]
  ])("resolves %s from the SOATE locality index", (locality, category, region) => {
    expect(resolveKyrgyzstanLocality(locality)).toMatchObject({ category, residenceRegion: region });
  });

  it.each([
    ["чалупон ата", "Чолпон-Ата", "OTHER_KG", "typo"],
    ["в Чолпон-Ате", "Чолпон-Ата", "OTHER_KG", "typo"],
    ["cholpon ata", "Чолпон-Ата", "OTHER_KG", "transliteration"],
    ["Бостеры", "Бостери", "OTHER_KG", "typo"],
    ["Джалалабад", "Джалал-Абад", "OTHER_KG", "typo"],
    ["Иссык-Кульская область", "Иссык-Кульская область", "OTHER_KG", "exact"]
  ])("normalizes %s to the canonical server locality", (input, locality, category, match) => {
    expect(normalizeKyrgyzstanLocality(input)).toBe(locality);
    expect(resolveKyrgyzstanLocality(input)).toMatchObject({ locality, category, match });
  });

  it.each([
    ["Аламудунский район", "BISHKEK_CHUY"],
    ["Свердловский район Бишкек", "BISHKEK_CHUY"],
    ["Тюпский район", "OTHER_KG"],
    ["Чаткальский район", "OTHER_KG"],
    ["Кадамжайский район", "OTHER_KG"],
    ["Чон-Алайский район", "OTHER_KG"],
    ["Бакай-Атинский район", "OTHER_KG"]
  ])("resolves canonical administrative registration locality %s", (locality, category) => {
    expect(resolveKyrgyzstanLocality(locality)).toMatchObject({ locality, category, match: "exact" });
  });

  it("uses the Chuy limit for Tokmok and never calculates before residence is resolved", () => {
    expect(calculateLoanLimits({ vehicleValue: 1_748_976, residenceRegion: "Токмок" })).toEqual({ withoutStorage: 600_000, parking: 874_488 });
    expect(calculateLoanLimits({ vehicleValue: 1_748_976, residenceRegion: "непонятный посёлок" })).toEqual({});
  });

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
    expect(calculateLoanLimits({ vehicleValue: 1_000_000, residenceRegion: "Бишкек" }).parking).toBe(500_000);
    expect(calculateLoanLimits({ vehicleValue: 6_000_000, residenceRegion: "Бишкек" }).parking).toBe(2_000_000);
  });

  it("refuses unsupported critical vehicle and ownership conditions deterministically", () => {
    expect(evaluateApplication({ vehicleType: "truck" }).rulesApplied).toContain("unsupported_vehicle_type");
    expect(evaluateApplication({ vehicleRegistrationRegion: "10" }).rulesApplied).toContain("region_10_refusal");
    expect(evaluateApplication({ vehicleInCredit: true }).rulesApplied).toContain("credit_or_pledge_refusal");
    expect(evaluateApplication({ ownerCanVisit: false }).rulesApplied).toContain("owner_presence_required");
    expect(evaluateApplication({ vehicleInCredit: true }).refusalReason).toBe("К сожалению, такой автомобиль мы принять в залог не можем.");
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

  it("continues after any uploaded document even when the individual sides are unknown", () => {
    const result = evaluateApplication({
      vehicleMake: "Toyota", vehicleModel: "Camry", vehicleYear: 2021,
      vehicleValue: 1_500_000, requestedAmount: 500_000, requestedProgram: "parking",
      residenceRegion: "Бишкек", documentsProvided: true,
      documents: { unknown: "received" }
    });

    expect(result.targetEvent).toBe("documents");
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
      residenceCategory: "BISHKEK_CHUY",
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
      residenceCategory: "BISHKEK_CHUY",
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
      residenceCategory: "BISHKEK_CHUY",
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
      residenceCategory: "BISHKEK_CHUY",
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
