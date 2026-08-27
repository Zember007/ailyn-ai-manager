import type { InboundMessage } from "../channel.interface.js";

export class WazzupMapper {
  mapWebhookPayload(payload: Record<string, unknown>): InboundMessage {
    const messageId = String(payload.messageId ?? payload.id ?? "");
    const contactId = String(payload.contactId ?? payload.chatId ?? payload.phone ?? "");

    return {
      externalMessageId: messageId || `wazzup-${Date.now()}`,
      channel: "wazzup",
      externalContactId: contactId || "unknown-wazzup-contact",
      externalConversationId: String(payload.chatId ?? contactId),
      text: typeof payload.text === "string" ? payload.text : undefined,
      attachments: [],
      timestamp: new Date(typeof payload.timestamp === "string" ? payload.timestamp : Date.now()),
      metadata: { rawProviderPayload: payload }
    };
  }
}
