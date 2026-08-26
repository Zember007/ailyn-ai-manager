import { Controller, Get } from "@nestjs/common";
import { placeholderItems, type PlaceholderItem } from "../domain-placeholder.js";

@Controller("contacts")
export class ContactsController {
  @Get()
  list(): PlaceholderItem[] {
    return placeholderItems("contacts");
  }
}
