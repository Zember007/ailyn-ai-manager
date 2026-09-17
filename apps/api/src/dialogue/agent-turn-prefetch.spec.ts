import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterAiClient } from "../ai/router-ai/router-ai.client.js";
import { AgentTurnService } from "./agent-turn.service.js";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/ailyn";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.ROUTERAI_API_KEY ??= "test-routerai-key";

const mainResult = {
  reply: "Распознано.", hasMoney: false, needsKnowledgeLookup: false, language: "ru", intent: "new_loan", loanQuestionKind: "none",
  leadCardPatch: {}, cardSummary: "", dialogueState: { stage: "COLLECTING_VALUE", status: "need_more_data", nextAction: "continue" },
  targetEvent: null, managerUpdate: { kind: "none", changedFields: [] }, attachments: []
};

describe("AgentTurnService active-stage prefetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts the active programme classifier before the main model resolves", async () => {
    let resolveMain!: (value: Response) => void;
    const mainResponse = new Promise<Response>((resolve) => { resolveMain = resolve; });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const systemPrompt = body.messages[0].content as string;
      if (systemPrompt.includes("Определи, изменяет ли клиент программу займа")) {
        return jsonResponse({ choices: [{ message: { content: JSON.stringify({ program: "parking", hasOtherStageAnswer: false, question: null }) } }] });
      }
      return mainResponse;
    }));
    const service = new AgentTurnService(new RouterAiClient());

    const turn = service.run({
      messages: [{ author: "ai", body: "Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?", createdAt: "now" } as any],
      facts: {}, settings: {}, text: "стоянка", attachments: []
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    resolveMain(jsonResponse({ model: "main-model", choices: [{ message: { content: JSON.stringify(mainResult) } }] }));

    const result = await turn;
    expect(result.result?.leadCardPatch.requestedProgram).toBe("parking");
  });
});

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue(payload)
  } as unknown as Response;
}
