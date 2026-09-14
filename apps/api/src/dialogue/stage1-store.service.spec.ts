import { describe, expect, it, vi } from "vitest";
import { Stage1StoreService } from "./stage1-store.service.js";

describe("Stage1StoreService", () => {
  it("resolves a conversation by internal id and channel", async () => {
    const prisma = {
      conversation: {
        findFirst: vi.fn().mockResolvedValue({
          id: "conv-1",
          contactId: "contact-1",
          externalConversationId: "web-conversation-1",
          status: "open",
          channel: "web_test",
          createdAt: new Date("2026-08-28T10:00:00.000Z"),
          updatedAt: new Date("2026-08-28T10:00:00.000Z"),
          contact: { externalContactId: "web-client-1" },
          messages: [],
          applications: []
        })
      }
    } as any;
    const service = new Stage1StoreService(prisma);

    const conversation = await service.getConversationByIdForChannel("conv-1", "web-test");

    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "conv-1",
          channel: "web_test"
        }
      })
    );
    expect(conversation).toMatchObject({
      id: "conv-1",
      externalConversationId: "web-conversation-1",
      externalContactId: "web-client-1",
      channel: "web-test"
    });
  });

  it("keeps externalConversationId lookup as the fallback path in getOrCreateConversation", async () => {
    const prisma = {
      conversation: {
        findFirst: vi.fn().mockResolvedValue({
          id: "conv-2",
          contactId: "contact-2",
          externalConversationId: "web-conversation-2",
          status: "open",
          channel: "web_test",
          createdAt: new Date("2026-08-28T10:00:00.000Z"),
          updatedAt: new Date("2026-08-28T10:00:00.000Z"),
          contact: { externalContactId: "web-client-2" },
          messages: [],
          applications: [
            {
              id: "app-2",
              publicId: "28-08-26-1",
              conversationId: "conv-2",
              contactId: "contact-2",
              state: "NEW",
              metadata: { status: "need_more_data" },
              facts: [],
              factHistory: [],
              createdAt: new Date("2026-08-28T10:00:00.000Z"),
              updatedAt: new Date("2026-08-28T10:00:00.000Z")
            }
          ]
        })
      }
    } as any;
    const service = new Stage1StoreService(prisma);

    const result = await service.getOrCreateConversation({
      externalContactId: "web-client-2",
      externalConversationId: "web-conversation-2",
      channel: "web-test"
    });

    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          channel: "web_test",
          externalConversationId: "web-conversation-2"
        }
      })
    );
    expect(result.isNew).toBe(false);
    expect(result.conversation.id).toBe("conv-2");
    expect(result.application.id).toBe("app-2");
    expect(result.application.publicId).toBe("28-08-26-1");
  });
});
