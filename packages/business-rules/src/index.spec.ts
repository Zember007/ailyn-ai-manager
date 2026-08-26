import { describe, expect, it } from "vitest";
import { evaluateApplication } from "./index.js";

describe("business rules", () => {
  it("does not invent deterministic finance decisions without a spec", () => {
    const result = evaluateApplication({ monthlyIncome: 100000, requestedAmount: 250000 });

    expect(result.status).toBe("not_configured");
    expect(result.availablePrograms).toEqual([]);
    expect(result.limits).toBeUndefined();
  });
});
