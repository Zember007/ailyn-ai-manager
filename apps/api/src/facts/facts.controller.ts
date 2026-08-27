import { Controller, Get } from "@nestjs/common";
import { Stage1StoreService } from "../dialogue/stage1-store.service.js";

@Controller("facts")
export class FactsController {
  constructor(private readonly store: Stage1StoreService) {}

  @Get()
  list() {
    return this.store.listFacts();
  }
}
