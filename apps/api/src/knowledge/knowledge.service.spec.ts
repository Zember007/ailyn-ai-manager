import { describe, expect, it } from "vitest";
import { KnowledgeService } from "./knowledge.service.js";

describe("KnowledgeService approved resolution", () => {
  it("resolves every topic in a compound client question", async () => {
    const service = new KnowledgeService(createMemoryPrisma() as any);
    const answers = await service.resolveAll("Какие ставки, где находится офис и какие документы нужны?", "ru");

    expect(answers.map((answer) => answer.key)).toEqual(expect.arrayContaining([
      "interest_rates_overview",
      "office_location",
      "documents_required"
    ]));
  });

  it("prefers the specific approved parking rate over the general rate answer", async () => {
    const service = new KnowledgeService(createMemoryPrisma() as any);
    const answers = await service.resolveAll("Какая ставка по стоянке?", "ru");

    expect(answers.map((answer) => answer.key)).toContain("parking_rate");
    expect(answers.map((answer) => answer.key)).not.toContain("interest_rates_overview");
    expect(answers.find((answer) => answer.key === "parking_rate")?.answerRu).toContain("2,4%");
  });
});

function createMemoryPrisma() {
  const rows = new Map<string, any>();
  return {
    knowledgeItem: {
      findUnique: async ({ where }: any) => [...rows.values()].find((row) => row.key === where.key || row.id === where.id) ?? null,
      findMany: async () => [...rows.values()],
      create: async ({ data }: any) => {
        const row = { id: `kb-${rows.size + 1}`, answerKg: null, conditions: {}, ...data };
        rows.set(row.key, row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const current = rows.get(where.key);
        const row = { ...current, ...data };
        rows.set(row.key, row);
        return row;
      }
    }
  };
}
