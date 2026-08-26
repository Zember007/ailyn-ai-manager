import { describe, expect, it } from "vitest";
import { evaluateApplication } from "@ailyn/business-rules";

describe("Stage 1 smoke scenario", () => {
  it("keeps deterministic finance decisions outside the LLM layer", () => {
    const result = evaluateApplication({ metadata: { source: "scenario-smoke" } });

    expect(result.status).toBe("not_configured");
    expect(result.reasons[0]).toContain("Business rules specification");
  });
});
