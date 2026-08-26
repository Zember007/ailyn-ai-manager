import { Controller, Get } from "@nestjs/common";
import { placeholderItems, type PlaceholderItem } from "../domain-placeholder.js";

@Controller("applications")
export class ApplicationsController {
  @Get()
  list(): PlaceholderItem[] {
    return placeholderItems("applications");
  }
}
