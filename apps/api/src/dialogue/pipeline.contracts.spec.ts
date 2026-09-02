import type { ModelMoneyMention } from "../ai/ai-provider.interface.js";
import { extractionSchema } from "./pipeline.contracts.js";

describe("extractionSchema", () => {
  it("accepts a model money mention with unknown currency and no text offsets", () => {
    const parsed = extractionSchema.parse({
      language: "ru",
      route: { kind: "none" },
      moneyMentions: [{
        sourceText: "150000",
        amount: 150_000,
        normalizedAmount: 150_000,
        currency: null,
        roleCandidate: "requestedAmount",
        confidence: 0.91
      }]
    });

    const [mention]: ModelMoneyMention[] = parsed.moneyMentions;
    expect(mention).toEqual({
      sourceText: "150000",
      amount: 150_000,
      normalizedAmount: 150_000,
      currency: null,
      roleCandidate: "requestedAmount",
      confidence: 0.91
    });
  });
});
