import { describe, expect, it } from "vitest";
import { HealthService } from "./health.service.js";

describe("HealthService", () => {
  it("reports ok when database and redis checks pass while AI is unconfigured", async () => {
    const service = new HealthService(
      { ping: async () => undefined } as any,
      { ping: async () => undefined } as any,
      { getStatus: () => ({ status: "unconfigured" }) } as any
    );

    const health = await service.getHealth();

    expect(health.status).toBe("ok");
    expect(health.dependencies.postgres.status).toBe("ok");
    expect(health.dependencies.redis.status).toBe("ok");
    expect(health.dependencies.ai.status).toBe("unconfigured");
  });
});
