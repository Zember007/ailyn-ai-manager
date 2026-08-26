import { Module } from "@nestjs/common";
import { MessagesController } from "./messages.controller.js";

@Module({ controllers: [MessagesController] })
export class MessagesModule {}
