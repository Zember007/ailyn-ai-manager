export interface InboundAttachment {
  id: string;
  mimeType?: string;
  fileName?: string;
  kindHint?: string;
  contentBase64?: string;
  textContent?: string;
  metadata?: Record<string, unknown>;
}

export interface InboundMessage {
  externalMessageId: string;
  channel: "web-test" | "wazzup";
  externalContactId: string;
  externalConversationId?: string;
  text?: string;
  attachments: InboundAttachment[];
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface OutboundMessage {
  conversationId: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface OutboundMedia {
  conversationId: string;
  attachmentId: string;
  caption?: string;
}

export interface SendResult {
  externalMessageId: string;
  status: "sent" | "queued" | "failed";
}

export interface MessagingChannel {
  sendMessage(input: OutboundMessage): Promise<SendResult>;
  sendMedia?(input: OutboundMedia): Promise<SendResult>;
}
