import { z } from "zod";

export const messageAuthorSchema = z.enum(["client", "manager", "system", "ai"]);
export const channelSchema = z.enum(["admin", "whatsapp", "telegram", "system"]);
export const stage1ChannelSchema = z.enum(["web-test", "wazzup"]);

export const createMessageSchema = z.object({
  conversationId: z.string().min(1),
  author: messageAuthorSchema,
  channel: channelSchema,
  body: z.string().min(1),
  externalMessageId: z.string().optional(),
  idempotencyKey: z.string().min(8)
});

export type CreateMessageInput = z.infer<typeof createMessageSchema>;

export const createWebTestConversationSchema = z.object({
  externalContactId: z.string().min(1).optional(),
  externalConversationId: z.string().min(1).optional()
});

export const testChatAttachmentSchema = z.object({
  id: z.string().optional(),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  byteSize: z.number().int().nonnegative().optional(),
  storageKey: z.string().optional()
});

export const sendTestChatMessageSchema = z.object({
  conversationId: z.string().min(1).optional(),
  externalContactId: z.string().min(1).optional(),
  externalConversationId: z.string().min(1).optional(),
  message: z.string().optional(),
  attachments: z.array(testChatAttachmentSchema).default([])
});

export const updateSettingsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.object({}).passthrough()]));

export const upsertKnowledgeItemSchema = z.object({
  id: z.string().optional(),
  key: z.string().min(1),
  category: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  answerRu: z.string().min(1),
  answerKg: z.string().optional(),
  conditions: z.record(z.string(), z.unknown()).optional(),
  priority: z.number().default(0),
  status: z.enum(["approved", "blocked", "draft"]),
  active: z.boolean()
});

export const runScenariosSchema = z.object({
  category: z.string().min(1).optional()
});

export type CreateWebTestConversationInput = z.infer<typeof createWebTestConversationSchema>;
export type SendTestChatMessageInput = z.infer<typeof sendTestChatMessageSchema>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
export type UpsertKnowledgeItemInput = z.infer<typeof upsertKnowledgeItemSchema>;
export type RunScenariosInput = z.infer<typeof runScenariosSchema>;
