import { describe, expect, it, vi } from "vitest";
import { MessagesController } from "./messages.controller.js";

describe("MessagesController", () => {
  it("routes a test-chat message into the existing conversation by internal id", async () => {
    const logs = { log: vi.fn(), debug: vi.fn() } as any;
    const store = {
      getConversationByIdForChannel: vi.fn().mockResolvedValue({
        id: "conv-internal-1",
        externalConversationId: "web-conversation-1",
        externalContactId: "web-client-1"
      })
    } as any;
    const orchestrator = {
      receive: vi.fn().mockResolvedValue({
        reply: "ok",
        conversation: { id: "conv-internal-1", application: { id: "app-1" } },
        application: { id: "app-1" },
        validation: { passed: true, errors: [] },
        routerAiModel: "local-stage1-fallback",
        promptVersion: "stage1-local-v1"
      })
    } as any;
    const controller = new MessagesController(orchestrator, store, logs);

    const result = await controller.testChat({
      conversationId: "conv-internal-1",
      message: "Здравствуйте"
    });

    expect(store.getConversationByIdForChannel).toHaveBeenCalledWith("conv-internal-1", "web-test");
    expect(logs.debug).toHaveBeenCalledWith(
      "messages.test-chat",
      "Resolved existing web-test conversation",
      expect.objectContaining({
        conversationId: "conv-internal-1"
      })
    );
    expect(orchestrator.receive).toHaveBeenCalledWith(
      expect.objectContaining({
        externalContactId: "web-client-1",
        externalConversationId: "web-conversation-1",
        text: "Здравствуйте"
      })
    );
    expect(result.conversationId).toBe("conv-internal-1");
  });

  it("rejects an unknown internal conversation id instead of creating a new chat", async () => {
    const store = {
      getConversationByIdForChannel: vi.fn().mockResolvedValue(undefined)
    } as any;
    const controller = new MessagesController({ receive: vi.fn() } as any, store, { log: vi.fn() } as any);

    await expect(controller.testChat({ conversationId: "missing-conversation", message: "test" })).rejects.toMatchObject({
      message: "conversation_not_found"
    });
  });

  it("includes uploaded files in the orchestrator payload", async () => {
    const logs = { log: vi.fn(), debug: vi.fn() } as any;
    const store = {
      getConversationByIdForChannel: vi.fn().mockResolvedValue({
        id: "conv-internal-1",
        externalConversationId: "web-conversation-1",
        externalContactId: "web-client-1"
      })
    } as any;
    const orchestrator = {
      receive: vi.fn().mockResolvedValue({
        reply: "ok",
        conversation: { id: "conv-internal-1", application: { id: "app-1" } },
        application: { id: "app-1" },
        validation: { passed: true, errors: [] },
        routerAiModel: "local-stage1-fallback",
        promptVersion: "stage1-local-v1"
      })
    } as any;
    const controller = new MessagesController(orchestrator, store, logs);

    await controller.testChat(
      {
        conversationId: "conv-internal-1",
        message: ""
      },
      [{ originalname: "car-photo.jpg", mimetype: "image/jpeg", size: 2048, buffer: Buffer.from("image") }]
    );

    expect(orchestrator.receive).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            fileName: "car-photo.jpg",
            mimeType: "image/jpeg",
            contentBase64: Buffer.from("image").toString("base64"),
            metadata: expect.objectContaining({
              byteSize: 2048
            })
          })
        ]
      })
    );
  });

  it("extracts text content from uploaded text files for downstream scanning", async () => {
    const logs = { log: vi.fn(), debug: vi.fn() } as any;
    const store = {
      getConversationByIdForChannel: vi.fn().mockResolvedValue({
        id: "conv-internal-1",
        externalConversationId: "web-conversation-1",
        externalContactId: "web-client-1"
      })
    } as any;
    const orchestrator = {
      receive: vi.fn().mockResolvedValue({
        reply: "ok",
        conversation: { id: "conv-internal-1", application: { id: "app-1" } },
        application: { id: "app-1" },
        validation: { passed: true, errors: [] },
        routerAiModel: "local-stage1-fallback",
        promptVersion: "stage1-local-v1"
      })
    } as any;
    const controller = new MessagesController(orchestrator, store, logs);

    await controller.testChat(
      {
        conversationId: "conv-internal-1",
        message: ""
      },
      [{ originalname: "passport-front.txt", mimetype: "text/plain", size: 64, buffer: Buffer.from("ФИО: Иванов Иван Иванович", "utf8") }]
    );

    expect(orchestrator.receive).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            fileName: "passport-front.txt",
            textContent: "ФИО: Иванов Иван Иванович"
          })
        ]
      })
    );
  });

  it("keeps the same internal conversation id across sequential sends", async () => {
    const logs = { log: vi.fn(), debug: vi.fn() } as any;
    const store = {
      getConversationByIdForChannel: vi.fn().mockResolvedValue({
        id: "conv-internal-1",
        externalConversationId: "web-conversation-1",
        externalContactId: "web-client-1"
      })
    } as any;
    const orchestrator = {
      receive: vi
        .fn()
        .mockResolvedValueOnce({
          reply: "first",
          conversation: { id: "conv-internal-1", application: { id: "app-1" } },
          application: { id: "app-1" },
          validation: { passed: true, errors: [] },
          routerAiModel: "local-stage1-fallback",
          promptVersion: "stage1-local-v1"
        })
        .mockResolvedValueOnce({
          reply: "second",
          conversation: { id: "conv-internal-1", application: { id: "app-1" } },
          application: { id: "app-1" },
          validation: { passed: true, errors: [] },
          routerAiModel: "local-stage1-fallback",
          promptVersion: "stage1-local-v1"
        })
    } as any;
    const controller = new MessagesController(orchestrator, store, logs);

    const first = await controller.testChat({
      conversationId: "conv-internal-1",
      message: "Первое сообщение"
    });
    const second = await controller.testChat({
      conversationId: "conv-internal-1",
      message: "Второе сообщение"
    });

    expect(first.conversationId).toBe("conv-internal-1");
    expect(second.conversationId).toBe("conv-internal-1");
    expect(store.getConversationByIdForChannel).toHaveBeenCalledTimes(2);
    expect(orchestrator.receive).toHaveBeenCalledTimes(2);
  });
});
