import { Module } from "@nestjs/common";
import { DialogueModule } from "../dialogue/dialogue.module.js";
import { ApplicationsController } from "./applications.controller.js";

@Module({ imports: [DialogueModule], controllers: [ApplicationsController] })
export class ApplicationsModule {}
