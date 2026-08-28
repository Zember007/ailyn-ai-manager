import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../database/prisma.service.js";

export interface BackendLogEntry {
  id: string;
  level: string;
  context: string;
  message: string;
  requestId?: string;
  method?: string;
  path?: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
  stack?: string;
  createdAt: string;
}

export interface BackendLogInput {
  level: "debug" | "log" | "warn" | "error";
  context: string;
  message: string;
  requestId?: string;
  method?: string;
  path?: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
  stack?: string;
}

@Injectable()
export class BackendLogsService {
  private readonly logger = new Logger(BackendLogsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(limit = 200, filters: { conversationId?: string } = {}): Promise<BackendLogEntry[]> {
    const rows = await this.prisma.backendLog.findMany({
      where: {
        conversationId: filters.conversationId
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 500)
    });

    return rows.map((row) => ({
      id: row.id,
      level: row.level,
      context: row.context,
      message: row.message,
      requestId: row.requestId ?? undefined,
      method: row.method ?? undefined,
      path: row.path ?? undefined,
      conversationId: row.conversationId ?? undefined,
      metadata: asRecord(row.metadata),
      stack: row.stack ?? undefined,
      createdAt: row.createdAt.toISOString()
    }));
  }

  async debug(context: string, message: string, options: Omit<BackendLogInput, "context" | "message" | "level"> = {}): Promise<void> {
    await this.record({ ...options, context, message, level: "debug" });
  }

  async log(context: string, message: string, options: Omit<BackendLogInput, "context" | "message" | "level"> = {}): Promise<void> {
    await this.record({ ...options, context, message, level: "log" });
  }

  async warn(context: string, message: string, options: Omit<BackendLogInput, "context" | "message" | "level"> = {}): Promise<void> {
    await this.record({ ...options, context, message, level: "warn" });
  }

  async error(context: string, message: string, options: Omit<BackendLogInput, "context" | "message" | "level"> = {}): Promise<void> {
    await this.record({ ...options, context, message, level: "error" });
  }

  private async record(entry: BackendLogInput): Promise<void> {
    this.writeToConsole(entry);

    try {
      await this.prisma.backendLog.create({
        data: {
          level: entry.level,
          context: entry.context,
          message: entry.message,
          requestId: entry.requestId,
          method: entry.method,
          path: entry.path,
          conversationId: entry.conversationId,
          metadata: toJson(entry.metadata ?? {}),
          stack: entry.stack
        }
      });
    } catch (error) {
      const fallback = error instanceof Error ? error.message : "unknown logging error";
      this.logger.error(`Failed to persist backend log: ${fallback}`);
    }
  }

  private writeToConsole(entry: BackendLogInput): void {
    const text = `${entry.context}: ${entry.message}`;
    if (entry.level === "error") {
      this.logger.error(text, entry.stack);
      return;
    }
    if (entry.level === "warn") {
      this.logger.warn(text);
      return;
    }
    if (entry.level === "debug") {
      this.logger.debug(text);
      return;
    }
    this.logger.log(text);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}
