import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Redis, type Redis as RedisClient } from "ioredis";
import { loadAppConfig } from "@ailyn/config";

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client = new Redis(loadAppConfig().redisUrl, {
    maxRetriesPerRequest: 1,
    lazyConnect: true
  });

  async ping(): Promise<void> {
    if (this.client.status === "wait") {
      await this.client.connect();
    }
    await this.client.ping();
  }

  getConnection(): RedisClient {
    return this.client;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
