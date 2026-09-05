import { describe, expect, it } from "vitest";
import { selectedProgramLimit } from "./agent-turn-reconciliation.js";

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
});
