import { describe, expect, it } from "vitest";
import { DocumentationKnowledgeService } from "./documentation-knowledge.service.js";

describe("DocumentationKnowledgeService", () => {
  it("finds an approved documentation chunk for an indirect programme question", () => {
    const answer = new DocumentationKnowledgeService().resolve("Я запутался: что означает постановка автомобиля на охраняемую стоянку?");

    expect(answer?.key).toBe("documentation_parking_program_explained");
    expect(answer?.text).toContain("на время займа автомобиль размещается на охраняемой парковке");
  });

  it("does not manufacture an answer when no documentation chunk matches", () => {
    expect(new DocumentationKnowledgeService().resolve("Какая сегодня погода в Бишкеке?")).toBeUndefined();
  });
});
