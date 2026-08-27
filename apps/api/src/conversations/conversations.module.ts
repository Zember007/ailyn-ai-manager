import { Module } from "@nestjs/common";
import { DialogueModule } from "../dialogue/dialogue.module.js";
import { ConversationsController } from "./conversations.controller.js";

@Module({ imports: [DialogueModule], controllers: [ConversationsController] })
export class ConversationsModule {}
