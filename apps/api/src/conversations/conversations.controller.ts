import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { createWebTestConversationSchema } from "@ailyn/schemas";
import { Stage1StoreService } from "../dialogue/stage1-store.service.js";

@Controller("conversations")
export class ConversationsController {
  constructor(private readonly store: Stage1StoreService) {}

  @Get()
  list() {
    return this.store.listConversations();
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    return (await this.store.getConversation(id)) ?? { error: "not_found" };
  }

  @Post("web-test")
  createWebTest(@Body() body: { externalContactId?: string; externalConversationId?: string }) {
    return this.store.createWebTestConversation(createWebTestConversationSchema.parse(body));
  }
}
