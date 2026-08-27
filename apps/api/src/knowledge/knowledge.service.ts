import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../database/prisma.service.js";

export interface KnowledgeItemDto {
  id: string;
  key: string;
  category: string;
  aliases: string[];
  answerRu: string;
  answerKg?: string;
  conditions?: Record<string, unknown>;
  priority: number;
  status: "approved" | "blocked" | "draft";
  version: number;
  active: boolean;
}

const seeds: Omit<KnowledgeItemDto, "id">[] = [
  {
    key: "documents_required",
    category: "documents",
    aliases: ["документы", "что нужно взять"],
    answerRu: "Нужны фото ID и свидетельства о регистрации автомобиля с обеих сторон; оригиналы нужно взять на визит.",
    priority: 100,
    status: "approved",
    version: 1,
    active: true
  },
  {
    key: "existing_contract_redirect",
    category: "existing_contract",
    aliases: ["действующий договор", "оплата", "задолженность"],
    answerRu: "По действующему договору нужно обратиться к сотрудникам компании.",
    priority: 100,
    status: "approved",
    version: 1,
    active: true
  }
];

@Injectable()
export class KnowledgeService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<KnowledgeItemDto[]> {
    await this.ensureSeeds();
    const items = await this.prisma.knowledgeItem.findMany({ orderBy: [{ priority: "desc" }, { key: "asc" }] });
    return items.map((item) => ({
      id: item.id,
      key: item.key,
      category: item.category,
      aliases: Array.isArray(item.aliases) ? item.aliases.map(String) : [],
      answerRu: item.answerRu,
      answerKg: item.answerKg ?? undefined,
      conditions: asRecord(item.conditions),
      priority: item.priority,
      status: item.status as KnowledgeItemDto["status"],
      version: item.version,
      active: item.active
    }));
  }

  async upsert(item: Omit<KnowledgeItemDto, "id" | "version"> & { id?: string; version?: number }): Promise<KnowledgeItemDto> {
    const current = item.id
      ? await this.prisma.knowledgeItem.findUnique({ where: { id: item.id } })
      : await this.prisma.knowledgeItem.findUnique({ where: { key: item.key } });
    const saved = await this.prisma.knowledgeItem.upsert({
      where: { key: current?.key ?? item.key },
      create: {
        key: item.key,
        category: item.category,
        aliases: item.aliases,
        answerRu: item.answerRu,
        answerKg: item.answerKg,
        conditions: toJson(item.conditions ?? {}),
        priority: item.priority,
        status: item.status,
        version: 1,
        active: item.active
      },
      update: {
        category: item.category,
        aliases: item.aliases,
        answerRu: item.answerRu,
        answerKg: item.answerKg,
        conditions: toJson(item.conditions ?? {}),
        priority: item.priority,
        status: item.status,
        version: { increment: 1 },
        active: item.active
      }
    });
    return {
      id: saved.id,
      key: saved.key,
      category: saved.category,
      aliases: Array.isArray(saved.aliases) ? saved.aliases.map(String) : [],
      answerRu: saved.answerRu,
      answerKg: saved.answerKg ?? undefined,
      conditions: asRecord(saved.conditions),
      priority: saved.priority,
      status: saved.status as KnowledgeItemDto["status"],
      version: saved.version,
      active: saved.active
    };
  }

  private async ensureSeeds(): Promise<void> {
    for (const seed of seeds) {
      await this.prisma.knowledgeItem.upsert({
        where: { key: seed.key },
        create: {
          key: seed.key,
          category: seed.category,
          aliases: seed.aliases,
          answerRu: seed.answerRu,
          answerKg: seed.answerKg,
          conditions: toJson(seed.conditions ?? {}),
          priority: seed.priority,
          status: seed.status,
          version: seed.version,
          active: seed.active
        },
        update: {}
      });
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
