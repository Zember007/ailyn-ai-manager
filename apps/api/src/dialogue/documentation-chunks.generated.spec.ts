import { describe, expect, it } from "vitest";
import { generatedDocumentationChunks } from "./documentation-chunks.generated.js";

describe("generated documentation chunk quality", () => {
  it("preserves source-section boundaries and bounded continuity overlap", () => {
    expect(generatedDocumentationChunks.some((chunk) => chunk.sourceSection === "20.4")).toBe(true);
    expect(generatedDocumentationChunks.every((chunk) => chunk.parentContext.length > 0)).toBe(true);
    expect(generatedDocumentationChunks.filter((chunk) => chunk.sourceSection === "20.4").every((chunk) => chunk.parentContext.startsWith("20.4"))).toBe(true);
    const continuation = generatedDocumentationChunks.find((chunk) => chunk.overlapFromPrevious && chunk.overlapFromPrevious.length > 0);
    expect(continuation?.overlapFromPrevious.length).toBeLessThanOrEqual(320);
  });

  it("keeps verbatim approved answers isolated from neighbouring context", () => {
    const approved = generatedDocumentationChunks.filter((chunk) => chunk.responsePolicy === "verbatim");
    expect(approved.length).toBeGreaterThan(0);
    expect(approved.every((chunk) => chunk.overlapFromPrevious === undefined)).toBe(true);
  });

  it("does not append continuation labels or company settings to a FAQ answer", () => {
    const incomeCertificate = generatedDocumentationChunks.find((chunk) => "approvedQuestion" in chunk && chunk.approvedQuestion === "Нужна справка о доходах?");
    const postLoanQuestions = generatedDocumentationChunks.find((chunk) => "approvedQuestion" in chunk && chunk.approvedQuestion === "Если после оформления останутся вопросы?");

    expect(incomeCertificate).toMatchObject({ approvedAnswer: "Нет, для оформления она не требуется." });
    expect(postLoanQuestions).toMatchObject({ approvedAnswer: "Вы всегда можете написать нам в WhatsApp или позвонить — мы с удовольствием поможем." });
    expect(incomeCertificate?.text).not.toMatch(/Продолжение раздела|Настройки компании/u);
    expect(postLoanQuestions?.text).not.toMatch(/Продолжение раздела|Настройки компании/u);
  });

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
