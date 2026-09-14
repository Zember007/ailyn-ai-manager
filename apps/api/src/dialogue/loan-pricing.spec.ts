import { describe, expect, it } from "vitest";
import { calculateLoanPricing } from "./loan-pricing.js";

describe("calculateLoanPricing", () => {
  it("uses the authoritative rates, caps, and public ten-thousand rounding", () => {
    const pricing = calculateLoanPricing({
      vehicleValue: 1_999_999,
      residenceRegion: "Бишкек"
    });

    expect(pricing.minimumLoan).toBe(50_000);
    expect(pricing.clientFacingMaximumField).toBe("publicMax");
    expect(pricing.withoutStorage).toEqual({ available: true, rawMax: 600_000, publicMax: 600_000 });
    expect(pricing.parking).toMatchObject({ available: true, rawMax: 999_999.5, publicMax: 990_000, monthlyRate: 2.4, dailyParkingFee: 130 });
    expect(pricing.parking.publicMax).toBeLessThanOrEqual(pricing.parking.rawMax!);
  });

  it("calculates the regional without-storage cap below one million outside Bishkek and Chuy", () => {
    const pricing = calculateLoanPricing({ vehicleValue: 999_999, residenceRegion: "Ош" });

    expect(pricing.residence).toEqual({ category: "OTHER_KG", residenceRegion: "Другой регион Кыргызстана" });
    expect(pricing.withoutStorage).toEqual({ available: true, rawMax: 200_000, publicMax: 200_000 });
    expect(pricing.parking).toMatchObject({ available: true, rawMax: 499_999.5, publicMax: 490_000 });
  });

  it("resolves Tokmok and supports the existing canonical residence fields", () => {
    expect(calculateLoanPricing({ vehicleValue: 1_000_000, residenceText: "Токмок" }).residence)
      .toEqual({ category: "BISHKEK_CHUY", residenceRegion: "Чуйская область" });
    expect(calculateLoanPricing({ vehicleValue: 1_000_000, residenceCategory: "OTHER_KG", residenceRegion: "Другой регион Кыргызстана" }).withoutStorage)
      .toEqual({ available: true, rawMax: 200_000, publicMax: 200_000 });
  });

  it("does not fabricate a Bishkek-Chuy residence from a foreign or unresolved persisted region", () => {
    const pricing = calculateLoanPricing({
      vehicleValue: 1_000_000,
      residenceCategory: "BISHKEK_CHUY",
      residenceRegion: "Алматы"
    });

    expect(pricing.residence).toBeUndefined();
    expect(pricing.withoutStorage).toEqual({ available: false, rawMax: null, publicMax: null, reason: "residence_unknown" });
    expect(pricing.parking).toMatchObject({ available: false, rawMax: null, publicMax: null, reason: "residence_unknown" });
  });

  it("keeps an exact maximum while flooring the client-facing maximum", () => {
    const pricing = calculateLoanPricing({ vehicleValue: 1_748_982, residenceRegion: "Бишкек" });

    expect(pricing.parking).toMatchObject({ rawMax: 874_491, publicMax: 870_000 });
  });

  it("keeps approved parking rate and daily fee despite attempted settings overrides", () => {
    const facts = { vehicleValue: 1_000_000, residenceRegion: "Бишкек" };

    expect(calculateLoanPricing(facts, {
      parkingInterestRate: { value: 1.8, blocked: false },
      parkingDailyFee: { value: 95, blocked: false }
    } as any).parking).toMatchObject({ monthlyRate: 2.4, dailyParkingFee: 130 });
    expect(calculateLoanPricing(facts, {
      parkingInterestRate: { value: 1.8, blocked: true },
      parkingDailyFee: { value: 95, blocked: true }
    } as any).parking).toMatchObject({ monthlyRate: 2.4, dailyParkingFee: 130 });
  });
});
