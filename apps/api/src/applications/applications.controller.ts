import { Controller, Get, Param } from "@nestjs/common";
import { Stage1StoreService } from "../dialogue/stage1-store.service.js";

@Controller("applications")
export class ApplicationsController {
  constructor(private readonly store: Stage1StoreService) {}

  @Get()
  list() {
    return this.store.listApplications();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.store.getApplication(id) ?? { error: "not_found" };
  }
}
