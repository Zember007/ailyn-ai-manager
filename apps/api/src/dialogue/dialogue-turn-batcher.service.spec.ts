import { describe, expect, it, vi } from "vitest";
import { DialogueOrchestratorService } from "./dialogue-orchestrator.service.js";
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

  it("retains the superseded messages when a new message aborts an active turn", async () => {
    vi.useFakeTimers();
    try {
      const freshResult = { reply: "fresh" } as any;
      const orchestrator = {
        receiveBatch: vi.fn().mockImplementation((messages: any[], { signal }: { signal: AbortSignal }) => {
          if (messages.length === 1) {
            return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("superseded", "AbortError")), { once: true }));
          }
          return Promise.resolve(freshResult);
        })
      } as any;
      const batcher = new DialogueTurnBatcherService(orchestrator);
      const common = { channel: "web-test" as const, externalContactId: "client", externalConversationId: "chat", attachments: [], timestamp: new Date() };

      const first = batcher.enqueue({ ...common, externalMessageId: "1", text: "Камри" });
      await vi.advanceTimersByTimeAsync(650);
      const second = batcher.enqueue({ ...common, externalMessageId: "2", text: "2022 года" });
      await vi.advanceTimersByTimeAsync(650);

      expect(orchestrator.receiveBatch).toHaveBeenCalledTimes(2);
      expect(orchestrator.receiveBatch.mock.calls[1][0]).toEqual([
        expect.objectContaining({ externalMessageId: "1", text: "Камри" }),
        expect.objectContaining({ externalMessageId: "2", text: "2022 года" })
      ]);
      await expect(Promise.all([first, second])).resolves.toEqual([freshResult, freshResult]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists a superseded message only once when retrying it with the newer batch", async () => {
    vi.useFakeTimers();
    try {
      const application = { id: "app", facts: {}, contactId: "client", stage: "NEW", status: "need_more_data" } as any;
      const conversation = { id: "conversation", messages: [], application, channel: "web-test" } as any;
      const addMessage = vi.fn().mockImplementation(async (_conversation: unknown, message: any) => ({
        id: message.metadata?.externalMessageId ?? "agent-reply",
        author: message.author,
        body: message.body,
        attachmentIds: [],
        attachments: [],
        createdAt: "now",
        metadata: message.metadata
      }));
      const store = {
        getOrCreateConversation: vi.fn().mockResolvedValue({ conversation, application }),
        addMessage,
        updateFacts: vi.fn().mockResolvedValue([]),
        saveAgentState: vi.fn(),
        getApplication: vi.fn().mockResolvedValue(application),
        getConversation: vi.fn().mockResolvedValue(conversation),
        addAttachment: vi.fn(),
        createManagerNotification: vi.fn()
      } as any;
      const result = {
        reply: "Продолжим оформление.",
        language: "ru",
        intent: "loan",
        hasMoney: false,
        leadCardPatch: {},
        attachments: [],
        dialogueState: { stage: "NEW", status: "need_more_data", nextAction: "ask_vehicle" },
        targetEvent: null,
        cardSummary: "",
        preliminaryLimit: null
      };
      const agent = {
        run: vi.fn().mockImplementation((_input: unknown) => {
          const signal = (_input as { signal: AbortSignal }).signal;
          if (agent.run.mock.calls.length === 1) {
            return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("superseded", "AbortError")), { once: true }));
          }
          return Promise.resolve({ result, reply: result.reply, model: "one", promptVersion: "v1" });
        })
      } as any;
      const orchestrator = new DialogueOrchestratorService(agent, store, { getValues: vi.fn().mockResolvedValue({}) } as any, { log: vi.fn() } as any);
      const batcher = new DialogueTurnBatcherService(orchestrator);
      const common = { channel: "web-test" as const, externalContactId: "client", externalConversationId: "chat", attachments: [], timestamp: new Date() };

      const first = batcher.enqueue({ ...common, externalMessageId: "A", text: "Камри" });
      await vi.advanceTimersByTimeAsync(650);
      const second = batcher.enqueue({ ...common, externalMessageId: "B", text: "2022 года" });
      await vi.advanceTimersByTimeAsync(650);

      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(agent.run).toHaveBeenCalledTimes(2);
      expect(agent.run.mock.calls[1][0].messages.slice(-2).map((message: { metadata?: { externalMessageId?: string } }) => message.metadata?.externalMessageId)).toEqual(["A", "B"]);
      expect(addMessage.mock.calls.filter(([, message]) => message.author === "client").map(([, message]) => message.metadata.externalMessageId)).toEqual(["A", "B"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
