import { Module } from "@nestjs/common";
import { FactsController } from "./facts.controller.js";

@Module({ controllers: [FactsController] })
export class FactsModule {}
