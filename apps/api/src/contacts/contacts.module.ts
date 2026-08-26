import { Module } from "@nestjs/common";
import { ContactsController } from "./contacts.controller.js";

@Module({ controllers: [ContactsController] })
export class ContactsModule {}
