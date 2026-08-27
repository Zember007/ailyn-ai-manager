import { Controller, Get, Param } from "@nestjs/common";
import { Stage1StoreService } from "../dialogue/stage1-store.service.js";

@Controller("conversations")
export class ConversationsController {
  constructor(private readonly store: Stage1StoreService) {}

  @Get()
  list() {
    return this.store.listConversations();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.store.getConversation(id) ?? { error: "not_found" };
  }
}
