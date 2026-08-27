import { describe, expect, it } from "vitest";
import { readStage1Scenarios, runScenario } from "../../apps/api/src/scenarios/scenarios.service.js";

describe("Stage 1 acceptance scenarios", () => {
  const scenarios = readStage1Scenarios();
  const results = scenarios.map((scenario) => runScenario(scenario));

  it("creates an automated check for every scenario ID in the acceptance source", () => {
    expect(results).toHaveLength(scenarios.length);
    expect(results.length).toBeGreaterThan(80);
  });

  it("keeps acceptance BLOCKED scenarios blocked instead of manufacturing values", () => {
    const blockedIds = scenarios.filter((scenario) => scenario.blocked).map((scenario) => scenario.id);
    const blockedResults = results.filter((result) => blockedIds.includes(result.id));

    expect(blockedResults.length).toBeGreaterThan(0);
    expect(blockedResults.every((result) => result.status === "BLOCKED")).toBe(true);
  });

  it("passes every non-blocked critical Stage 1 scenario", () => {
    const criticalNonBlockedIds = scenarios
      .filter((scenario) => scenario.critical && !scenario.blocked)
      .map((scenario) => scenario.id);
    const failed = results.filter((result) => criticalNonBlockedIds.includes(result.id) && result.status !== "PASS");

    expect(failed).toEqual([]);
  });

  it("passes every non-blocked Stage 1 scenario", () => {
    const nonBlockedIds = scenarios.filter((scenario) => !scenario.blocked).map((scenario) => scenario.id);
    const failed = results.filter((result) => nonBlockedIds.includes(result.id) && result.status !== "PASS");

    expect(failed).toEqual([]);
  });
});
