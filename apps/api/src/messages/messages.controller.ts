import { Body, Controller, Get, Post } from "@nestjs/common";
import { placeholderItems, type PlaceholderItem } from "../domain-placeholder.js";

@Controller("messages")
export class MessagesController {
  @Get()
  list(): PlaceholderItem[] {
    return placeholderItems("messages");
  }

  @Post("test-chat")
  testChat(@Body() body: { message?: string }): { reply: string; persisted: boolean } {
    return {
      reply: `Stage 1 echo: ${body.message ?? ""}`.trim(),
      persisted: false
    };
  }
}
