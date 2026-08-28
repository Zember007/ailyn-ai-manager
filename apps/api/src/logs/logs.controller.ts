import { Controller, Get, Query } from "@nestjs/common";
import { BackendLogsService } from "./backend-logs.service.js";

@Controller("logs")
export class LogsController {
  constructor(private readonly logs: BackendLogsService) {}

  @Get()
  list(@Query("limit") limit?: string, @Query("conversationId") conversationId?: string) {
    const parsedLimit = Number(limit ?? "200");
    return this.logs.list(Number.isFinite(parsedLimit) ? parsedLimit : 200, {
      conversationId: typeof conversationId === "string" && conversationId.trim() ? conversationId : undefined
    });
  }
}
