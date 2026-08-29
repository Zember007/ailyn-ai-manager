import { BadRequestException, Body, Controller, Get, NotFoundException, Post, UploadedFiles, UseInterceptors } from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { sendTestChatMessageSchema } from "@ailyn/schemas";
import { DialogueOrchestratorService } from "../dialogue/dialogue-orchestrator.service.js";
import { Stage1StoreService } from "../dialogue/stage1-store.service.js";
import { BackendLogsService } from "../logs/backend-logs.service.js";

interface TestChatBody {
  message?: string;
  conversationId?: string;
  externalContactId?: string;
  externalConversationId?: string;
  attachments?:
    | { id?: string; fileName?: string; mimeType?: string; byteSize?: number; storageKey?: string }[]
    | string;
}

@Controller("messages")
export class MessagesController {
  constructor(
    private readonly orchestrator: DialogueOrchestratorService,
    private readonly store: Stage1StoreService,
    private readonly logs: BackendLogsService
  ) {}

  @Get()
  list() {
    return this.store.listMessages();
  }

  @Post("test-chat")
  @UseInterceptors(FilesInterceptor("files"))
  async testChat(@Body() body: TestChatBody, @UploadedFiles() files: Array<{ originalname: string; mimetype: string; size: number; buffer: Buffer }> = []) {
    const parsed = sendTestChatMessageSchema.parse(normalizeBody(body));
    if (!parsed.message?.trim() && parsed.attachments.length === 0 && files.length === 0) {
      throw new BadRequestException("message_empty");
    }

    let targetConversation = undefined;
    if (parsed.conversationId) {
      targetConversation = await this.store.getConversationByIdForChannel(parsed.conversationId, "web-test");
      if (!targetConversation) {
        throw new NotFoundException("conversation_not_found");
      }

      await this.logs.debug("messages.test-chat", "Resolved existing web-test conversation", {
        conversationId: targetConversation.id,
        metadata: {
          externalConversationId: targetConversation.externalConversationId,
          externalContactId: targetConversation.externalContactId
        }
      });
    }

    const resolvedConversationId = targetConversation?.id;
    const resolvedExternalConversationId = targetConversation?.externalConversationId || parsed.externalConversationId;
    const input = {
      externalMessageId: `web-in-${crypto.randomUUID()}`,
      channel: "web-test" as const,
      externalContactId: targetConversation?.externalContactId || parsed.externalContactId || "stage1-web-client",
      externalConversationId: resolvedExternalConversationId ?? "stage1-web-conversation",
      text: parsed.message?.trim(),
      attachments: [
        ...parsed.attachments.map((attachment) => ({
          id: attachment.id ?? `upload-${crypto.randomUUID()}`,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          contentBase64: attachment.contentBase64,
          textContent: attachment.textContent,
          metadata: {
            byteSize: attachment.byteSize,
            storageKey: attachment.storageKey
          }
        })),
        ...files.map((file) => ({
          id: `upload-${crypto.randomUUID()}`,
          fileName: file.originalname,
          mimeType: file.mimetype,
          contentBase64: file.buffer.toString("base64"),
          textContent: extractTextContent(file.mimetype, file.buffer),
          metadata: {
            byteSize: file.size,
            storageKey: `web-test/${Date.now()}-${sanitizeFileName(file.originalname)}`
          }
        }))
      ].map((attachment) => ({
        id: attachment.id ?? `upload-${crypto.randomUUID()}`,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        contentBase64: attachment.contentBase64,
        textContent: attachment.textContent,
        metadata: attachment.metadata
      })),
      timestamp: new Date()
    };

    await this.logs.log("messages.test-chat", "Received test chat message", {
      conversationId: resolvedConversationId,
      metadata: {
        textLength: input.text?.length ?? 0,
        attachments: input.attachments.length,
        hasKnownConversation: Boolean(targetConversation)
      }
    });

    const result = await this.orchestrator.receive(input);

    return {
      reply: result.reply,
      persisted: true,
      conversation: result.conversation,
      conversationId: result.conversation.id,
      application: result.application ?? result.conversation.application,
      validation: result.validation,
      routerAiModel: result.routerAiModel,
      promptVersion: result.promptVersion
    };
  }
}

function normalizeBody(body: TestChatBody): TestChatBody {
  const attachments = Array.isArray(body.attachments)
    ? body.attachments
    : typeof body.attachments === "string" && body.attachments.trim()
      ? JSON.parse(body.attachments) as TestChatBody["attachments"]
      : [];
  return {
    ...body,
    attachments
  };
}

function sanitizeFileName(fileName: string): string {
  const normalized = fileName.trim().replace(/\s+/g, "-");
  return normalized.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 120) || "upload.bin";
}

function extractTextContent(mimeType: string, buffer: Buffer): string | undefined {
  const normalizedMimeType = mimeType.toLowerCase();
  if (
    normalizedMimeType.startsWith("text/") ||
    normalizedMimeType === "application/json" ||
    normalizedMimeType === "application/xml" ||
    normalizedMimeType === "text/xml" ||
    normalizedMimeType === "application/csv"
  ) {
    return buffer.toString("utf8", 0, Math.min(buffer.length, 24_000));
  }

  return undefined;
}
