import { Injectable } from "@nestjs/common";
import { KnowledgeService } from "../knowledge/knowledge.service.js";
import type { KnowledgeAnswer } from "./pipeline.contracts.js";
import { DocumentationKnowledgeService } from "./documentation-knowledge.service.js";

@Injectable()
export class KnowledgeBaseResolverService {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly documentation: DocumentationKnowledgeService
  ) {}

  async resolve(questions: { text: string; topic?: string }[], language: "ru" | "kg"): Promise<KnowledgeAnswer[]> {
    const answers: KnowledgeAnswer[] = [];
    for (const question of questions) {
      // RouterAI assigns a semantic topic before this resolver runs. An
      // elliptical question may have no useful lexical overlap with the
      // approved answer ("зачем это нужно?"), so fall back to that topic
      // rather than returning to the previous collection question.
      const directItems = await this.knowledge.resolveAll(question.text, language);
      const items = directItems.length > 0 || !question.topic || question.topic === "general"
        ? directItems
        : await this.knowledge.resolveAll(question.topic, language);
      if (items.length) {
        for (const item of items) {
          answers.push({ key: item.key, text: language === "kg" && item.answerKg ? item.answerKg : item.answerRu, exact: true });
        }
      }
      const documentationAnswer = this.documentation.resolve(question.text);
      if (documentationAnswer) {
        answers.push({ ...documentationAnswer, exact: true });
      }
      if (items.length === 0 && !documentationAnswer) {
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
