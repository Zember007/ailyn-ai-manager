import { Module } from "@nestjs/common";
import { ApplicationsController } from "./applications.controller.js";

@Module({ controllers: [ApplicationsController] })
export class ApplicationsModule {}
