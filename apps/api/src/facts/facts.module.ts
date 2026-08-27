import { Module } from "@nestjs/common";
import { DialogueModule } from "../dialogue/dialogue.module.js";
import { FactsController } from "./facts.controller.js";

@Module({ imports: [DialogueModule], controllers: [FactsController] })
export class FactsModule {}
