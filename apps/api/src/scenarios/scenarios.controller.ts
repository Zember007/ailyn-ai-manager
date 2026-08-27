import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ScenariosService } from "./scenarios.service.js";

@Controller("scenarios")
export class ScenariosController {
  constructor(private readonly scenarios: ScenariosService) {}

  @Get()
  list() {
    return this.scenarios.list();
  }

  @Get("runs")
  listRuns() {
    return this.scenarios.listRuns();
  }

  @Get("runs/:id")
  getRun(@Param("id") id: string) {
    return this.scenarios.getRun(id) ?? { error: "not_found" };
  }

  @Post("run")
  run(@Body() body: { category?: string }) {
    return this.scenarios.runAll(body.category);
  }
}
