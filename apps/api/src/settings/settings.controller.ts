import { Body, Controller, Get, Patch } from "@nestjs/common";
import { SettingsService, type Stage1Settings } from "./settings.service.js";

@Controller("settings")
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get() {
    return this.settings.get();
  }

  @Patch()
  update(@Body() body: Partial<Stage1Settings>) {
    return this.settings.update(body);
  }
}
