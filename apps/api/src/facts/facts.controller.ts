import { Controller, Get } from "@nestjs/common";
import { placeholderItems, type PlaceholderItem } from "../domain-placeholder.js";

@Controller("facts")
export class FactsController {
  @Get()
  list(): PlaceholderItem[] {
    return placeholderItems("facts");
  }
}
