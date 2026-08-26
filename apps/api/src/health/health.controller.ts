import { Controller, Get } from "@nestjs/common";
import type { ApiHealthResponse } from "@ailyn/shared";
import { HealthService } from "./health.service.js";

@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  async getHealth(): Promise<ApiHealthResponse> {
    return this.healthService.getHealth();
  }
}
