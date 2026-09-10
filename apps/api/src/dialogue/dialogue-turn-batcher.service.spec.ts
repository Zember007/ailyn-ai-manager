import { describe, expect, it, vi } from "vitest";
import { DialogueOrchestratorService } from "./dialogue-orchestrator.service.js";
import { DialogueTurnBatcherService } from "./dialogue-turn-batcher.service.js";

describe("DialogueTurnBatcherService", () => {
  it("processes quick client messages as ordered independent model turns", async () => {
    vi.useFakeTimers();
    const orchestrator = {
      receiveBatch: vi.fn().mockImplementation(([message]: any[]) => Promise.resolve({ reply: `reply:${message.text}` })),
      publishDeferredBatchReply: vi.fn().mockImplementation((result: any, reply: string) => Promise.resolve({ ...result, reply }))
    } as any;
    const batcher = new DialogueTurnBatcherService(orchestrator);
    const common = { channel: "web-test" as const, externalContactId: "client", externalConversationId: "chat", attachments: [], timestamp: new Date() };

    const first = batcher.enqueue({ ...common, externalMessageId: "1", text: "Камри" });
    const second = batcher.enqueue({ ...common, externalMessageId: "2", text: "2022 года" });
    const third = batcher.enqueue({ ...common, externalMessageId: "3", text: "стоит 2 млн" });

    await vi.advanceTimersByTimeAsync(650);

    expect(orchestrator.receiveBatch).toHaveBeenCalledTimes(3);
    expect(orchestrator.receiveBatch.mock.calls.map(([batch]: [any[]]) => batch.map((message) => message.text))).toEqual([
      ["Камри"], ["2022 года"], ["стоит 2 млн"]
    ]);
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      { reply: "reply:стоит 2 млн" }, { reply: "reply:стоит 2 млн" }, { reply: "reply:стоит 2 млн" }
    ]);
    vi.useRealTimers();
  });

  it("retains the superseded messages when a new message aborts an active turn", async () => {
    vi.useFakeTimers();
    try {
      const freshResult = { reply: "fresh" } as any;
      const orchestrator = {
        receiveBatch: vi.fn().mockImplementation((_messages: any[], { signal }: { signal: AbortSignal }) => {
          if (orchestrator.receiveBatch.mock.calls.length === 1) {
            return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("superseded", "AbortError")), { once: true }));
          }
          return Promise.resolve(freshResult);
        }),
        publishDeferredBatchReply: vi.fn().mockImplementation((result: any, reply: string) => Promise.resolve({ ...result, reply }))
      } as any;
      const batcher = new DialogueTurnBatcherService(orchestrator);
      const common = { channel: "web-test" as const, externalContactId: "client", externalConversationId: "chat", attachments: [], timestamp: new Date() };

      const first = batcher.enqueue({ ...common, externalMessageId: "1", text: "Камри" });
      await vi.advanceTimersByTimeAsync(650);
      const second = batcher.enqueue({ ...common, externalMessageId: "2", text: "2022 года" });
      await vi.advanceTimersByTimeAsync(650);

      expect(orchestrator.receiveBatch).toHaveBeenCalledTimes(3);
      expect(orchestrator.receiveBatch.mock.calls.map(([batch]: [any[]]) => batch.map((message) => message.externalMessageId))).toEqual([
        ["1"], ["1"], ["2"]
      ]);
      await expect(Promise.all([first, second])).resolves.toEqual([freshResult, freshResult]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes one combined reply with only the final server workflow prompt", async () => {
    vi.useFakeTimers();
    try {
      const replies = [
        "Парковка находится недалеко от нашего офиса и находится под охраной. Точный адрес парковки не сообщается. Сумма 700 000 сом по этой программе не проходит. Могу продолжить либо на сумму до 600 000 сом.",
        "Поняла.\n\nПо программе со стоянкой доступно до 1 090 000 сом.\n\nПожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.",
        "Фотографии получены.\n\nПожалуйста, отправьте 2–3 фотографии автомобиля."
      ];
      const finalResult = { reply: replies[2] } as any;
      const orchestrator = {
        receiveBatch: vi.fn().mockImplementation(() => Promise.resolve({ reply: replies.shift() })),
        publishDeferredBatchReply: vi.fn().mockImplementation((_result: any, reply: string) => Promise.resolve({ ...finalResult, reply }))
      } as any;
      const batcher = new DialogueTurnBatcherService(orchestrator);
      const common = { channel: "web-test" as const, externalContactId: "client", externalConversationId: "chat", timestamp: new Date() };

      const first = batcher.enqueue({ ...common, externalMessageId: "1", text: "а стоянка у вас где", attachments: [] });
      const second = batcher.enqueue({ ...common, externalMessageId: "2", text: "да давай стоянку", attachments: [] });
      const third = batcher.enqueue({ ...common, externalMessageId: "3", attachments: [{ id: "id", mimeType: "image/jpeg" }] });
      await vi.advanceTimersByTimeAsync(650);

      const expected = "Парковка находится недалеко от нашего офиса и находится под охраной. Точный адрес парковки не сообщается.\n\nФотографии получены.\n\nПожалуйста, отправьте 2–3 фотографии автомобиля.";
      await expect(Promise.all([first, second, third])).resolves.toEqual([
        { ...finalResult, reply: expected }, { ...finalResult, reply: expected }, { ...finalResult, reply: expected }
      ]);
      expect(orchestrator.publishDeferredBatchReply).toHaveBeenCalledWith(expect.anything(), expected, "3");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops an intermediate guarantor prompt when the final batched message chooses parking", async () => {
    vi.useFakeTimers();
    try {
      const replies = [
        "Парковка находится недалеко от нашего офиса и находится под охраной. Точный адрес парковки не сообщается. И Вам потребуется поручитель:\n- возраст от 25 лет\n- проживает в г. Бишкек или Чуйской области\n- должен лично присутствовать при выдаче займа и имеет с собой ID (паспорт)\nУ Вас есть такой поручитель?",
        "Поняла.\n\nПо программе со стоянкой доступно до 1 090 000 сом.\n\nПожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон."
      ];
      const finalResult = { reply: replies[1] } as any;
      const orchestrator = {
        receiveBatch: vi.fn().mockImplementation(() => Promise.resolve({ reply: replies.shift() })),
        publishDeferredBatchReply: vi.fn().mockImplementation((_result: any, reply: string) => Promise.resolve({ ...finalResult, reply }))
      } as any;
      const batcher = new DialogueTurnBatcherService(orchestrator);
      const common = { channel: "web-test" as const, externalContactId: "client", externalConversationId: "chat", timestamp: new Date() };

      const first = batcher.enqueue({ ...common, externalMessageId: "1", text: "а где стоянка", attachments: [] });
      const second = batcher.enqueue({ ...common, externalMessageId: "2", text: "давайте стоянку", attachments: [] });
      await vi.advanceTimersByTimeAsync(650);

      const expected = "Парковка находится недалеко от нашего офиса и находится под охраной. Точный адрес парковки не сообщается.\n\nПоняла.\n\nПо программе со стоянкой доступно до 1 090 000 сом.\n\nПожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.";
      await expect(Promise.all([first, second])).resolves.toEqual([{ ...finalResult, reply: expected }, { ...finalResult, reply: expected }]);
      expect(orchestrator.publishDeferredBatchReply).toHaveBeenCalledWith(expect.anything(), expected, "2");
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
      expect(agent.run).toHaveBeenCalledTimes(3);
      expect(agent.run.mock.calls.map(([input]: [{ text: string }]) => input.text)).toEqual(["Камри", "Камри", "2022 года"]);
      expect(addMessage.mock.calls.filter(([, message]) => message.author === "client").map(([, message]) => message.metadata.externalMessageId)).toEqual(["A", "B"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
