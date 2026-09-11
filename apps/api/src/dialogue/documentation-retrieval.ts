import type { ApplicationFacts } from "@ailyn/business-rules";
import { generatedDocumentationChunks } from "./documentation-chunks.generated.js";
import { agentStageInstructions } from "./agent-stage-instructions.js";
import type { Stage1Message } from "./stage1-store.service.js";
import { approvedKnowledgeSeeds } from "../knowledge/knowledge.service.js";

type DocumentationChunk = (typeof generatedDocumentationChunks)[number];
type KnowledgeContextChunk = DocumentationChunk | (typeof approvedFaqChunks)[number];
type DocumentationStage = DocumentationChunk["primaryStage"];
const stageInstructionsByStage: Partial<Record<DocumentationStage, string>> = agentStageInstructions;

/**
 * The maximum-loan FAQ needs stricter matching than a generic money turn:
 * «машина стоит 2 млн» must not trigger it, while colloquial questions such
 * as «сколько денег дадите» must. This is the routing filter for the
 * MAX_LIMIT placeholders; it does not write application facts.
 */
export function isMaximumLoanKnowledgeQuestion(text: string): boolean {
  const normalized = text.toLocaleLowerCase("ru-RU");
  return /(?:максим\p{L}*|макс\b|лимит\p{L}*|потолок\p{L}*|до\s+какой\s+сумм\p{L}*|скольк\p{L}*[^?!\n]{0,45}(?:денег|деньг|дад\p{L}*|получ\p{L}*|можно\s+взять)|(?:денег|деньг)[^?!\n]{0,45}(?:скольк\p{L}*|дад\p{L}*|получ\p{L}*|можно\s+взять)|какую\s+сумм\p{L}*[^?!\n]{0,30}(?:дад\p{L}*|можно\s+получ\p{L}*))/iu.test(normalized);
}

const requiredDocumentKeys = ["id_front", "id_back", "vehicle_registration_front", "vehicle_registration_back"] as const;
// These passages are safe to expose on every turn: global answer rules plus
// short, high-frequency FAQ/redirect answers (including timing and existing
// contract handling). The remaining product rules arrive only with the stage
// where they can affect the reply, so unrelated branches do not compete for
// the model's attention.
const baseCommonKnowledge = [
  findChunk((chunk) => chunk.section === "5.1"),
  findChunk((chunk) => chunk.section === "5.25"),
  findChunk((chunk) => chunk.text.includes("Я Айлин — виртуальный помощник")),
  findChunk((chunk) => /осмотр.*5 минут|5 минут.*осмотр/u.test(chunk.text))
].filter((chunk): chunk is DocumentationChunk => Boolean(chunk));
const approvedFaqChunks = approvedKnowledgeSeeds
  .filter((item) => item.active && item.status === "approved" && item.key !== "unknown_fallback")
  .map((item) => ({
    key: `faq_${item.key}`,
    keywords: [...new Set(item.aliases.flatMap((alias) => alias.toLocaleLowerCase("ru-RU").match(/[\p{L}\p{N}]{3,}/gu) ?? []))],
    section: "approved_faq",
    sourceSection: "approved_faq",
    parentContext: `Утверждённый FAQ: ${item.category}`,
    chunkIndex: 0,
    responsePolicy: "verbatim",
    aliases: item.aliases,
    approvedQuestion: item.aliases.join(" ") || item.key,
    approvedAnswer: item.answerRu,
    primaryStage: "application",
    stages: ["application"],
    text: item.answerRu
  }));

/**
 * Server fallback for a product-policy topic expressed in the current client
 * message. It deliberately ignores dialogue history: old assistant text must
 * not turn an unrelated answer into a new knowledge request. Whitespace is
 * removed before comparison so common typos such as «не находу» still match
 * the approved alias «не на ходу».
 */
export function hasApprovedKnowledgeMatch(text: string): boolean {
  const current = text.toLocaleLowerCase("ru-RU");
  return approvedFaqChunks.some((chunk) => hasExactApprovedFaqAlias(chunk, current));
}

/**
 * Gives the knowledge model a short, ordered evidence packet instead of a
 * large undifferentiated document dump. FAQ answers have the highest
 * priority; section 3.18 is always included next because it owns questions
 * about an already issued loan. The remaining entries are retrieved for the
 * current message only.
 */
export function prioritizedKnowledgeForQuestion(input: {
  facts: ApplicationFacts;
  currentMessage?: string;
  messages: Stage1Message[];
}): KnowledgeContextChunk[] {
  const selected = selectRelevantDocumentation({ ...input, includeCrossStageMatches: true, maxChunks: 8 });
  const current = (input.currentMessage ?? "").toLocaleLowerCase("ru-RU");
  const tokens = new Set(current.match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const spouseProxyContext = isSpouseProxyContext(current);
  const ownershipRegistrationQuestion = isOwnershipRegistrationQuestion(current);
  const existingContractServiceRequest = isExistingContractServiceRequest(current);
  const spouseOwnershipRule = spouseProxyContext
    ? generatedDocumentationChunks.find((chunk) => chunk.section === "4.27")
    : undefined;
  const ownershipRegistrationRule = ownershipRegistrationQuestion
    ? generatedDocumentationChunks.find((chunk) => chunk.key === "docx_0105")
    : undefined;
  const availableFaq = spouseProxyContext || existingContractServiceRequest
    ? approvedFaqChunks.filter((chunk) => chunk.key !== "faq_power_of_attorney" && (!existingContractServiceRequest || chunk.key !== "faq_gps_requirement"))
    : approvedFaqChunks;
  const matchedFaq = availableFaq.filter((chunk) =>
    (hasExactApprovedFaqAlias(chunk, current) || matchesApprovedQuestion(chunk, tokens))
  );
  const contractRules = generatedDocumentationChunks.filter((chunk) => chunk.section === "3.18");
  return uniqueKnowledge([
    ...(existingContractServiceRequest ? contractRules : []),
    ...matchedFaq,
    ...(spouseOwnershipRule ? [spouseOwnershipRule] : []),
    ...(ownershipRegistrationRule ? [ownershipRegistrationRule] : []),
    ...(existingContractServiceRequest ? [] : contractRules),
    ...availableFaq,
    ...selected.knowledge,
    ...selected.commonKnowledge
  ]);
}

function uniqueKnowledge(chunks: KnowledgeContextChunk[]): KnowledgeContextChunk[] {
  return [...new Map(chunks.map((chunk) => [chunk.key, chunk])).values()];
}
const stageKeywords: Record<DocumentationStage, RegExp> = {
  application: /автомобил|машин|мошин|марка|модель|год|стоимост|цен|сумм|займ|доллар|евро|тенге|рубл|валют|курс|изменил|изменить|дороже|дешевле|изъят|стоян|долго|длится|сколько\s+времен|оформля|осмотр|оценк/u,
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
}): { stages: DocumentationStage[]; commonKnowledge: DocumentationChunk[]; knowledge: DocumentationChunk[]; stageInstructions: string[]; mandatoryAnswer?: string } {
  const current = `${input.currentMessage ?? ""} ${input.messages.slice(-3).map((message) => message.body).join(" ")}`.toLocaleLowerCase("ru-RU");
  const spouseProxyContext = isSpouseProxyContext(input.currentMessage ?? "");
  const ownershipRegistrationQuestion = isOwnershipRegistrationQuestion(input.currentMessage ?? "");
  const existingContractServiceRequest = isExistingContractServiceRequest(input.currentMessage ?? "");
  // Rates are not general conversation context: exposing them on every turn
  // makes the model answer a maximum-loan question with percentages.
  const asksInterestRate = /(?:процент|ставк)/iu.test(input.currentMessage ?? "");
  const asksMaximumLoan = isMaximumLoanKnowledgeQuestion(input.currentMessage ?? "");
  const commonKnowledge = [
    ...baseCommonKnowledge,
    ...(asksInterestRate ? [findChunk((chunk) => chunk.section === "5.23.1")] : []),
    ...(asksMaximumLoan ? approvedFaqChunks.filter((chunk) => chunk.key === "faq_maximum_loan_range") : [])
  ].filter((chunk): chunk is DocumentationChunk => Boolean(chunk));
  const stages = relevantStages(input.facts, current);
  const tokens = new Set(current.match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const candidates = [...generatedDocumentationChunks, ...approvedFaqChunks].filter((chunk) =>
    !(spouseProxyContext && chunk.key === "faq_power_of_attorney")
    && !(existingContractServiceRequest && chunk.key === "faq_gps_requirement")
  ) as DocumentationChunk[];
  const ranked = candidates
    .map((chunk, index) => ({ chunk, index, score: scoreChunk(chunk, index, stages, tokens, current, ownershipRegistrationQuestion) }))
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
    stageInstructions: stages.map((stage) => stageInstructionsByStage[stage]).filter((instruction): instruction is string => Boolean(instruction)),
    // History helps retrieve context, but it must never make an answer to a
    // previous FAQ mandatory for a new, unrelated client question.
    mandatoryAnswer: mandatoryApprovedAnswer(ranked, (input.currentMessage ?? "").toLocaleLowerCase("ru-RU"), ownershipRegistrationQuestion, existingContractServiceRequest)
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

function scoreChunk(chunk: DocumentationChunk, index: number, stages: DocumentationStage[], tokens: Set<string>, current: string, ownershipRegistrationQuestion: boolean): number {
  const stageScore = stages.includes(chunk.primaryStage) ? 60 : chunk.stages.some((stage) => stages.includes(stage)) ? 25 : 0;
  const keywordScore = chunk.keywords.reduce((score, keyword) => score + (tokens.has(keyword) ? 8 : 0), 0);
  const targetedSectionScore =
    (/доллар|евро|тенге|рубл|валют|курс/u.test(current) && /^13\.1/u.test(chunk.section) ? 90 : 0) +
    (/семейн|браке|женат|замуж|развод|супруг/u.test(current) && /^5\.15/u.test(chunk.section) ? 90 : 0) +
    (/поручител/u.test(current) && /^5\.16/u.test(chunk.section) ? 90 : 0) +
    (/пропис|регион|бишкек|чуй|токмок/u.test(current) && /^5\.17/u.test(chunk.section) ? 70 : 0) +
    (ownershipRegistrationQuestion && chunk.key === "docx_0105" ? 300 : 0) +
    (/(?:датчик|gps|гпс|трекер|маяч)/u.test(current) && /ставится.*gps|gps.*трекер/u.test(approvedQuestionOf(chunk) ?? "") ? 120 : 0) +
    (/(?:карт|безнал|деньг.*перевод|перевод.*деньг)/u.test(current) && /банковскую карту/u.test(approvedQuestionOf(chunk) ?? "") ? 120 : 0) +
    (chunk.key.startsWith("faq_") ? approvedFaqScore(chunk, tokens, current) : 0) +
    (matchesDirectQuestion(chunk, current) ? 600 : 0) +
    approvedQuestionScore(chunk, tokens);
  return stageScore + keywordScore + targetedSectionScore + Math.max(0, 1 - index / 10_000);
}

function findChunk(predicate: (chunk: DocumentationChunk) => boolean): DocumentationChunk | undefined {
  return generatedDocumentationChunks.find(predicate);
}

function approvedQuestionOf(chunk: KnowledgeContextChunk): string | undefined {
  return "approvedQuestion" in chunk && typeof chunk.approvedQuestion === "string" ? chunk.approvedQuestion : undefined;
}

function approvedAnswerOf(chunk: KnowledgeContextChunk): string | undefined {
  return "approvedAnswer" in chunk && typeof chunk.approvedAnswer === "string" ? chunk.approvedAnswer : undefined;
}

function retrievalQuestionOf(chunk: DocumentationChunk): string | undefined {
  return "retrievalQuestion" in chunk && typeof chunk.retrievalQuestion === "string" ? chunk.retrievalQuestion : undefined;
}

function retrievalAnswerOf(chunk: DocumentationChunk): string | undefined {
  return "retrievalAnswer" in chunk && typeof chunk.retrievalAnswer === "string" ? chunk.retrievalAnswer : undefined;
}

function mandatoryApprovedAnswer(ranked: Array<{ chunk: DocumentationChunk }>, current: string, ownershipRegistrationQuestion = false, existingContractServiceRequest = false): string | undefined {
  // A direct question-answer pair from the source document is narrower than
  // a seed FAQ with a broad alias (for example, nearby services). Prefer it
  // so a currency-exchange question cannot acquire answers about a notary or
  // an ATM from a neighbouring service bundle.
  const existingContractAnswer = existingContractServiceRequest
    ? approvedFaqChunks.find((chunk) => chunk.key === "faq_existing_contract_redirect")?.approvedAnswer
    : undefined;
  const match = existingContractAnswer
    ? undefined
    : (ownershipRegistrationQuestion
      ? ranked.find(({ chunk }) => chunk.key === "docx_0105")
      : undefined)
      ?? (isProcessingDurationQuestion(current)
        ? ranked.find(({ chunk }) => String(chunk.key) === "faq_processing_duration")
        : undefined)
      ?? ranked.find(({ chunk }) => matchesDirectQuestion(chunk, current))
      ?? ranked.find(({ chunk }) => chunk.key.startsWith("faq_") && hasExactApprovedFaqAlias(chunk, current));
  return existingContractAnswer ?? (match ? approvedAnswerOf(match.chunk) ?? retrievalAnswerOf(match.chunk) : undefined);
}

function isProcessingDurationQuestion(text: string): boolean {
  return /(?:сколько\s+(?:длит|занима)|как\s+(?:долго|быстро)).{0,40}оформлени\p{L}*/iu.test(text);
}

function approvedQuestionScore(chunk: KnowledgeContextChunk, tokens: Set<string>): number {
  const question = approvedQuestionOf(chunk);
  if (!question || !("responsePolicy" in chunk) || chunk.responsePolicy !== "verbatim") return 0;
  const questionTokens = new Set(question.toLocaleLowerCase("ru-RU").match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  return [...tokens].filter((token) => questionTokens.has(token)).length * 30;
}

function matchesApprovedQuestion(chunk: KnowledgeContextChunk, tokens: Set<string>): boolean {
  return approvedQuestionScore(chunk, tokens) > 0;
}

function approvedFaqScore(chunk: KnowledgeContextChunk, tokens: Set<string>, current: string): number {
  const aliasMatches = chunk.keywords.filter((keyword) => tokens.has(keyword)).length;
  const phraseMatch = hasExactApprovedFaqAlias(chunk, current);
  return approvedQuestionScore(chunk, tokens) * 2 + aliasMatches * 40 + (phraseMatch ? 500 : 0);
}

function hasExactApprovedFaqAlias(chunk: KnowledgeContextChunk, current: string): boolean {
  const aliases = "aliases" in chunk && Array.isArray(chunk.aliases) ? chunk.aliases : [];
  const compactCurrent = current.replace(/\s+/gu, "");
  return aliases.some(
    (alias): alias is string => typeof alias === "string" && alias.trim().length >= 5 && (
      current.includes(alias.toLocaleLowerCase("ru-RU"))
      || compactCurrent.includes(alias.toLocaleLowerCase("ru-RU").replace(/\s+/gu, ""))
    )
  );
}

function matchesDirectQuestion(chunk: DocumentationChunk, current: string): boolean {
  const question = approvedQuestionOf(chunk) ?? retrievalQuestionOf(chunk);
  if (!question) return false;
  const normalizedQuestion = normalizeForQuestionMatch(question);
  return normalizedQuestion.length >= 8 && normalizeForQuestionMatch(current).includes(normalizedQuestion);
}

function normalizeForQuestionMatch(text: string): string {
  return text.toLocaleLowerCase("ru-RU").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function isSpouseProxyContext(text: string): boolean {
  return /доверенн(?:ост|осит)/iu.test(text) && /(?:жен[ауые]?|муж(?:[ауе]|ем)?|супруг[аиу]?|супруге|супругу)/iu.test(text);
}

/** A typo-tolerant colloquial form of the UNA-registration question. */
function isOwnershipRegistrationQuestion(text: string): boolean {
  return /(?:оформлен|зарегистрирован)\p{L}*.{0,60}\s+не\s*на\s*(?:меня|мне|я)(?:\s|$)|(?:автомобил|машин|мошин|авто)\p{L}*.{0,80}(?:не\s*мо[яйеи]|чуж\p{L}*|друг(?:ого|ая|ой)\s+(?:человек|лиц))/iu.test(text);
}

/** A malfunction/replacement request for GPS belongs to servicing an existing loan, not a pre-loan GPS FAQ. */
function isExistingContractServiceRequest(text: string): boolean {
  return /(?:датчик|gps|гпс)[^.!?]{0,40}(?:не\s+работа|сломал|перестал\p{L}*\s+работа|замен)/iu.test(text);
}
