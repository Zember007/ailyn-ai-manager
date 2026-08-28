import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { DATABASE_SCHEMA_MISSING_CODE } from "./prisma-errors.js";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
    const rows = await this.$queryRawUnsafe<Array<{ table_name: string; relation_name: string | null }>>(
      `SELECT * FROM (VALUES
        ('Conversation', to_regclass('public."Conversation"')::text),
        ('ScenarioRun', to_regclass('public."ScenarioRun"')::text),
        ('Setting', to_regclass('public."Setting"')::text),
        ('KnowledgeItem', to_regclass('public."KnowledgeItem"')::text)
      ) AS required_tables(table_name, relation_name)`
    );
    const missing = rows.filter((row) => !row.relation_name).map((row) => row.table_name);
    if (missing.length > 0) {
      throw new Error(`${DATABASE_SCHEMA_MISSING_CODE}:${missing.join(",")}`);
    }
  }
}
