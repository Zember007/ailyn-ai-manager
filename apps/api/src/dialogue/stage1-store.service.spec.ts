import { describe, expect, it, vi } from "vitest";
import { Stage1StoreService } from "./stage1-store.service.js";

describe("Stage1StoreService", () => {
  it("creates a clean repeat application from a closed application without changing its history", async () => {
    const saved = {
      id: "new-app",
      publicId: "16-09-26-2",
      conversationId: "conversation-1",
      contactId: "contact-1",
      state: "NEW",
      metadata: { status: "need_more_data", previousApplicationId: "closed-app" },
      facts: [],
      factHistory: [],
      createdAt: new Date("2026-09-16T12:00:00.000Z"),
      updatedAt: new Date("2026-09-16T12:00:00.000Z")
    };
    const prisma = {
      $transaction: vi.fn().mockImplementation((callback: (transaction: unknown) => unknown) => callback(prisma)),
      application: {
        count: vi.fn().mockResolvedValue(1),
        create: vi.fn().mockResolvedValue(saved),
        findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ ...saved, facts: [
          { key: "fullName", value: "Иванов Иван" },
          { key: "residenceRegion", value: "Бишкек" },
          { key: "familyStatus", value: "married" },
          { key: "documents", value: { id_front: "received", id_back: "received" } }
        ] }),
        update: vi.fn().mockResolvedValue(undefined)
      },
      applicationFact: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(undefined) },
      factHistory: { create: vi.fn().mockResolvedValue(undefined) },
      conversation: { update: vi.fn().mockResolvedValue(undefined) },
      contact: { findUnique: vi.fn().mockResolvedValue({ metadata: { clientProfile: { familyStatus: "married" } } }), update: vi.fn().mockResolvedValue(undefined) },
      auditEvent: { create: vi.fn().mockResolvedValue(undefined) }
    } as any;
    const service = new Stage1StoreService(prisma);
    const closed = {
      id: "closed-app",
      contactId: "contact-1",
      stage: "CLOSED",
      status: "target_reached",
      facts: {
        fullName: "Иванов Иван",
        residenceRegion: "Бишкек",
        familyStatus: "single",
        vehicleMake: "Toyota",
        vehicleModel: "Camry",
        vehicleYear: 2018,
        vehicleValue: 1_500_000,
        requestedAmount: 500_000,
        documents: {
          id_front: "received",
          id_back: "received",
          vehicle_registration_front: "received",
          vehicle_registration_back: "received"
        }
      }
    } as any;

    const created = await service.createRepeatLoanApplication({ id: "conversation-1", contactId: "contact-1" } as any, closed);

    expect(prisma.application.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        conversationId: "conversation-1",
        contactId: "contact-1",
        state: "NEW",
        idempotencyKey: "repeat-loan-closed-app",
        metadata: { status: "need_more_data", previousApplicationId: "closed-app" }
      })
    }));
    expect(created.id).toBe("new-app");
    expect(created.facts).toEqual({
      fullName: "Иванов Иван",
      residenceRegion: "Бишкек",
      familyStatus: "married",
      documents: { id_front: "received", id_back: "received" }
    });
    expect(closed.facts.vehicleMake).toBe("Toyota");
  });

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
