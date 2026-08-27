import { Module } from "@nestjs/common";
import { ScenariosController } from "./scenarios.controller.js";
import { ScenariosService } from "./scenarios.service.js";

@Module({
  controllers: [ScenariosController],
  providers: [ScenariosService],
  exports: [ScenariosService]
})
export class ScenariosModule {}
