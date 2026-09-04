import { describe, expect, it } from "vitest";
import { selectRelevantDocumentation } from "./documentation-retrieval.js";

describe("selectRelevantDocumentation", () => {
  it("always supplies only the compact approved-answer core", () => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: "здравствуйте", messages: [] });

    expect(result.commonKnowledge.length).toBeGreaterThan(0);
    expect(result.commonKnowledge.length).toBeLessThan(10);
    expect(result.commonKnowledge.some((chunk) => chunk.section === "5.1")).toBe(true);
    expect(result.commonKnowledge.some((chunk) => chunk.section === "5.25")).toBe(true);
    expect(result.stageInstructions.some((instruction) => instruction.includes("Марку отдельно не запрашивайте"))).toBe(true);
  });

  it("does not preload future family or guarantor branches into an application turn", () => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: "камри 2009 стоит 2 млн сом", messages: [] });

    expect(result.stages).toEqual(["application"]);
    expect(result.knowledge.some((chunk) => chunk.primaryStage === "family_status" || chunk.primaryStage === "guarantor")).toBe(false);
    expect(result.stageInstructions.some((instruction) => instruction.includes("Марку отдельно не запрашивайте"))).toBe(true);
  });

  it("retrieves currency guidance when the client provides foreign-currency prices", () => {
    const result = selectRelevantDocumentation({ facts: {}, currentMessage: "камри стоит 20 тысяч долларов, надо 10", messages: [] });

    expect(result.knowledge.some((chunk) => /^13\.1/u.test(chunk.section))).toBe(true);
    expect(result.stages).toContain("application");
  });

  it("retrieves family and guarantor guidance for a non-Bishkek without-storage application", () => {
    const result = selectRelevantDocumentation({
      facts: {
        vehicleMake: "Toyota", vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000,
        requestedProgram: "without_storage", residenceRegion: "Нарын", residenceCategory: "OTHER_KG",
        documents: { id_front: "received", id_back: "received", vehicle_registration_front: "received", vehicle_registration_back: "received" },
        declinedCarPhoto: true
      } as any,
      currentMessage: "я в браке, поручитель есть",
      messages: []
    });

    expect(result.stages).toEqual(expect.arrayContaining(["family_status", "guarantor"]));
    expect(result.knowledge.some((chunk) => chunk.section === "5.15")).toBe(true);
    expect(result.knowledge.some((chunk) => chunk.section === "5.16")).toBe(true);
    expect(result.stageInstructions).toHaveLength(2);
  });

  it("requires a guarantor for every OTHER_KG card, including parking", () => {
    const result = selectRelevantDocumentation({
      facts: {
        vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000,
        requestedProgram: "parking", residenceRegion: "Иссык-Кульская область", residenceCategory: "OTHER_KG"
      } as any,
      currentMessage: "со стоянкой",
      messages: []
    });

    expect(result.stages[0]).toBe("guarantor");
    expect(result.stageInstructions.some((instruction) => instruction.includes("OTHER_KG всегда требует вопроса о поручителе"))).toBe(true);
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

  it("brings back programme-limit guidance when the client switches to parking", () => {
    const result = selectRelevantDocumentation({
      facts: {
        vehicleModel: "Camry", vehicleYear: 2002, vehicleValue: 2_623_464, requestedAmount: 787_039,
        requestedProgram: "without_storage", residenceRegion: "Иссык-Кульская область", residenceCategory: "OTHER_KG"
      } as any,
      currentMessage: "стоянка тогда",
      messages: []
    });

    expect(result.stages).toContain("application");
    expect(result.stageInstructions.some((instruction) => instruction.includes("пересчитайте лимит уже для новой программы"))).toBe(true);
  });

  it("retrieves vehicle-photo guidance immediately after all required documents arrive", () => {
    const result = selectRelevantDocumentation({
      facts: {
        vehicleMake: "Toyota", vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000,
        requestedProgram: "parking", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        documents: { id_front: "received", id_back: "received", vehicle_registration_front: "received", vehicle_registration_back: "received" }
      } as any,
      currentMessage: "отправляю документы",
      messages: []
    });

    expect(result.stages).toContain("vehicle_photos");
    expect(result.knowledge.some((chunk) => chunk.primaryStage === "vehicle_photos")).toBe(true);
    expect(result.stageInstructions.some((instruction) => instruction.includes("ЭТАП ФОТОГРАФИЙ АВТОМОБИЛЯ"))).toBe(true);
  });

  it("supplies multi-document and electronic-document recognition guidance during document collection", () => {
    const result = selectRelevantDocumentation({ facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000, requestedProgram: "parking", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" } as any, currentMessage: "отправляю ID и СТС", messages: [] });

    const instruction = result.stageInstructions.find((item) => item.includes("ЭТАП ДОКУМЕНТОВ")) ?? "";
    expect(instruction).toContain("несколько документов на одном фото");
    expect(instruction).toContain("Электронный документ/скриншот Tunduk");
    expect(instruction).toContain("отметьте все уверенно различимые части");
  });

  it("continues past document collection after any client file was supplied", () => {
    const result = selectRelevantDocumentation({
      facts: {
        vehicleMake: "Toyota", vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 1_000_000, requestedAmount: 300_000,
        requestedProgram: "parking", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY",
        documentsProvided: true,
        documents: { unknown: "received" }
      } as any,
      currentMessage: "вот документы",
      messages: []
    });

    expect(result.stages[0]).toBe("vehicle_photos");
    expect(result.stageInstructions.some((instruction) => instruction.includes("этап документов окончательно закрыт"))).toBe(true);
  });
});
