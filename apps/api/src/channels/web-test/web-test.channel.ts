import { Injectable } from "@nestjs/common";
import type { MessagingChannel, OutboundMessage, SendResult } from "../channel.interface.js";

@Injectable()
export class WebTestChannel implements MessagingChannel {
  async sendMessage(_input: OutboundMessage): Promise<SendResult> {
    return {
      externalMessageId: `web-test-out-${Date.now()}`,
      status: "sent"
    };
  }
}
