import { describe, expect, it } from "vitest";
import { generatedDocumentationChunks } from "./documentation-chunks.generated.js";

describe("generated documentation chunk quality", () => {
  it("keeps spouse section 5.15 separate from guarantor section 5.16", () => {
    const spouse = generatedDocumentationChunks.filter((chunk) => chunk.section === "5.15");
    const guarantor = generatedDocumentationChunks.filter((chunk) => chunk.section === "5.16");

    expect(spouse.length).toBeGreaterThan(0);
    expect(guarantor.length).toBeGreaterThan(0);
    expect(spouse.every((chunk) => chunk.primaryStage === "family_status")).toBe(true);
    expect(guarantor.every((chunk) => chunk.primaryStage === "guarantor")).toBe(true);
    expect(spouse.every((chunk) => !/5\.16\s+Вопросы о поручителе/u.test(chunk.text))).toBe(true);
    expect(guarantor.every((chunk) => !/5\.15\s+Вопросы о супруге/u.test(chunk.text))).toBe(true);
  });
});
