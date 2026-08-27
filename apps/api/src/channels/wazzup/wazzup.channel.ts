import { Injectable } from "@nestjs/common";
import type { MessagingChannel, OutboundMessage, SendResult } from "../channel.interface.js";
import { WazzupClient } from "./wazzup.client.js";

@Injectable()
export class WazzupChannel implements MessagingChannel {
  constructor(private readonly client: WazzupClient) {}

  async sendMessage(_input: OutboundMessage): Promise<SendResult> {
    if (!this.client.isConfigured()) {
      return { externalMessageId: "wazzup-unconfigured", status: "failed" };
    }
    throw new Error("Wazzup outbound API must be finalized from official documentation before Stage 3.");
  }
}
