import { Body, Controller, Get, Post } from "@nestjs/common";
import { sendTestChatMessageSchema } from "@ailyn/schemas";
import { DialogueOrchestratorService } from "../dialogue/dialogue-orchestrator.service.js";
import { Stage1StoreService } from "../dialogue/stage1-store.service.js";

interface TestChatBody {
  message?: string;
  conversationId?: string;
  externalContactId?: string;
  attachments?: { id?: string; fileName?: string; mimeType?: string; kindHint?: string }[];
}

@Controller("messages")
export class MessagesController {
  constructor(
    private readonly orchestrator: DialogueOrchestratorService,
    private readonly store: Stage1StoreService
  ) {}

  @Get()
  list() {
    return this.store.listMessages();
  }

  @Post("test-chat")
  async testChat(@Body() body: TestChatBody) {
    const parsed = sendTestChatMessageSchema.parse(body);
    const result = await this.orchestrator.receive({
      externalMessageId: `web-in-${crypto.randomUUID()}`,
      channel: "web-test",
      externalContactId: parsed.externalContactId ?? "stage1-web-client",
      externalConversationId: parsed.conversationId ?? "stage1-web-conversation",
      text: parsed.message,
      attachments: parsed.attachments.map((attachment) => ({
        id: attachment.id ?? `upload-${crypto.randomUUID()}`,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        kindHint: attachment.kindHint
      })),
      timestamp: new Date()
    });

    return {
      reply: result.reply,
      persisted: true,
      conversation: result.conversation,
      application: result.application,
      validation: result.validation,
      routerAiModel: result.routerAiModel,
      promptVersion: result.promptVersion
    };
  }
}
