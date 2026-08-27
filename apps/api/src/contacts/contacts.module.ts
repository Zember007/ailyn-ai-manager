import { Module } from "@nestjs/common";
import { DialogueModule } from "../dialogue/dialogue.module.js";
import { ContactsController } from "./contacts.controller.js";

@Module({ imports: [DialogueModule], controllers: [ContactsController] })
export class ContactsModule {}
