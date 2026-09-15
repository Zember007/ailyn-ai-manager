import { resolveKyrgyzstanLocality, type ApplicationFacts, type ResidenceCategory } from "@ailyn/business-rules";

const PUBLIC_LIMIT_STEP = 10_000;
export const MINIMUM_VEHICLE_VALUE = 300_000;
type LoanResidenceCategory = Exclude<ResidenceCategory, "FOREIGN">;

export type LoanPricingSettings = Partial<{
  withoutStoragePercent: number;
  parkingPercent: number;
  withoutStorageLimitBishkekChuy: number;
  withoutStorageLimitOtherRegion: number;
  parkingLimit: number;
  minimumLoan: number;
  otherRegionMinVehicleValue: number;
}>;

export type LoanPricing = {
  minimumLoan: number;
  /** The agent must name only publicMax in a client-facing reply. */
  clientFacingMaximumField: "publicMax";
  residence?: { category: LoanResidenceCategory; residenceRegion: string };
  withoutStorage: {
    available: boolean;
    /** Exact calculated maximum, retained for deterministic server logic. */
    rawMax: number | null;
    /** Client-safe maximum, rounded down to the nearest 10,000 KGS. */
    publicMax: number | null;
    reason?: "residence_unknown" | "vehicle_value_unknown" | "vehicle_value_below_minimum" | "vehicle_value_below_other_region_minimum" | "calculated_limit_below_minimum";
  };
  parking: {
    available: boolean;
    /** Exact calculated maximum, retained for deterministic server logic. */
    rawMax: number | null;
    /** Client-safe maximum, rounded down to the nearest 10,000 KGS. */
    publicMax: number | null;
    monthlyRate: number;
    dailyParkingFee: number;
    reason?: "residence_unknown" | "vehicle_value_unknown" | "vehicle_value_below_minimum" | "calculated_limit_below_minimum";
  };
};

/**
 * Returns only the deterministic, client-facing pricing facts. Dialogue
 * interpretation and stage selection remain the responsibility of the agent.
 */
export function calculateLoanPricing(facts: ApplicationFacts, settings: LoanPricingSettings = {}): LoanPricing {
  const residence = resolveResidence(facts);
  const minimumLoan = numberSetting(settings.minimumLoan, 50_000);
  const value = positiveFinite(facts.vehicleValue);

  const unavailableParking: LoanPricing["parking"] = {
    available: false,
    rawMax: null,
    publicMax: null,
    monthlyRate: 2.4,
    dailyParkingFee: 130,
    reason: "residence_unknown"
  };

  if (!residence || !value) {
    const reason = !residence ? "residence_unknown" as const : "vehicle_value_unknown" as const;
    return {
      minimumLoan,
      clientFacingMaximumField: "publicMax",
      ...(residence ? { residence } : {}),
      withoutStorage: { available: false, rawMax: null, publicMax: null, reason },
      parking: { ...unavailableParking, reason }
    };
  }

  // A public maximum rounded to zero is never a valid offer. Cars below this
  // collateral floor are refused before programme calculations begin.
  if (value < MINIMUM_VEHICLE_VALUE) {
    return {
      minimumLoan,
      clientFacingMaximumField: "publicMax",
      residence,
      withoutStorage: { available: false, rawMax: null, publicMax: null, reason: "vehicle_value_below_minimum" },
      parking: { ...unavailableParking, reason: "vehicle_value_below_minimum" }
    };
  }

  const parkingRawMax = Math.min(value * numberSetting(settings.parkingPercent, 0.5), numberSetting(settings.parkingLimit, 2_000_000));
  // Both programmes receive a calculated range once vehicle value and
  // residence are known. The regional cap, rather than a second minimum
  // vehicle-value gate, determines the without-storage limit.
  const withoutStorageRawMax = Math.min(
    value * numberSetting(settings.withoutStoragePercent, 0.4),
    numberSetting(
      residence.category === "BISHKEK_CHUY" ? settings.withoutStorageLimitBishkekChuy : settings.withoutStorageLimitOtherRegion,
      residence.category === "BISHKEK_CHUY" ? 600_000 : 200_000
    )
  );

  const withoutStoragePublicMax = publicMaximum(withoutStorageRawMax);
  const parkingPublicMax = publicMaximum(parkingRawMax);
  const unavailableCalculatedLimit = (): { available: false; rawMax: null; publicMax: null; reason: "calculated_limit_below_minimum" } => ({
    // Keep the raw value out of the client payload as well: no branch may
    // turn a zero or below-minimum amount into a visible offer.
    available: false, rawMax: null, publicMax: null, reason: "calculated_limit_below_minimum"
  });
  return {
    minimumLoan,
    clientFacingMaximumField: "publicMax",
    residence,
    withoutStorage: withoutStoragePublicMax >= minimumLoan
      ? { available: true, rawMax: withoutStorageRawMax, publicMax: withoutStoragePublicMax }
      : unavailableCalculatedLimit(),
    parking: parkingPublicMax >= minimumLoan
      ? { available: true, rawMax: parkingRawMax, publicMax: parkingPublicMax, monthlyRate: 2.4, dailyParkingFee: 130 }
      : { ...unavailableCalculatedLimit(), monthlyRate: 2.4, dailyParkingFee: 130 }
  };
}

/**
 * Ranges shown in response to a general maximum/minimum question. They use
 * the same percentage and public rounding as pricing, but do not decide
 * whether a later application may select that programme. Eligibility remains
 * the responsibility of `calculateLoanPricing` and the workflow gates.
 */
export function calculateLoanRangeDisplayMaximums(facts: ApplicationFacts, settings: LoanPricingSettings = {}): {
  withoutStorage: number | null;
  parking: number | null;
} {
  const residence = resolveResidence(facts);
  const value = positiveFinite(facts.vehicleValue);
  if (!residence || !value || value < MINIMUM_VEHICLE_VALUE) return { withoutStorage: null, parking: null };
  const withoutStorageRawMax = Math.min(
    value * numberSetting(settings.withoutStoragePercent, 0.4),
    numberSetting(
      residence.category === "BISHKEK_CHUY" ? settings.withoutStorageLimitBishkekChuy : settings.withoutStorageLimitOtherRegion,
      residence.category === "BISHKEK_CHUY" ? 600_000 : 200_000
    )
  );
  const parkingRawMax = Math.min(
    value * numberSetting(settings.parkingPercent, 0.5),
    numberSetting(settings.parkingLimit, 2_000_000)
  );
  return {
    withoutStorage: publicMaximum(withoutStorageRawMax),
    parking: publicMaximum(parkingRawMax)
  };
}

function resolveResidence(facts: ApplicationFacts): LoanPricing["residence"] | undefined {
  // Resolve actual locality text first: "Токмок" must not be treated as an
  // unstructured model label. Persisted canonical fields remain valid fallback
  // for conversations created before locality resolution was introduced.
  const resolved = resolveKyrgyzstanLocality(facts.residenceText) ?? resolveKyrgyzstanLocality(facts.residenceRegion);
  if (resolved) return { category: resolved.category, residenceRegion: resolved.residenceRegion };
  const persistedRegion = facts.residenceRegion?.trim();
  // A persisted category from an older conversation is a valid fallback only
  // when its paired region is empty or already one of that category's
  // canonical labels. Do not turn an unrecognised (including foreign) region
  // into Bishkek or another Kyrgyzstan region merely because of a stale label.
  if (facts.residenceCategory === "BISHKEK_CHUY" && (!persistedRegion || persistedRegion === "Бишкек" || persistedRegion === "Чуйская область")) {
    return { category: "BISHKEK_CHUY", residenceRegion: persistedRegion === "Чуйская область" ? "Чуйская область" : "Бишкек" };
  }
  if (facts.residenceCategory === "OTHER_KG" && (!persistedRegion || persistedRegion === "Другой регион Кыргызстана")) {
    return { category: "OTHER_KG", residenceRegion: "Другой регион Кыргызстана" };
  }
  return undefined;
}

function publicMaximum(value: number): number {
  return Math.floor(value / PUBLIC_LIMIT_STEP) * PUBLIC_LIMIT_STEP;
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function numberSetting(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
