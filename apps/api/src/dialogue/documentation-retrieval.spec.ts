import { describe, expect, it } from "vitest";
import { selectRelevantDocumentation } from "./documentation-retrieval.js";

describe("selectRelevantDocumentation", () => {
  it("retrieves currency guidance when the client provides foreign-currency prices", () => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: "камри стоит 20 тысяч долларов, надо 10", messages: [] });

    expect(result.knowledge.some((chunk) => /^13\.1/u.test(chunk.section))).toBe(true);
    expect(result.stages).toContain("application");
  });

  it("retrieves family and guarantor guidance for a non-Bishkek without-storage application", () => {
    const result = selectRelevantDocumentation({
      facts: { requestedProgram: "without_storage", residenceCategory: "OTHER_KG" } as any,
      currentMessage: "да, поручитель есть",
      messages: []
    });

    expect(result.stages).toEqual(expect.arrayContaining(["family_status", "guarantor"]));
    expect(result.knowledge.some((chunk) => chunk.section === "5.15")).toBe(true);
    expect(result.knowledge.some((chunk) => chunk.section === "5.16")).toBe(true);
  });

  it("brings back application guidance when a client changes an earlier price", () => {
    const result = selectRelevantDocumentation({
      facts: { vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "parking" } as any,
      currentMessage: "машина всё-таки стоит 25 тысяч долларов",
      messages: []
    });

    expect(result.stages).toContain("application");
    expect(result.knowledge.some((chunk) => /стоимост|валют|курс/u.test(chunk.text))).toBe(true);
  });

  it("retrieves vehicle-photo guidance immediately after all required documents arrive", () => {
    const result = selectRelevantDocumentation({
      facts: { documents: { id_front: "received", id_back: "received", vehicle_registration_front: "received", vehicle_registration_back: "received" } } as any,
      currentMessage: "отправляю документы",
      messages: []
    });

    expect(result.stages).toContain("vehicle_photos");
    expect(result.knowledge.some((chunk) => chunk.primaryStage === "vehicle_photos")).toBe(true);
  });
});
