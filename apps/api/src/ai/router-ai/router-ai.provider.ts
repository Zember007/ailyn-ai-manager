import { Injectable } from "@nestjs/common";
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

@Injectable()
export class RouterAiProvider implements AiProvider {
  private readonly config = loadAppConfig();

  constructor(private readonly client: RouterAiClient) {}

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    if (!this.client.isConfigured()) {
      return localExtract(input);
    }

    const response = await this.client.createChatCompletion({
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
    });
    return normalizeExtractionResult(JSON.parse(response.choices?.[0]?.message?.content ?? "{}"));
  }

  async generateResponse(input: ResponseGenerationInput): Promise<GeneratedResponse> {
    if (!this.client.isConfigured()) {
      return {
        message: buildLocalResponse(input),
        model: "local-stage1-fallback",
        promptVersion: "stage1-local-v1"
      };
    }

    const response = await this.client.createChatCompletion({
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
    });
    const parsed = JSON.parse(response.choices?.[0]?.message?.content ?? "{\"message\":\"\"}") as { message: string };
    return {
      message: parsed.message,
      model: response.model ?? this.config.routerAiTextModel ?? "routerai",
      promptVersion: "stage1-routerai-v1"
    };
  }

  async analyzeImage(input: VisionInput): Promise<VisionResult> {
    return inferAttachmentVision(input);
  }
}

function inferAttachmentVision(input: VisionInput): VisionResult {
  const name = String(input.attachment.fileName ?? "").toLowerCase();
  const mimeType = String(input.attachment.mimeType ?? "").toLowerCase();
  const hint = [name, mimeType].join(" ");

  if (hint.includes("poor") || hint.includes("blur") || hint.includes("low-quality")) {
    return { type: "poor_quality", extractedFacts: [], quality: "poor" };
  }
  if (hint.includes("id-front") || hint.includes("passport-front") || hint.includes("idcard-front")) {
    return { type: "id_front", extractedFacts: [], quality: "good" };
  }
  if (hint.includes("id-back") || hint.includes("passport-back") || hint.includes("idcard-back")) {
    return { type: "id_back", extractedFacts: [], quality: "good" };
  }
  if (hint.includes("registration-front") || hint.includes("sts-front") || hint.includes("registration-front")) {
    return { type: "vehicle_registration_front", extractedFacts: [], quality: "good" };
  }
  if (hint.includes("registration-back") || hint.includes("sts-back")) {
    return { type: "vehicle_registration_back", extractedFacts: [], quality: "good" };
  }
  if (hint.includes("car") || hint.includes("vehicle") || mimeType.startsWith("image/")) {
    return { type: "car", extractedFacts: [], quality: "good" };
  }
  return { type: "unknown", extractedFacts: [], quality: "unknown" };
}

function localExtract(input: ExtractionInput): ExtractionResult {
  const text = (input.text ?? "").toLowerCase();
  const facts: ExtractionResult["facts"] = [];
  const intents: string[] = [];
  const questions: ExtractionResult["questions"] = [];

  const amount = parseMoney(text);
  if (amount) facts.push({ key: "requestedAmount", value: amount, confidence: 0.8 });
  const value = parseValue(text);
  if (value) facts.push({ key: "vehicleValue", value, confidence: 0.8 });
  const year = text.match(/\b(19\d{2}|20\d{2})\b/);
  if (year) facts.push({ key: "vehicleYear", value: Number(year[1]), confidence: 0.9 });

  if (text.includes("camry") || text.includes("камри")) {
    facts.push({ key: "vehicleMake", value: "Toyota", confidence: 0.9 });
    facts.push({ key: "vehicleModel", value: "Camry", confidence: 0.9 });
  } else if (text.includes("toyota") || text.includes("тойота")) {
    facts.push({ key: "vehicleMake", value: "Toyota", confidence: 0.8 });
  }

  if (text.includes("бишкек")) facts.push({ key: "residenceRegion", value: "Бишкек", confidence: 0.9 });
  if (text.includes("чуй")) facts.push({ key: "residenceRegion", value: "Чуй", confidence: 0.9 });
  if (text.includes(" ош") || text === "ош") facts.push({ key: "residenceRegion", value: "Ош", confidence: 0.8 });
  if (text.includes("регион 10")) facts.push({ key: "vehicleRegistrationRegion", value: "10", confidence: 0.9 });
  if (text.includes("груз") || text.includes("автобус") || text.includes("мото")) facts.push({ key: "vehicleType", value: "truck", confidence: 0.8 });
  if (text.includes("минивэн")) facts.push({ key: "vehicleType", value: "minivan", confidence: 0.8 });
  if (text.includes("легков")) facts.push({ key: "vehicleType", value: "passenger_car", confidence: 0.8 });
  if (text.includes("кредит") || text.includes("залог")) facts.push({ key: "vehicleInCredit", value: true, confidence: 0.9 });
  if (text.includes("арест") || text.includes("огранич")) facts.push({ key: "vehicleArrested", value: true, confidence: 0.9 });
  if (text.includes("рефинанс")) facts.push({ key: "refinancingRequested", value: true, confidence: 0.9 });
  if (text.includes("выкуп")) facts.push({ key: "buyoutRequested", value: true, confidence: 0.9 });
  if (text.includes("договор") || text.includes("оплатил")) facts.push({ key: "existingContractQuestion", value: true, confidence: 0.8 });
  if (text.includes("женат") || text.includes("замужем") || text.includes("браке")) facts.push({ key: "familyStatus", value: "married", confidence: 0.8 });
  if (text.includes("не женат") || text.includes("не замужем")) facts.push({ key: "familyStatus", value: "single", confidence: 0.8 });
  if (text.includes("приеду") || text.includes("визит") || text.includes("еду")) facts.push({ key: "visitRequested", value: true, confidence: 0.8 });
  if (text.includes("подумаю") || text.includes("позже")) facts.push({ key: "clientPaused", value: true, confidence: 0.8 });

  if (text.includes("?") || text.includes("какие") || text.includes("сколько") || text.includes("можно ли")) {
    questions.push({ text: input.text ?? "", topic: "general" });
    intents.push("question");
  }

  return {
    language: "ru",
    intents,
    questions,
    facts,
    changedFacts: facts.map((fact) => ({ key: fact.key, newValue: fact.value })),
    attachments: [],
    promptInjectionDetected: text.includes("ignore previous") || text.includes("забудь инструкции"),
    clarificationNeeded: false
  };
}

function normalizeExtractionResult(payload: unknown): ExtractionResult {
  const source = isRecord(payload) ? payload : {};

  return {
    language: normalizeLanguage(source.language),
    intents: normalizeStringArray(source.intents),
    questions: normalizeQuestions(source.questions),
    facts: normalizeFacts(source.facts),
    changedFacts: normalizeChangedFacts(source.changedFacts),
    attachments: normalizeAttachments(source.attachments),
    promptInjectionDetected: source.promptInjectionDetected === true,
    clarificationNeeded: source.clarificationNeeded === true
  };
}

function buildLocalResponse(input: ResponseGenerationInput): string {
  const exact = input.responsePlan.answers.map((answer) => answer.exactText).filter(Boolean).join(" ");
  const questions = input.responsePlan.nextQuestions.join(" ");
  const required = input.responsePlan.requiredStatements.join(" ");
  return [exact, required, questions].filter(Boolean).join(" ").trim() || "Уточните, пожалуйста, модель, год автомобиля, ориентировочную стоимость и нужную сумму.";
}

function parseMoney(text: string): number | undefined {
  const match = text.match(/(?:нужно|хочу|займ|сумм[ауые]?|дай(?:те)?|получить)\D{0,20}(\d[\d\s]{1,12})/);
  return match ? Number(match[1].replace(/\s/g, "")) : undefined;
}

function parseValue(text: string): number | undefined {
  const match = text.match(/(?:стоимость|стоит|оцен[каить]*)\D{0,20}(\d[\d\s]{1,12})/);
  return match ? Number(match[1].replace(/\s/g, "")) : undefined;
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

function normalizeFacts(value: unknown): ExtractionResult["facts"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.key !== "string" || !("value" in item)) {
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
