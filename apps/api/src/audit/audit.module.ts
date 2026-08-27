import { Module } from "@nestjs/common";
import { DialogueModule } from "../dialogue/dialogue.module.js";
import { AuditController } from "./audit.controller.js";

@Module({ imports: [DialogueModule], controllers: [AuditController] })
export class AuditModule {}
