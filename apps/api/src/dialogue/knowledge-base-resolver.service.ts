import { Injectable } from "@nestjs/common";
import { KnowledgeService } from "../knowledge/knowledge.service.js";
import type { KnowledgeAnswer } from "./pipeline.contracts.js";

@Injectable()
export class KnowledgeBaseResolverService {
  constructor(private readonly knowledge: KnowledgeService) {}

  async resolve(questions: { text: string }[], language: "ru" | "kg"): Promise<KnowledgeAnswer[]> {
    const answers: KnowledgeAnswer[] = [];
    for (const question of questions) {
      const items = await this.knowledge.resolveAll(question.text, language);
      if (items.length) {
        for (const item of items) {
        answers.push({ key: item.key, text: language === "kg" && item.answerKg ? item.answerKg : item.answerRu, exact: true });
        }
      } else {
        const fallback = await this.knowledge.fallback();
        answers.push({ key: fallback.key, text: fallback.answerRu, exact: true, blocked: true });
      }
    }
    return deduplicate(answers);
  }
}

function deduplicate(answers: KnowledgeAnswer[]): KnowledgeAnswer[] {
  return answers.filter((answer, index) => answers.findIndex((item) => item.key === answer.key) === index);
}
