import type { ApplicationFacts } from "@ailyn/business-rules";
import { generatedDocumentationChunks } from "./documentation-chunks.generated.js";
import type { Stage1Message } from "./stage1-store.service.js";

type DocumentationChunk = (typeof generatedDocumentationChunks)[number];
type DocumentationStage = DocumentationChunk["primaryStage"];

const requiredDocumentKeys = ["id_front", "id_back", "vehicle_registration_front", "vehicle_registration_back"] as const;
// Chapter 5 is the approved answer base. It is deliberately supplied on every
// turn so an exact company answer never depends on lexical retrieval.
const commonKnowledge = generatedDocumentationChunks.filter((chunk) => /^5\./u.test(chunk.section));
const stageKeywords: Record<DocumentationStage, RegExp> = {
  application: /автомобил|машин|марка|модель|год|стоимост|цен|сумм|займ|доллар|евро|тенге|рубл|валют|курс|изменил|изменить|дороже|дешевле/u,
  residence: /пропис|регион|бишкек|чуй|токмок|насел[её]нн/u,
  documents: /документ|паспорт|\bid\b|стс|свидетельств|фото.*документ/u,
  vehicle_photos: /фото.*автомоб|фотограф.*автомоб|нет фот|не могу.*фото/u,
  family_status: /семейн|браке|женат|замуж|развод|супруг|согласие/u,
  guarantor: /поручител/u,
  visit: /визит|приех|дата|время|сегодня|завтра|понедель|вторник|среда|четверг|пятниц|суббот|воскресен|\bв\s*\d{1,2}\b/u
};

/**
 * Retrieval only: it chooses approved DOCX passages for the model, but never
 * selects a reply, changes a fact, or advances an application stage.
 */
export function selectRelevantDocumentation(input: {
  facts: ApplicationFacts;
  currentMessage?: string;
  messages: Stage1Message[];
  maxChunks?: number;
}): { stages: DocumentationStage[]; commonKnowledge: DocumentationChunk[]; knowledge: DocumentationChunk[] } {
  const current = `${input.currentMessage ?? ""} ${input.messages.slice(-3).map((message) => message.body).join(" ")}`.toLocaleLowerCase("ru-RU");
  const stages = relevantStages(input.facts, current);
  const tokens = new Set(current.match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const ranked = generatedDocumentationChunks
    .map((chunk, index) => ({ chunk, index, score: scoreChunk(chunk, index, stages, tokens, current) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const limit = input.maxChunks ?? 14;
  const selected: DocumentationChunk[] = [];
  for (const stage of stages) {
    const canonicalSection = stage === "family_status" ? /^5\.15\b/u : stage === "guarantor" ? /^5\.16\b/u : undefined;
    const match = canonicalSection ? ranked.find((item) => canonicalSection.test(item.chunk.section)) : undefined;
    if (match) selected.push(match.chunk);
  }
  for (const stage of stages) {
    const match = ranked.find((item) => !selected.includes(item.chunk) && item.chunk.primaryStage === stage)
      ?? ranked.find((item) => !selected.includes(item.chunk) && (item.chunk.stages as readonly DocumentationStage[]).includes(stage));
    if (match) selected.push(match.chunk);
  }
  for (const item of ranked) {
    if (selected.length >= limit) break;
    if (!selected.includes(item.chunk)) selected.push(item.chunk);
  }
  return { stages, commonKnowledge: [...commonKnowledge], knowledge: selected.slice(0, limit) };
}

function relevantStages(facts: ApplicationFacts, current: string): DocumentationStage[] {
  const stages = new Set<DocumentationStage>(["application"]);
  for (const [stage, pattern] of Object.entries(stageKeywords) as Array<[DocumentationStage, RegExp]>) {
    if (pattern.test(current)) stages.add(stage);
  }
  if (!facts.residenceRegion) stages.add("residence");
  const documentsComplete = requiredDocumentKeys.every((key) => facts.documents?.[key] === "received");
  if (!documentsComplete) stages.add("documents");
  if (documentsComplete && facts.documents?.car_photo !== "received" && !facts.declinedCarPhoto) stages.add("vehicle_photos");
  if (!facts.familyStatus || facts.familyStatus === "unknown") stages.add("family_status");
  if (facts.requestedProgram === "without_storage" && facts.residenceCategory === "OTHER_KG" && facts.guarantorAvailable === undefined) stages.add("guarantor");
  if (facts.visitDate || facts.visitTime || /визит|приех|дата|время/u.test(current)) stages.add("visit");
  return [...stages];
}

function scoreChunk(chunk: DocumentationChunk, index: number, stages: DocumentationStage[], tokens: Set<string>, current: string): number {
  const stageScore = stages.includes(chunk.primaryStage) ? 60 : chunk.stages.some((stage) => stages.includes(stage)) ? 25 : 0;
  const keywordScore = chunk.keywords.reduce((score, keyword) => score + (tokens.has(keyword) ? 8 : 0), 0);
  const targetedSectionScore =
    (/доллар|евро|тенге|рубл|валют|курс/u.test(current) && /^13\.1/u.test(chunk.section) ? 90 : 0) +
    (/семейн|браке|женат|замуж|развод|супруг/u.test(current) && /^5\.15/u.test(chunk.section) ? 90 : 0) +
    (/поручител/u.test(current) && /^5\.16/u.test(chunk.section) ? 90 : 0) +
    (/пропис|регион|бишкек|чуй|токмок/u.test(current) && /^5\.17/u.test(chunk.section) ? 70 : 0);
  return stageScore + keywordScore + targetedSectionScore + Math.max(0, 1 - index / 10_000);
}
