import { Injectable } from "@nestjs/common";

export interface KnowledgeItemDto {
  id: string;
  key: string;
  category: string;
  aliases: string[];
  answerRu: string;
  answerKg?: string;
  conditions?: Record<string, unknown>;
  priority: number;
  status: "approved" | "blocked" | "draft";
  version: number;
  active: boolean;
}

@Injectable()
export class KnowledgeService {
  private readonly items = new Map<string, KnowledgeItemDto>([
    [
      "documents_required",
      {
        id: "ki-documents-required",
        key: "documents_required",
        category: "documents",
        aliases: ["документы", "что нужно взять"],
        answerRu: "Нужны фото ID и свидетельства о регистрации автомобиля с обеих сторон; оригиналы нужно взять на визит.",
        priority: 100,
        status: "approved",
        version: 1,
        active: true
      }
    ],
    [
      "existing_contract_redirect",
      {
        id: "ki-existing-contract",
        key: "existing_contract_redirect",
        category: "existing_contract",
        aliases: ["действующий договор", "оплата", "задолженность"],
        answerRu: "По действующему договору нужно обратиться к сотрудникам компании.",
        priority: 100,
        status: "approved",
        version: 1,
        active: true
      }
    ]
  ]);

  list(): KnowledgeItemDto[] {
    return [...this.items.values()];
  }

  upsert(item: Omit<KnowledgeItemDto, "id" | "version"> & { id?: string; version?: number }): KnowledgeItemDto {
    const id = item.id ?? `ki-${crypto.randomUUID()}`;
    const current = this.items.get(id);
    const saved: KnowledgeItemDto = {
      ...item,
      id,
      version: item.version ?? (current ? current.version + 1 : 1)
    };
    this.items.set(id, saved);
    return saved;
  }
}
