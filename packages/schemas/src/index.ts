import { z } from "zod";

export const messageAuthorSchema = z.enum(["client", "manager", "system", "ai"]);
export const channelSchema = z.enum(["admin", "whatsapp", "telegram", "system"]);

export const createMessageSchema = z.object({
  conversationId: z.string().min(1),
  author: messageAuthorSchema,
  channel: channelSchema,
  body: z.string().min(1),
  externalMessageId: z.string().optional(),
  idempotencyKey: z.string().min(8)
});

export type CreateMessageInput = z.infer<typeof createMessageSchema>;
