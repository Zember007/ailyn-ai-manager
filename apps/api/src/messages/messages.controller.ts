import { Body, Controller, Get, Post } from "@nestjs/common";
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
    const result = await this.orchestrator.receive({
      externalMessageId: `web-in-${crypto.randomUUID()}`,
      channel: "web-test",
      externalContactId: body.externalContactId ?? "stage1-web-client",
      externalConversationId: body.conversationId ?? "stage1-web-conversation",
      text: body.message,
      attachments: (body.attachments ?? []).map((attachment) => ({
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
