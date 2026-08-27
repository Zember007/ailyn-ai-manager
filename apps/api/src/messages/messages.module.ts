import { Module } from "@nestjs/common";
import { DialogueModule } from "../dialogue/dialogue.module.js";
import { MessagesController } from "./messages.controller.js";

@Module({ imports: [DialogueModule], controllers: [MessagesController] })
export class MessagesModule {}
