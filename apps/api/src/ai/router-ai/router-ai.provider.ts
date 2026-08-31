import { Injectable, Logger } from "@nestjs/common";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApplicationFacts } from "@ailyn/business-rules";
import { loadAppConfig } from "@ailyn/config";
import type {
  AiProvider,
  ExtractionInput,
  ExtractionResult,
  GeneratedResponse,
  ResponseGenerationInput,
  VisionInput,
  VisionResult
} from "../ai-provider.interface.js";
import { RouterAiClient } from "./router-ai.client.js";
import { extractionSchema, responseGenerationSchema } from "../../dialogue/pipeline.contracts.js";
import { formatMoney, resolveMoneyFacts } from "../../dialogue/money-normalization.js";

@Injectable()
export class RouterAiProvider implements AiProvider {
  private readonly config = loadAppConfig();
  private readonly logger = new Logger(RouterAiProvider.name);

  constructor(private readonly client: RouterAiClient) {}

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const localResult = localExtract(input);
    if (shouldUseLocalExtractionFastPath(input, localResult)) {
      return localResult;
    }

    if (!this.client.isConfigured()) {
      return localResult;
    }

    try {
      const response = await this.client.createChatCompletion(
        {
          model: this.config.routerAiTextModel ?? "routerai-text-model-not-configured",
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: [loadPrompt("core.system.md"), loadPrompt("extraction.system.md")].join("\n\n")
            },
            { role: "user", content: JSON.stringify(input) }
          ]
        },
        { timeoutMs: getStage1Timeout(this.config.routerAiTimeoutMs, 30_000) }
      );
      const parsed = extractionSchema.safeParse(JSON.parse(response.choices?.[0]?.message?.content ?? "{}"));
      if (!parsed.success) throw new Error("RouterAI extraction response does not match structured schema");
      return normalizeExtractionResult(parsed.data);
    } catch (error) {
      this.logger.warn(`RouterAI extraction fallback activated: ${formatError(error)}`);
      return localResult;
    }
  }

  async generateResponse(input: ResponseGenerationInput): Promise<GeneratedResponse> {
    if (shouldUseDeterministicResponseFastPath(input)) {
      return {
        message: buildLocalResponse(input),
        model: "stage1-response-plan-fast-path",
        promptVersion: "stage1-response-plan-v1"
      };
    }

    if (!this.client.isConfigured()) {
      return {
        message: buildLocalResponse(input),
        model: "local-stage1-fallback",
        promptVersion: "stage1-local-v1"
      };
    }

    try {
      const response = await this.client.createChatCompletion(
        {
          model: this.config.routerAiTextModel ?? "routerai-text-model-not-configured",
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: [loadPrompt("core.system.md"), loadPrompt("response.system.md"), loadPrompt("response.examples.md")].join("\n\n")
            },
            { role: "user", content: JSON.stringify(input) }
          ]
        },
        { timeoutMs: getStage1Timeout(this.config.routerAiTimeoutMs, 30_000) }
      );
      const parsed = responseGenerationSchema.safeParse(JSON.parse(response.choices?.[0]?.message?.content ?? "{}"));
      if (!parsed.success) throw new Error("RouterAI response does not match structured schema");
      return {
        message: parsed.data.message,
        model: response.model ?? this.config.routerAiTextModel ?? "routerai",
        promptVersion: "stage1-routerai-v1"
      };
    } catch (error) {
      this.logger.warn(`RouterAI response fallback activated: ${formatError(error)}`);
      return {
        message: buildLocalResponse(input),
        model: "routerai-local-fallback",
        promptVersion: "stage1-local-v1"
      };
    }
  }

  async analyzeImage(input: VisionInput): Promise<VisionResult> {
    return inferAttachmentVision(input);
  }
}

function inferAttachmentVision(input: VisionInput): VisionResult {
  const name = String(input.attachment.fileName ?? "").toLowerCase();
  const mimeType = String(input.attachment.mimeType ?? "").toLowerCase();
  const attachmentText = readAttachmentText(input.attachment);
  const hint = [name, mimeType, attachmentText.toLowerCase()].join(" ");
  const extractedFacts = extractFactsFromAttachmentText(attachmentText);

  if (hint.includes("poor") || hint.includes("blur") || hint.includes("low-quality")) {
    return { type: "poor_quality", extractedFacts, quality: "poor" };
  }
  if (hint.includes("id-front") || hint.includes("passport-front") || hint.includes("idcard-front") || looksLikeIdFront(hint)) {
    return { type: "id_front", extractedFacts, quality: "good" };
  }
  if (hint.includes("id-back") || hint.includes("passport-back") || hint.includes("idcard-back") || looksLikeIdBack(hint)) {
    return { type: "id_back", extractedFacts, quality: "good" };
  }
  if (hint.includes("registration-front") || hint.includes("sts-front") || looksLikeRegistrationFront(hint)) {
    return { type: "vehicle_registration_front", extractedFacts, quality: "good" };
  }
  if (hint.includes("registration-back") || hint.includes("sts-back") || looksLikeRegistrationBack(hint)) {
    return { type: "vehicle_registration_back", extractedFacts, quality: "good" };
  }
  if (hint.includes("car") || hint.includes("vehicle") || hint.includes("авто") || mimeType.startsWith("image/") || isImageBase64(input.attachment.contentBase64)) {
    return { type: "car", extractedFacts, quality: "good" };
  }
  return { type: "unknown", extractedFacts, quality: "unknown" };
}

function localExtract(input: ExtractionInput): ExtractionResult {
  const text = (input.text ?? "").toLowerCase();
  const facts: ExtractionResult["facts"] = [];
  const intents: string[] = [];
  const questions: ExtractionResult["questions"] = [];

  const money = resolveMoneyFacts({ text: input.text, currentFacts: input.facts });
  if (money.requestedAmount !== undefined && money.requestedAmountCurrency === "KGS") {
    facts.push({ key: "requestedAmount", value: money.requestedAmount, confidence: money.requestedAmountConfidence });
  }
  if (money.vehicleValue !== undefined && money.vehicleValueCurrency === "KGS") {
    facts.push({ key: "vehicleValue", value: money.vehicleValue, confidence: money.vehicleValueConfidence });
  }
  const year = text.match(/\b(19\d{2}|20\d{2})\b/);
  if (year) facts.push({ key: "vehicleYear", value: Number(year[1]), confidence: 0.9 });
  const fullName = parseExplicitFullName(input.text ?? "");
  if (fullName) facts.push({ key: "fullName", value: fullName, confidence: 0.9 });
  const phone = parsePhoneNumber(input.text ?? "");
  if (phone) facts.push({ key: "phone", value: phone, confidence: 0.9 });

  if (text.includes("camry") || text.includes("камри")) {
    facts.push({ key: "vehicleMake", value: "Toyota", confidence: 0.9 });
    facts.push({ key: "vehicleModel", value: "Camry", confidence: 0.9 });
  } else if (text.includes("accord") || text.includes("аккорд")) {
    facts.push({ key: "vehicleMake", value: "Honda", confidence: 0.9 });
    facts.push({ key: "vehicleModel", value: "Accord", confidence: 0.9 });
  } else if (text.includes("land cruiser") || text.includes("ленд крузер") || text.includes("ланд крузер")) {
    facts.push({ key: "vehicleMake", value: "Toyota", confidence: 0.9 });
    facts.push({ key: "vehicleModel", value: "Land Cruiser", confidence: 0.9 });
  } else if (text.includes("toyota") || text.includes("тойота")) {
    facts.push({ key: "vehicleMake", value: "Toyota", confidence: 0.8 });
  }

  if (text.includes("бишкек")) {
    facts.push({ key: "residenceRegion", value: "Бишкек", confidence: 0.9 });
    facts.push({ key: "residenceCategory", value: "BISHKEK", confidence: 0.9 });
  }
  if (text.includes("чуй")) {
    facts.push({ key: "residenceRegion", value: "Чуйская область", confidence: 0.9 });
    facts.push({ key: "residenceCategory", value: "CHUY", confidence: 0.9 });
  }
  if (text.includes(" ош") || text === "ош" || text.includes("в оше")) {
    facts.push({ key: "residenceRegion", value: "Ош", confidence: 0.8 });
    facts.push({ key: "residenceCategory", value: "OTHER_KG", confidence: 0.8 });
  }
  if (text.includes("регион 10")) facts.push({ key: "vehicleRegistrationRegion", value: "10", confidence: 0.9 });
  if (text.includes("без изъятия") || text.includes("без изятия")) facts.push({ key: "requestedProgram", value: "without_storage", confidence: 0.9 });
  if (text.includes("стоянк") || text.includes("на парковк")) facts.push({ key: "requestedProgram", value: "parking", confidence: 0.9 });
  if (text.includes("груз")) facts.push({ key: "vehicleType", value: "truck", confidence: 0.8 });
  if (text.includes("автобус")) facts.push({ key: "vehicleType", value: "bus", confidence: 0.8 });
  if (text.includes("мото") || text.includes("скутер")) facts.push({ key: "vehicleType", value: "motorcycle", confidence: 0.8 });
  if (text.includes("минивэн")) facts.push({ key: "vehicleType", value: "minivan", confidence: 0.8 });
  if (text.includes("легков")) facts.push({ key: "vehicleType", value: "passenger_car", confidence: 0.8 });
  if (/(?:машин|авто|автомобил)[^.!?]{0,24}(?:в\s+кредит(?:е)?|в\s+залоге|заложен)|автокредит[^.!?]{0,24}(?:не\s+погашен|действующ)/i.test(text)) {
    facts.push({ key: "vehicleInCredit", value: true, confidence: 0.9 });
  }
  if (text.includes("арест") || text.includes("огранич")) facts.push({ key: "vehicleArrested", value: true, confidence: 0.9 });
  if (text.includes("рефинанс")) facts.push({ key: "refinancingRequested", value: true, confidence: 0.9 });
  if (text.includes("выкуп")) facts.push({ key: "buyoutRequested", value: true, confidence: 0.9 });
  if (/(?:я\s+оплатил|проверьте\s+оплату|остаток\s+долга|задолженность|реквизит|действующ(?:ий|ему)\s+договор|не\s+работает\s+gps|вернуть\s+документ)/i.test(text)) {
    facts.push({ key: "existingContractQuestion", value: true, confidence: 0.9 });
  }
  if (/(?:я\s+оплатил|проверьте\s+оплату)/i.test(text)) facts.push({ key: "existingContractPaymentMessage", value: true, confidence: 0.9 });
  if (text.includes("не женат") || text.includes("не замужем") || text.includes("никогда не состоял") || text.includes("никогда не состояла")) {
    facts.push({ key: "familyStatus", value: "single", confidence: 0.9 });
  } else if (text.includes("разведен") || text.includes("разведён") || text.includes("разведена") || text.includes("в разводе")) {
    facts.push({ key: "familyStatus", value: "divorced", confidence: 0.9 });
  } else if (text.includes("женат") || text.includes("замужем") || text.includes("состою в браке")) {
    facts.push({ key: "familyStatus", value: "married", confidence: 0.9 });
  }
  if (/(?:согласие|документ)[^.!?]{0,30}(?:готово|есть|оформлено)/i.test(text)) facts.push({ key: "spouseConsentReady", value: true, confidence: 0.85 });
  if (/(?:согласие)[^.!?]{0,30}(?:нет|не готово|не оформлено)/i.test(text)) facts.push({ key: "spouseConsentReady", value: false, confidence: 0.85 });
  if (/(?:супруг|супруга|муж|жена)[^.!?]{0,30}(?:за границей|в другом городе|не здесь)/i.test(text)) facts.push({ key: "spouseAway", value: true, confidence: 0.85 });
  if (/(?:поручитель)[^.!?]{0,20}(?:есть|будет|найду)/i.test(text) || /^(?:да|есть)$/i.test(text.trim()) && input.pendingFacts?.includes("guarantorAvailable")) facts.push({ key: "guarantorAvailable", value: true, confidence: 0.85 });
  if (/(?:поручител)[^.!?]{0,20}(?:нет|не будет)|^нет$/i.test(text.trim()) && input.pendingFacts?.includes("guarantorAvailable")) facts.push({ key: "guarantorAvailable", value: false, confidence: 0.85 });
  if (/(?:не\s+могу|не\s+буду|не\s+хочу|нет\s+возможности)[^.!?]{0,40}(?:прислать|отправить)[^.!?]{0,20}(?:документ|фото)/i.test(text)) facts.push({ key: "declinedDocuments", value: true, confidence: 0.9 });
  if (/(?:авто|машин)[^.!?]{0,25}(?:мужа|жены|супруга|супруги|брата|друга|не\s+моя)|оформлен[ао]?\s+на\s+(?:мужа|жену|другого)/i.test(text)) facts.push({ key: "borrowerIsOwner", value: false, confidence: 0.9 });
  if (/(?:собственник)[^.!?]{0,25}(?:приедет|сможет приехать)/i.test(text)) facts.push({ key: "ownerCanVisit", value: true, confidence: 0.85 });
  if (/(?:собственник)[^.!?]{0,25}(?:не приедет|не сможет приехать)/i.test(text)) facts.push({ key: "ownerCanVisit", value: false, confidence: 0.9 });
  if (text.includes("приеду") || text.includes("визит") || text.includes("уже еду") || text.includes("хочу приехать")) facts.push({ key: "visitRequested", value: true, confidence: 0.8 });
  if (/(?:уже\s+еду|я\s+в\s+пути|выехал)/i.test(text)) facts.push({ key: "onTheWay", value: true, confidence: 0.9 });
  if (/(?:уже\s+приехал|я\s+у\s+офиса|стою\s+у\s+офиса|я\s+на\s+месте)/i.test(text)) facts.push({ key: "arrivedAtOffice", value: true, confidence: 0.9 });
  const visitDate = parseVisitDate(text);
  const visitTime = text.match(/(?:^|\s|в)([01]?\d|2[0-3]):([0-5]\d)(?:\s|$|[.,!?])/i);
  if (visitDate) facts.push({ key: "visitDate", value: visitDate, confidence: 0.9 });
  if (visitTime) facts.push({ key: "visitTime", value: `${visitTime[1].padStart(2, "0")}:${visitTime[2]}`, confidence: 0.9 });
  if (text.includes("подумаю") || text.includes("позже")) facts.push({ key: "clientPaused", value: true, confidence: 0.8 });

  if (text.includes("?") || text.includes("какие") || text.includes("сколько") || text.includes("можно ли") || text.includes("где ")) {
    questions.push(...detectQuestions(input.text ?? ""));
    intents.push("question");
  }

  return {
    language: "ru",
    intents,
    questions,
    facts,
    moneyMentions: money.mentions,
    changedFacts: facts.map((fact) => ({ key: fact.key, newValue: fact.value })),
    attachments: [],
    promptInjectionDetected: text.includes("ignore previous") || text.includes("забудь инструкции"),
    clarificationNeeded: false
  };
}

function parseVisitDate(text: string): string | undefined {
  const explicit = text.match(/(?:^|\s)([0-3]?\d)[./-]([01]?\d)[./-](20\d{2})(?:\s|$|[.,!?])/);
  if (explicit) {
    return `${explicit[3]}-${explicit[2].padStart(2, "0")}-${explicit[1].padStart(2, "0")}`;
  }
  return undefined;
}

function parseExplicitFullName(text: string): string | undefined {
  return text.match(/(?:меня\s+зовут|мое\s+фио|мо[её]\s+имя|фио)\s*:?\s*([А-ЯЁ][А-ЯЁа-яё-]{1,}(?:\s+[А-ЯЁ][А-ЯЁа-яё-]{1,}){1,2})/iu)?.[1]?.trim();
}

function parsePhoneNumber(text: string): string | undefined {
  const raw = text.match(/(?:\+996|996|0)\s*\d{3}\s*\d{3}\s*\d{3}/)?.[0];
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("996")) return `+${digits}`;
  if (digits.length === 10 && digits.startsWith("0")) return `+996${digits.slice(1)}`;
  return undefined;
}

function detectQuestions(text: string): ExtractionResult["questions"] {
  const segments = text.split(/[?;]+/).map((segment) => segment.trim()).filter(Boolean);
  return segments.map((segment) => ({ text: segment, topic: questionTopic(segment) }));
}

function questionTopic(text: string): string {
  const normalized = text.toLocaleLowerCase("ru-RU");
  if (/ставк|процент/.test(normalized)) return "interest_rate";
  if (/адрес|где.*офис|как доехать/.test(normalized)) return "office_location";
  if (/документ|что нужно взять/.test(normalized)) return "documents_required";
  if (/сумм|лимит|сколько.*получ/.test(normalized)) return "possible_amount";
  if (/график|когда работает|время работы/.test(normalized)) return "office_hours";
  return "general";
}

function normalizeExtractionResult(payload: unknown): ExtractionResult {
  const source = isRecord(payload) ? payload : {};

  return {
    language: normalizeLanguage(source.language),
    intents: normalizeStringArray(source.intents),
    questions: normalizeQuestions(source.questions),
    facts: normalizeFacts(source.facts),
    moneyMentions: normalizeMoneyMentions(source.moneyMentions),
    changedFacts: normalizeChangedFacts(source.changedFacts),
    attachments: normalizeAttachments(source.attachments),
    promptInjectionDetected: source.promptInjectionDetected === true,
    clarificationNeeded: source.clarificationNeeded === true
  };
}

function buildLocalResponse(input: ResponseGenerationInput): string {
  const parts = [
    ...input.responsePlan.answers.map((answer) => answer.exactText).filter((value): value is string => Boolean(value)),
    ...input.responsePlan.requiredStatements.filter((statement) => !statement.startsWith("Попросить")),
    ...input.responsePlan.nextQuestions
  ];
  return [...new Set(parts)].filter(Boolean).join(" ").trim() || "Уточните, пожалуйста, модель, год автомобиля, ориентировочную стоимость и нужную сумму.";
}

function shouldUseLocalExtractionFastPath(input: ExtractionInput, localResult: ExtractionResult): boolean {
  if (input.attachments.length > 0) return false;
  if (localResult.promptInjectionDetected) return true;
  if (localResult.facts.length > 0) return true;
  if (localResult.moneyMentions.length > 0) return true;
  if (localResult.questions.length > 0) return true;
  if (localResult.intents.length > 0) return true;
  return false;
}

function shouldUseDeterministicResponseFastPath(input: ResponseGenerationInput): boolean {
  const exactAnswers = input.responsePlan.answers.every((answer) => typeof answer.exactText === "string" && answer.exactText.trim().length > 0);
  const hasDeterministicContent =
    input.responsePlan.answers.length > 0 ||
    input.responsePlan.nextQuestions.length > 0 ||
    input.responsePlan.requiredStatements.some((statement) => !statement.startsWith("Попросить"));

  return exactAnswers && hasDeterministicContent;
}

function getStage1Timeout(configuredTimeoutMs: number, maxTimeoutMs: number): number {
  return Math.max(3_000, Math.min(configuredTimeoutMs, maxTimeoutMs));
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function readAttachmentText(attachment: ExtractionInput["attachments"][number]): string {
  if (typeof attachment.textContent === "string" && attachment.textContent.trim()) {
    return attachment.textContent.slice(0, 24_000);
  }

  const mimeType = String(attachment.mimeType ?? "").toLowerCase();
  const buffer = decodeAttachmentContent(attachment.contentBase64);
  if (!buffer) {
    return "";
  }

  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "text/xml" ||
    looksMostlyText(buffer)
  ) {
    return buffer.toString("utf8", 0, Math.min(buffer.length, 24_000));
  }

  return "";
}

function extractFactsFromAttachmentText(text: string): VisionResult["extractedFacts"] {
  if (!text.trim()) {
    return [];
  }

  const facts: VisionResult["extractedFacts"] = [];
  const normalizedText = text.replace(/\s+/g, " ").trim();
  const fullName =
    normalizedText.match(/(?:фио|full\s*name|name)[:\s]+([A-ZА-ЯЁ][A-ZА-ЯЁa-zа-яё'-]+(?:\s+[A-ZА-ЯЁ][A-ZА-ЯЁa-zа-яё'-]+){1,2})/i)?.[1] ??
    normalizedText.match(/\b([A-ZА-ЯЁ][A-ZА-ЯЁa-zа-яё'-]+(?:\s+[A-ZА-ЯЁ][A-ZА-ЯЁa-zа-яё'-]+){2})\b/)?.[1];

  if (fullName) {
    facts.push({ key: "fullName", value: fullName.trim(), confidence: 0.8 });
  }

  return facts;
}

function looksLikeIdFront(hint: string): boolean {
  return hint.includes("паспорт") || hint.includes("id card") || hint.includes("личн");
}

function looksLikeIdBack(hint: string): boolean {
  return hint.includes("паспорт") && hint.includes("обрат") || hint.includes("id back");
}

function looksLikeRegistrationFront(hint: string): boolean {
  return hint.includes("свидетельств") || hint.includes("регистрац") || hint.includes("техпаспорт");
}

function looksLikeRegistrationBack(hint: string): boolean {
  return (hint.includes("свидетельств") || hint.includes("регистрац") || hint.includes("техпаспорт")) && hint.includes("обрат");
}

function decodeAttachmentContent(contentBase64: string | undefined): Buffer | undefined {
  if (!contentBase64) {
    return undefined;
  }

  try {
    return Buffer.from(contentBase64, "base64");
  } catch {
    return undefined;
  }
}

function looksMostlyText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 256));
  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126) || byte >= 192) {
      printable += 1;
    }
  }
  return sample.length > 0 && printable / sample.length > 0.85;
}

function isImageBase64(contentBase64: string | undefined): boolean {
  const buffer = decodeAttachmentContent(contentBase64);
  if (!buffer || buffer.length < 4) {
    return false;
  }

  return (
    (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
    (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)
  );
}

function normalizeLanguage(value: unknown): ExtractionResult["language"] {
  return value === "ru" || value === "kg" || value === "mixed" || value === "unknown" ? value : "unknown";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeQuestions(value: unknown): ExtractionResult["questions"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.text !== "string" || typeof item.topic !== "string") {
      return [];
    }
    return [{ text: item.text, topic: item.topic }];
  });
}

function normalizeMoneyMentions(value: unknown): ExtractionResult["moneyMentions"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    if (
      typeof item.sourceText !== "string" ||
      typeof item.amount !== "number" ||
      typeof item.normalizedAmount !== "number" ||
      (item.currency !== "KGS" && item.currency !== "USD" && item.currency !== "EUR" && item.currency !== "KZT" && item.currency !== "RUB") ||
      (item.roleCandidate !== "requestedAmount" && item.roleCandidate !== "vehicleValue" && item.roleCandidate !== "unknown") ||
      typeof item.confidence !== "number" ||
      typeof item.start !== "number" ||
      typeof item.end !== "number"
    ) {
      return [];
    }

    return [{
      sourceText: item.sourceText,
      amount: item.amount,
      normalizedAmount: item.normalizedAmount,
      currency: item.currency,
      roleCandidate: item.roleCandidate,
      confidence: item.confidence,
      start: item.start,
      end: item.end
    }];
  });
}

function normalizeFacts(value: unknown): ExtractionResult["facts"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.key !== "string" || !("value" in item)) {
      return [];
    }
    if (!applicationFactKeys.has(item.key)) {
      return [];
    }
    const key = item.key as keyof ApplicationFacts;
    return [
      {
        key,
        value: item.value,
        confidence: typeof item.confidence === "number" ? item.confidence : 0
      }
    ];
  });
}

function normalizeChangedFacts(value: unknown): ExtractionResult["changedFacts"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.key !== "string" || !("newValue" in item)) {
      return [];
    }
    if (!applicationFactKeys.has(item.key)) {
      return [];
    }
    return [{ key: item.key as keyof ApplicationFacts, newValue: item.newValue }];
  });
}

function normalizeAttachments(value: unknown): ExtractionResult["attachments"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.attachmentId !== "string" || typeof item.type !== "string") {
      return [];
    }
    if (!isAttachmentType(item.type)) {
      return [];
    }
    return [
      {
        attachmentId: item.attachmentId,
        type: item.type,
        confidence: typeof item.confidence === "number" ? item.confidence : 0
      }
    ];
  });
}

function isAttachmentType(value: string): value is ExtractionResult["attachments"][number]["type"] {
  return (
    value === "id_front" ||
    value === "id_back" ||
    value === "vehicle_registration_front" ||
    value === "vehicle_registration_back" ||
    value === "car" ||
    value === "unknown" ||
    value === "poor_quality"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const applicationFactKeys = new Set<string>([
  "language", "fullName", "phone", "citizenship", "residenceRegion", "residenceText",
  "residenceCategory", "residenceNeedsClarification", "vehicleRegistrationCountry",
  "vehicleRegistrationRegion", "vehicleType", "vehicleMake", "vehicleModel", "vehicleYear",
  "vehicleValue", "reportedInvalidVehicleYear", "requestedAmount", "requestedProgram", "ownerChanged", "plateChanged",
  "ownerIsLegalEntity", "borrowerIsLegalEntity", "vehicleInCredit", "vehiclePledged",
  "vehicleArrested", "registrationRestricted", "refinancingRequested", "buyoutRequested",
  "accidentNotDrivable", "foreignTravelQuestion", "existingContractQuestion",
  "existingContractPaymentMessage", "borrowerIsOwner", "ownerCanVisit", "familyStatus",
  "vehicleBoughtDuringMarriage", "spouseConsentReady", "spouseAway", "guarantorAvailable",
  "documents", "visitRequested", "visitDate", "visitTime", "clientPaused", "clientClosed",
  "declinedDocuments", "declinedCarPhoto", "ownerFullName", "ownerResidenceRegion",
  "ownerFamilyStatus", "vehiclePurchasedDuringMarriage", "divorceCertificateReady",
  "visitConfirmationPending", "handedToManager", "onTheWay", "arrivedAtOffice"
]);

const promptCache = new Map<string, string>();
const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = dirname(currentFilePath);
const promptDirectories = [
  resolve(currentDirPath, "../prompts"),
  resolve(process.cwd(), "src/ai/prompts"),
  resolve(process.cwd(), "dist/apps/api/src/ai/prompts"),
  resolve(process.cwd(), "apps/api/src/ai/prompts"),
  resolve(process.cwd(), "apps/api/dist/apps/api/src/ai/prompts")
];

function loadPrompt(fileName: string): string {
  const cached = promptCache.get(fileName);
  if (cached) {
    return cached;
  }

  const promptPath = promptDirectories
    .map((directory) => resolve(directory, fileName))
    .find((candidate) => existsSync(candidate));

  if (!promptPath) {
    throw new Error(`Prompt file not found: ${fileName}. Checked: ${promptDirectories.join(", ")}`);
  }

  const prompt = readFileSync(promptPath, "utf8").trim();
  promptCache.set(fileName, prompt);
  return prompt;
}
