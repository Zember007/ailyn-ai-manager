import type { ApplicationFacts } from "@ailyn/business-rules";
import { generatedDocumentationChunks } from "./documentation-chunks.generated.js";
import { agentStageInstructions } from "./agent-stage-instructions.js";
import type { Stage1Message } from "./stage1-store.service.js";

type DocumentationChunk = (typeof generatedDocumentationChunks)[number];
type DocumentationStage = DocumentationChunk["primaryStage"];
const stageInstructionsByStage: Partial<Record<DocumentationStage, string>> = agentStageInstructions;

const requiredDocumentKeys = ["id_front", "id_back", "vehicle_registration_front", "vehicle_registration_back"] as const;
// These passages are safe to expose on every turn: global answer rules plus
// short, high-frequency FAQ/redirect answers (including timing and existing
// contract handling). The remaining product rules arrive only with the stage
// where they can affect the reply, so unrelated branches do not compete for
// the model's attention.
const commonKnowledge = [
  findChunk((chunk) => chunk.section === "5.1"),
  findChunk((chunk) => chunk.section === "5.25"),
  findChunk((chunk) => chunk.text.includes("Я Айлин — виртуальный помощник")),
  findChunk((chunk) => /осмотр.*5 минут|5 минут.*осмотр/u.test(chunk.text)),
  findChunk((chunk) => chunk.section === "5.23.1")
].filter((chunk): chunk is DocumentationChunk => Boolean(chunk));
const stageKeywords: Record<DocumentationStage, RegExp> = {
  application: /автомобил|машин|марка|модель|год|стоимост|цен|сумм|займ|доллар|евро|тенге|рубл|валют|курс|изменил|изменить|дороже|дешевле|изъят|стоян|долго|длится|сколько\s+времен|оформля|осмотр|оценк/u,
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
  includeCrossStageMatches?: boolean;
}): { stages: DocumentationStage[]; commonKnowledge: DocumentationChunk[]; knowledge: DocumentationChunk[]; stageInstructions: string[] } {
  const current = `${input.currentMessage ?? ""} ${input.messages.slice(-3).map((message) => message.body).join(" ")}`.toLocaleLowerCase("ru-RU");
  const stages = relevantStages(input.facts, current);
  const tokens = new Set(current.match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const ranked = generatedDocumentationChunks
    .map((chunk, index) => ({ chunk, index, score: scoreChunk(chunk, index, stages, tokens, current) }))
    .filter((item) => item.score > 0 && (input.includeCrossStageMatches || chunkBelongsToStages(item.chunk, stages) || matchesApprovedQuestion(item.chunk, tokens)))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const limit = input.maxChunks ?? 8;
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
  return {
    stages,
    commonKnowledge: [...commonKnowledge],
    knowledge: selected.slice(0, limit),
    stageInstructions: stages.map((stage) => stageInstructionsByStage[stage]).filter((instruction): instruction is string => Boolean(instruction))
  };
}

function relevantStages(facts: ApplicationFacts, current: string): DocumentationStage[] {
  const stages = new Set<DocumentationStage>();

  // The first incomplete stage defines the current working context. Do not
  // pre-load future branches merely because their fields are still empty.
  stages.add(firstIncompleteStage(facts));
  for (const [stage, pattern] of Object.entries(stageKeywords) as Array<[DocumentationStage, RegExp]>) {
    if (pattern.test(current)) stages.add(stage);
  }
  return [...stages];
}

function firstIncompleteStage(facts: ApplicationFacts): DocumentationStage {
  if (!facts.vehicleModel || !facts.vehicleYear || !facts.vehicleValue || !facts.requestedAmount || !facts.requestedProgram) return "application";
  if (!facts.residenceRegion || !facts.residenceCategory) return "residence";
  if (facts.requestedProgram === "without_storage" && facts.residenceCategory === "OTHER_KG" && facts.guarantorAvailable === undefined) return "guarantor";
  const documentsComplete = facts.documentsProvided || requiredDocumentKeys.every((key) => facts.documents?.[key] === "received");
  if (!documentsComplete && !facts.declinedDocuments) return "documents";
  if (facts.documents?.car_photo !== "received" && !facts.declinedCarPhoto) return "vehicle_photos";
  if (!facts.familyStatus || facts.familyStatus === "unknown") return "family_status";
  return "visit";
}

function chunkBelongsToStages(chunk: DocumentationChunk, stages: DocumentationStage[]): boolean {
  return stages.includes(chunk.primaryStage) || chunk.stages.some((stage) => stages.includes(stage));
}

function scoreChunk(chunk: DocumentationChunk, index: number, stages: DocumentationStage[], tokens: Set<string>, current: string): number {
  const stageScore = stages.includes(chunk.primaryStage) ? 60 : chunk.stages.some((stage) => stages.includes(stage)) ? 25 : 0;
  const keywordScore = chunk.keywords.reduce((score, keyword) => score + (tokens.has(keyword) ? 8 : 0), 0);
  const targetedSectionScore =
    (/доллар|евро|тенге|рубл|валют|курс/u.test(current) && /^13\.1/u.test(chunk.section) ? 90 : 0) +
    (/семейн|браке|женат|замуж|развод|супруг/u.test(current) && /^5\.15/u.test(chunk.section) ? 90 : 0) +
    (/поручител/u.test(current) && /^5\.16/u.test(chunk.section) ? 90 : 0) +
    (/пропис|регион|бишкек|чуй|токмок/u.test(current) && /^5\.17/u.test(chunk.section) ? 70 : 0) +
    (/(?:датчик|gps|гпс|трекер|маяч)/u.test(current) && /ставится.*gps|gps.*трекер/u.test(approvedQuestionOf(chunk) ?? "") ? 120 : 0) +
    (/(?:карт|безнал|деньг.*перевод|перевод.*деньг)/u.test(current) && /банковскую карту/u.test(approvedQuestionOf(chunk) ?? "") ? 120 : 0) +
    approvedQuestionScore(chunk, tokens);
  return stageScore + keywordScore + targetedSectionScore + Math.max(0, 1 - index / 10_000);
}

function findChunk(predicate: (chunk: DocumentationChunk) => boolean): DocumentationChunk | undefined {
  return generatedDocumentationChunks.find(predicate);
}

function approvedQuestionOf(chunk: DocumentationChunk): string | undefined {
  return "approvedQuestion" in chunk && typeof chunk.approvedQuestion === "string" ? chunk.approvedQuestion : undefined;
}

function approvedQuestionScore(chunk: DocumentationChunk, tokens: Set<string>): number {
  const question = approvedQuestionOf(chunk);
  if (!question || !("responsePolicy" in chunk) || chunk.responsePolicy !== "verbatim") return 0;
  const questionTokens = new Set(question.toLocaleLowerCase("ru-RU").match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  return [...tokens].filter((token) => questionTokens.has(token)).length * 30;
}

function matchesApprovedQuestion(chunk: DocumentationChunk, tokens: Set<string>): boolean {
  return approvedQuestionScore(chunk, tokens) > 0;
}
