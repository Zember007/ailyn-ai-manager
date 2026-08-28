import { describe, expect, it, vi } from "vitest";
import { MessagesController } from "./messages.controller.js";

describe("MessagesController", () => {
  it("routes a test-chat message into the existing conversation by internal id", async () => {
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
        conversation: { id: "conv-internal-1" },
        application: { id: "app-1" },
        validation: { passed: true, errors: [] },
        routerAiModel: "local-stage1-fallback",
        promptVersion: "stage1-local-v1"
      })
    } as any;
    const controller = new MessagesController(orchestrator, store);

    const result = await controller.testChat({
      conversationId: "conv-internal-1",
      message: "Здравствуйте"
    });

    expect(store.getConversationByIdForChannel).toHaveBeenCalledWith("conv-internal-1", "web-test");
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
    const controller = new MessagesController({ receive: vi.fn() } as any, store);

    await expect(controller.testChat({ conversationId: "missing-conversation", message: "test" })).rejects.toMatchObject({
      message: "conversation_not_found"
    });
  });

  it("includes uploaded files in the orchestrator payload", async () => {
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
        conversation: { id: "conv-internal-1" },
        application: { id: "app-1" },
        validation: { passed: true, errors: [] },
        routerAiModel: "local-stage1-fallback",
        promptVersion: "stage1-local-v1"
      })
    } as any;
    const controller = new MessagesController(orchestrator, store);

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
            metadata: expect.objectContaining({
              byteSize: 2048
            })
          })
        ]
      })
    );
  });
});
