import { describe, expect, it, vi } from "vitest";
import { AgentTurnService } from "./agent-turn.service.js";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
process.env.REDIS_URL ??= "redis://localhost:6379";

describe("guarantor knowledge rule", () => {
  it("answers that a guarantor is not required for Bishkek/Chuy without-storage clients", async () => {
    const client = {
      isConfigured: vi.fn().mockReturnValue(true),
      createChatCompletion: vi.fn()
    } as any;
    const service = new AgentTurnService(client);

    const answer = await service.answerWithKnowledge({
      messages: [],
      facts: { requestedProgram: "without_storage", residenceCategory: "BISHKEK_CHUY" },
      settings: {},
      text: "а поручителя надо",
      workflowFollowUp: ""
    });

    expect(answer).toEqual({
      reply: "Нет, в Вашем случае поручитель не требуется.",
      answerFound: true,
      model: "server-guarantor-rule"
    });
    expect(client.createChatCompletion).not.toHaveBeenCalled();
  });
});
