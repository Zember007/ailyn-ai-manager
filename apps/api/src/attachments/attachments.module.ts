import { Module } from "@nestjs/common";
import { DialogueModule } from "../dialogue/dialogue.module.js";
import { AttachmentsController } from "./attachments.controller.js";

@Module({ imports: [DialogueModule], controllers: [AttachmentsController] })
export class AttachmentsModule {}
