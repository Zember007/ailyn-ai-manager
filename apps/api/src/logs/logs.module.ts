import { Global, Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { BackendLogsService } from "./backend-logs.service.js";
import { LogsController } from "./logs.controller.js";

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [BackendLogsService],
  controllers: [LogsController],
  exports: [BackendLogsService]
})
export class LogsModule {}
