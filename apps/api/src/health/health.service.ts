import { Injectable } from "@nestjs/common";
import type { ApiHealthResponse, HealthDependency } from "@ailyn/shared";
import { AiService } from "../ai/ai.service.js";
import type { PrismaService } from "../database/prisma.service.js";
import type { RedisService } from "../database/redis.service.js";

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly ai: AiService
  ) {}

  async getHealth(): Promise<ApiHealthResponse> {
    const [postgres, redis] = await Promise.all([
      this.checkDependency(() => this.prisma.ping()),
      this.checkDependency(() => this.redis.ping())
    ]);
    const ai = this.ai.getStatus();
    const status = postgres.status === "ok" && redis.status === "ok" ? "ok" : "degraded";

    return {
      status,
      version: process.env.APP_VERSION ?? "0.1.0",
      dependencies: { postgres, redis, ai },
      checkedAt: new Date().toISOString()
    };
  }

  private async checkDependency(check: () => Promise<void>): Promise<HealthDependency> {
    const started = Date.now();
    try {
      await check();
      return { status: "ok", latencyMs: Date.now() - started };
    } catch (error) {
      return {
        status: "error",
        latencyMs: Date.now() - started,
        message: error instanceof Error ? error.message : "Unknown error"
      };
    }
  }
}
