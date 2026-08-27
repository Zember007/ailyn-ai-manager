import { Body, Controller, Get, Post } from "@nestjs/common";
import { KnowledgeService, type KnowledgeItemDto } from "./knowledge.service.js";

@Controller("knowledge")
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  list() {
    return this.knowledge.list();
  }

  @Post()
  upsert(@Body() body: Omit<KnowledgeItemDto, "id" | "version"> & { id?: string; version?: number }) {
    return this.knowledge.upsert(body);
  }
}
