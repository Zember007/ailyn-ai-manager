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

  it("resolves an interest-rate question even when it starts with a greeting", async () => {
    const service = new KnowledgeService(createMemoryPrisma() as any);
    const answers = await service.resolveAll("Здравствуйте. Какая у вас процентная ставка?", "ru");

    expect(answers.map((answer) => answer.key)).toContain("interest_rates_overview");
  });

  it("creates seeds through the legacy title/body schema without crashing", async () => {
    const prisma = createMemoryPrisma({ legacyTitleRequired: true, legacyBodyColumn: true });
    const service = new KnowledgeService(prisma as any);

    const answers = await service.resolveAll("Какие ставки?", "ru");

    expect(answers.map((answer) => answer.key)).toContain("interest_rates_overview");
    const stored = prisma.__rows.get("interest_rates_overview");
    expect(stored.title).toBe("interest_rates_overview");
    expect(stored.body).toContain("2,4%");
    expect(typeof stored.aliases).toBe("string");
    expect(stored.aliases).toContain("какие ставки");
  });
});

function createMemoryPrisma(options?: { legacyTitleRequired?: boolean; legacyBodyColumn?: boolean }) {
  const rows = new Map<string, any>();
  const hydrate = (row: any) => {
    if (!row) return row;
    return {
      ...row,
      aliases: typeof row.aliases === "string" ? JSON.parse(row.aliases) : row.aliases,
      conditions: typeof row.conditions === "string" ? JSON.parse(row.conditions) : row.conditions
    };
  };
  const prisma = {
    __rows: rows,
    knowledgeItem: {
      findUnique: async ({ where }: any) => hydrate([...rows.values()].find((row) => row.key === where.key || row.id === where.id) ?? null),
      findMany: async () => [...rows.values()].map(hydrate),
      create: async ({ data }: any) => {
        const row = { id: `kb-${rows.size + 1}`, answerKg: null, conditions: {}, ...data };
        rows.set(row.key, row);
        return hydrate(row);
      },
      update: async ({ where, data }: any) => {
        const current = rows.get(where.key);
        const row = { ...current, ...data };
        rows.set(row.key, row);
        return hydrate(row);
      }
    },
    $queryRawUnsafe: async (query: string, ...params: any[]) => {
      if (query.includes("FROM information_schema.columns")) {
        const columns: Array<{ column_name: string; is_nullable: "YES" | "NO" }> = [];
        if (options?.legacyTitleRequired) columns.push({ column_name: "title", is_nullable: "NO" });
        if (options?.legacyBodyColumn) columns.push({ column_name: "body", is_nullable: "YES" });
        return columns;
      }
      if (query.includes('INSERT INTO "KnowledgeItem"')) {
        const fieldsMatch = query.match(/INSERT INTO "KnowledgeItem" \((.+)\) VALUES/s);
        if (!fieldsMatch) throw new Error("Unexpected legacy insert query");
        const fields = fieldsMatch[1].split(",").map((field) => field.trim().replaceAll("\"", ""));
        const row = fields.reduce<Record<string, any>>((acc, field, index) => {
          acc[field] = params[index];
          return acc;
        }, {});
        row.answerKg ??= null;
        row.conditions ??= {};
        rows.set(row.key, row);
        return [row];
      }
      throw new Error(`Unexpected query: ${query}`);
    }
  };
  return prisma;
}
