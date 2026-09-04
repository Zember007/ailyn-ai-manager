import { describe, expect, it, vi } from "vitest";
import { DialogueTurnBatcherService } from "./dialogue-turn-batcher.service.js";

describe("DialogueTurnBatcherService", () => {
  it("joins quick client messages into one model turn in their original order", async () => {
    vi.useFakeTimers();
    const result = { reply: "ok" } as any;
    const orchestrator = { receiveBatch: vi.fn().mockResolvedValue(result) } as any;
    const batcher = new DialogueTurnBatcherService(orchestrator);
    const common = { channel: "web-test" as const, externalContactId: "client", externalConversationId: "chat", attachments: [], timestamp: new Date() };

    const first = batcher.enqueue({ ...common, externalMessageId: "1", text: "Камри" });
    const second = batcher.enqueue({ ...common, externalMessageId: "2", text: "2022 года" });
    const third = batcher.enqueue({ ...common, externalMessageId: "3", text: "стоит 2 млн" });

    await vi.advanceTimersByTimeAsync(650);

    expect(orchestrator.receiveBatch).toHaveBeenCalledTimes(1);
    expect(orchestrator.receiveBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ text: "Камри" }),
        expect.objectContaining({ text: "2022 года" }),
        expect.objectContaining({ text: "стоит 2 млн" })
      ]),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    await expect(Promise.all([first, second, third])).resolves.toEqual([result, result, result]);
    vi.useRealTimers();
  });
});
