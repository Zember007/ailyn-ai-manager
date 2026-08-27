import { Controller, Get } from "@nestjs/common";
import { Stage1StoreService } from "../dialogue/stage1-store.service.js";

@Controller("contacts")
export class ContactsController {
  constructor(private readonly store: Stage1StoreService) {}

  @Get()
  list() {
    return this.store.listConversations().map((conversation) => ({
      id: conversation.contactId,
      externalContactId: conversation.externalContactId,
      conversationId: conversation.id
    }));
  }
}
