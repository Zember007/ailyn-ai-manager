import { Controller, Get } from "@nestjs/common";
import { placeholderItems, type PlaceholderItem } from "../domain-placeholder.js";

@Controller("conversations")
export class ConversationsController {
  @Get()
  list(): PlaceholderItem[] {
    return placeholderItems("conversations");
  }
}
