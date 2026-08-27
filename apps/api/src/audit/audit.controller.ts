import { Controller, Get } from "@nestjs/common";
import { Stage1StoreService } from "../dialogue/stage1-store.service.js";

@Controller("audit")
export class AuditController {
  constructor(private readonly store: Stage1StoreService) {}

  @Get()
  list() {
    return this.store.listAudit();
  }
}
