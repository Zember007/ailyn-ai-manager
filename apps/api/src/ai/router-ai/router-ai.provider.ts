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
  ModelMoneyMention,
  ResponseGenerationInput,
  RouteProposal,
  VisionInput,
  VisionResult
} from "../ai-provider.interface.js";
import { RouterAiClient } from "./router-ai.client.js";
import { extractionSchema, responseGenerationSchema } from "../../dialogue/pipeline.contracts.js";
import { detectMoneyMentions, resolveMoneyFacts } from "../../dialogue/money-normalization.js";

@Injectable()
export class RouterAiProvider implements AiProvider {
  private readonly config = loadAppConfig();
  private readonly logger = new Logger(RouterAiProvider.name);

  constructor(private readonly client: RouterAiClient) {}

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    if (!this.client.isConfigured()) {
      return localExtract(input);
    }

    try {
      const response = await this.client.createChatCompletion(
        {
          model: this.config.routerAiTextModel ?? "routerai-text-model-not-configured",
          temperature: 0,
          max_tokens: 600,
          reasoning: { enabled: false },
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
      const parsed = extractionSchema.safeParse(prepareExtractionPayload(JSON.parse(response.choices?.[0]?.message?.content ?? "{}")));
      if (!parsed.success) throw new Error("RouterAI extraction response does not match structured schema");
      return supplementExplicitPendingProgram(normalizeExtractionResult(parsed.data, input), input);
    } catch (error) {
      this.logger.warn(`RouterAI extraction fallback activated: ${formatError(error)}`);
      return localExtract(input);
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
          max_tokens: 400,
          reasoning: { enabled: false },
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
    if (!this.client.isConfigured()) {
      return inferAttachmentVision(input);
    }

    try {
      const response = await this.client.createChatCompletion(
        {
          model: this.config.routerAiVisionModel ?? this.config.routerAiTextModel ?? "routerai-vision-model-not-configured",
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: [loadPrompt("core.system.md"), loadPrompt("vision.system.md")].join("\n\n")
            },
            { role: "user", content: buildVisionMessage(input) }
          ]
        },
        { timeoutMs: getStage1Timeout(this.config.routerAiTimeoutMs, 30_000) }
      );
      const result = normalizeVisionResult(JSON.parse(response.choices?.[0]?.message?.content ?? "{}"));
      // A filename explicitly identifying a passport/ID is a safe fallback for
      // an otherwise unreadable Vision classification. Do not fabricate OCR
      // fields: only preserve the model's extracted facts.
      // When RouterAI is configured, document type must come from the image
      // itself. Do not turn an uncertain model response into a filename-based
      // classification; arbitrary upload names are not evidence.
      return result;
    } catch (error) {
      this.logger.warn(`RouterAI vision fallback activated: ${formatError(error)}`);
      return inferAttachmentVision(input);
    }
  }
}

// Narrow safety net for an explicit programme choice. RouterAI remains the
// primary interpreter; this only prevents an unequivocal client choice from
// being discarded when the structured response omits or malforms that fact.
// It deliberately does not depend on the current deterministic stage: a
// terminal decision can leave pendingFacts empty even though a preceding
// assistant message asked the programme question.
function supplementExplicitPendingProgram(result: ExtractionResult, input: ExtractionInput): ExtractionResult {
  const text = (input.text ?? "").toLocaleLowerCase("ru-RU");
  const additions: ExtractionResult["facts"] = [];
  const intents = [...result.intents];
  if (/(?:подумаю|позже\s+(?:напиш|отвеч)|пока\s+не\s+решил)/i.test(text)) {
    additions.push({ key: "clientPaused", value: true, confidence: 1 });
    intents.push("pause");
  }
  if (/(?:охренел|ужасн|безобраз|кошмар|возмут|не\s+устраива)/i.test(text)) intents.push("complaint");
  const explicitYear = text.match(/\b(19\d{2}|20\d{2})\b/);
  if (explicitYear && result.facts.every((fact) => fact.key !== "vehicleYear")) additions.push({ key: "vehicleYear", value: Number(explicitYear[1]), confidence: 1 });
  if (result.facts.every((fact) => fact.key !== "declinedDocuments") && /(?:не\s+(?:могу|буду|хочу)|нет\s+возможности)[^.!?]{0,80}(?:документ|фото)/i.test(text)) additions.push({ key: "declinedDocuments", value: true, confidence: 1 });
  if (result.facts.every((fact) => fact.key !== "vehicleInCredit") && /машин[аеу]?[^.!?]{0,30}\s+в\s+кредит/i.test(text)) additions.push({ key: "vehicleInCredit", value: true, confidence: 1 });
  if (!result.facts.some((fact) => fact.key === "existingContractQuestion" && fact.value === true) && /(?:действующ(?:ему|ий)|по\s+договору|проверьте\s+оплату|я\s+оплатил)/i.test(text)) additions.push({ key: "existingContractQuestion", value: true, confidence: 1 });
  if (!result.facts.some((fact) => fact.key === "existingContractPaymentMessage" && fact.value === true) && /(?:проверьте\s+оплату|я\s+оплатил)/i.test(text)) additions.push({ key: "existingContractPaymentMessage", value: true, confidence: 1 });
  if (!result.facts.some((fact) => fact.key === "familyStatus")) {
    if (/(?:развед[её]н|разведена|в\s+разводе)/i.test(text)) {
      additions.push({ key: "familyStatus", value: "divorced", confidence: 1 });
    } else if (/(?:не\s+в\s+браке|не\s+женат|не\s+замужем|никогда\s+не\s+состоял(?:а)?)/i.test(text)) {
      additions.push({ key: "familyStatus", value: "single", confidence: 1 });
    } else if (/(?:я\s+)?(?:женат|замужем|в\s+браке)/i.test(text)) {
      additions.push({ key: "familyStatus", value: "married", confidence: 1 });
    }
  }
  if (!result.facts.some((fact) => fact.key === "familyStatus" || fact.key === "ownerFamilyStatus")) {
    const pendingFamilyStatus = activeFamilyStatusFact(input);
    // RouterAI interprets contextual language freely. This intentionally tiny
    // fallback only protects the most unequivocal Russian refusals when the
    // model returns otherwise valid JSON without the active marital-status fact.
    if (pendingFamilyStatus && isStandaloneNegativeReply(text)) {
      additions.push({ key: pendingFamilyStatus, value: "single", confidence: 1 });
    }
  }
  if (!result.facts.some((fact) => fact.key === "spouseConsentReady" && fact.value === false) && /согласие[^.!?]{0,30}(?:не\s+готово|нет|не\s+оформлено)/i.test(text)) additions.push({ key: "spouseConsentReady", value: false, confidence: 1 });
  const hasValidRequestedProgram = result.facts.some((fact) =>
    fact.key === "requestedProgram" && (fact.value === "without_storage" || fact.value === "parking")
  );
  if (!hasValidRequestedProgram && !looksLikeClientQuestion(input.text ?? "")) {
    const value = /без\s+из[ъь]?ятия/.test(text) ? "without_storage" : /(?:на\s+)?стоянк|с\s+постановк/.test(text) ? "parking" : undefined;
    if (value) additions.push({ key: "requestedProgram", value, confidence: 1 });
  }
  const localMoney = resolveMoneyFacts({
    text: input.text,
    currentFacts: input.dialogueContext?.currentFacts ?? {},
    pendingFacts: input.dialogueContext?.pendingFacts.filter((fact): fact is keyof ApplicationFacts => typeof fact === "string")
  });
  // A single amount is an answer to the current money question.  RouterAI still
  // extracts the number; this bounded reconciliation only prevents a generic
  // phrase such as "примерно 200 000 сом" from being assigned to the other
  // money field and then triggering a false recovery prompt.
  const pendingMoneyFact = input.dialogueContext?.pendingFacts.length === 1 &&
    (input.dialogueContext.pendingFacts[0] === "vehicleValue" || input.dialogueContext.pendingFacts[0] === "requestedAmount")
    ? input.dialogueContext.pendingFacts[0]
    : undefined;
  const moneyMentions = pendingMoneyFact && result.moneyMentions.length === 1
    ? [{ ...result.moneyMentions[0], roleCandidate: pendingMoneyFact }]
    : result.moneyMentions.length > 0 ? result.moneyMentions : localMoney.mentions;
  const fallbackQuestions = result.questions.length === 0 && looksLikeClientQuestion(input.text ?? "")
    ? detectQuestions(input.text ?? "")
    : result.questions;
  if (!additions.length && intents.length === result.intents.length && moneyMentions === result.moneyMentions && fallbackQuestions === result.questions) return result;
  return { ...result, intents: [...new Set(intents)], questions: fallbackQuestions, facts: [...result.facts, ...additions], moneyMentions, changedFacts: [...result.changedFacts, ...additions.map((fact) => ({ key: fact.key, newValue: fact.value }))] };
}

function activeFamilyStatusFact(input: ExtractionInput): "familyStatus" | "ownerFamilyStatus" | undefined {
  const pendingFacts = input.dialogueContext?.pendingFacts ?? input.pendingFacts ?? [];
  if (pendingFacts.includes("ownerFamilyStatus")) return "ownerFamilyStatus";
  return pendingFacts.includes("familyStatus") ? "familyStatus" : undefined;
}

function isStandaloneNegativeReply(text: string): boolean {
  return /^(?:нет|не)$/iu.test(text.trim());
}

function buildVisionPromptInput(input: VisionInput): Record<string, unknown> {
  const attachmentText = readAttachmentText(input.attachment);
  return {
    attachment: {
      id: input.attachment.id,
      fileName: input.attachment.fileName,
      mimeType: input.attachment.mimeType,
      kindHint: input.attachment.kindHint,
      metadata: input.attachment.metadata,
      textContent: attachmentText || undefined,
      hasImagePayload: isImageBase64(input.attachment.contentBase64),
      hasBinaryPayload: Boolean(input.attachment.contentBase64)
    },
    responseContract: {
      type: ["id_front", "id_back", "vehicle_registration_front", "vehicle_registration_back", "car", "unknown", "poor_quality"],
      quality: ["good", "poor", "unknown"],
      extractedFacts: "Array<{ key: ApplicationFacts key; value: unknown; confidence: 0..1 }>"
    }
  };
}

function buildVisionMessage(input: VisionInput): Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }> {
  const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }> = [
    { type: "text", text: JSON.stringify(buildVisionPromptInput(input)) }
  ];
  const mimeType = String(input.attachment.mimeType ?? "image/jpeg").toLowerCase();
  if (isImageBase64(input.attachment.contentBase64) && /^image\/(?:jpeg|png|webp|gif)$/.test(mimeType)) {
    parts.push({ type: "image_url", image_url: { url: `data:${mimeType};base64,${input.attachment.contentBase64}`, detail: "high" } });
  }
  return parts;
}

function inferAttachmentVision(input: VisionInput): VisionResult {
  const mimeType = String(input.attachment.mimeType ?? "").toLowerCase();
  const attachmentText = readAttachmentText(input.attachment);
  const fileNameHint = input.attachment.fileName?.toLowerCase().replace(/[._-]+/g, " ");
  const hint = [mimeType, fileNameHint, attachmentText.toLowerCase()].filter(Boolean).join(" ");
  const extractedFacts = extractFactsFromAttachmentText(attachmentText);

  const quality: VisionResult["quality"] = hint.includes("poor") || hint.includes("blur") || hint.includes("low-quality")
    ? "poor"
    : "good";
  if (looksLikeIdBack(hint)) {
    return { type: "id_back", extractedFacts, quality };
  }
  if (looksLikeRegistrationBack(hint)) {
    return { type: "vehicle_registration_back", extractedFacts, quality };
  }
  if (looksLikeIdFront(hint)) {
    return { type: "id_front", extractedFacts, quality };
  }
  if (looksLikeRegistrationFront(hint)) {
    return { type: "vehicle_registration_front", extractedFacts, quality };
  }
  if (hint.includes("авто") || hint.includes("машин") || hint.includes("vehicle") || hint.includes("car photo")) {
    return { type: "car", extractedFacts, quality: "good" };
  }
  if (mimeType.startsWith("image/") || isImageBase64(input.attachment.contentBase64)) {
    return { type: "unknown", extractedFacts, quality: quality === "poor" ? "poor" : "unknown" };
  }
  return { type: "unknown", extractedFacts, quality: "unknown" };
}

function localExtract(input: ExtractionInput): ExtractionResult {
  const text = (input.text ?? "").toLowerCase();
  const currentFacts = input.dialogueContext?.currentFacts ?? input.facts ?? {};
  const pendingFacts = input.dialogueContext?.pendingFacts ?? input.pendingFacts ?? [];
  const facts: ExtractionResult["facts"] = [];
  const intents: string[] = [];
  const questions: ExtractionResult["questions"] = [];
  const language = detectLanguage(input.text ?? "");
  const pendingOwnerResidence = pendingFacts.includes("ownerResidenceRegion");

  intents.push(...detectTurnIntents(input.text ?? "", pendingFacts, currentFacts));

  const money = resolveMoneyFacts({
    text: input.text,
    currentFacts,
    pendingFacts: pendingFacts.filter((fact): fact is keyof ApplicationFacts => !isDocumentCode(fact))
  });
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
  } else if (text.includes("toyota") || text.includes("тойота") || text.includes("тоета")) {
    facts.push({ key: "vehicleMake", value: "Toyota", confidence: 0.8 });
  }

  if (text.includes("бишкек") || text.includes("бишкекте") || text.includes("бишкеке") || text.includes("bishkek")) {
    facts.push({ key: "residenceRegion", value: "Бишкек", confidence: 0.9 });
    if (pendingOwnerResidence) facts.push({ key: "ownerResidenceRegion", value: "Бишкек", confidence: 0.9 });
    facts.push({ key: "residenceCategory", value: "BISHKEK", confidence: 0.9 });
  }
  if (/(?:\bчуй\b|чүй|чуйская)/i.test(text)) {
    facts.push({ key: "residenceRegion", value: "Чуйская область", confidence: 0.9 });
    if (pendingOwnerResidence) facts.push({ key: "ownerResidenceRegion", value: "Чуйская область", confidence: 0.9 });
    facts.push({ key: "residenceCategory", value: "CHUY", confidence: 0.9 });
  }
  if (/(?:^|[^А-ЯЁа-яёA-Za-z])ош(?:$|[^А-ЯЁа-яёA-Za-z]|то|ко|те)|(?:^|[^A-Za-z])osh(?:$|[^A-Za-z])/i.test(text)) {
    facts.push({ key: "residenceRegion", value: "Ош", confidence: 0.8 });
    if (pendingOwnerResidence) facts.push({ key: "ownerResidenceRegion", value: "Ош", confidence: 0.8 });
    facts.push({ key: "residenceCategory", value: "OTHER_KG", confidence: 0.8 });
  }
  if ((pendingFacts.includes("residenceRegion") || pendingOwnerResidence) && /(?:городская|сельская|временная|постоянная|местная)/i.test(text)) {
    facts.push({ key: "residenceText", value: input.text?.trim() ?? text, confidence: 0.75 });
    facts.push({ key: "residenceNeedsClarification", value: true, confidence: 0.75 });
  }
  if (text.includes("регион 10")) facts.push({ key: "vehicleRegistrationRegion", value: "10", confidence: 0.9 });
  if ((text.includes("зарегистр") || text.includes("учет")) && (text.includes("казахстан") || text.includes("казахстанд"))) {
    facts.push({ key: "vehicleRegistrationCountry", value: "KZ", confidence: 0.9 });
  }
  if (/(?:зарегистрир\w+|учет\w*)[^.!?]{0,30}(?:кыргызстан|кыргыз республикасы|кыргызской республике)/i.test(text)) {
    facts.push({ key: "vehicleRegistrationCountry", value: "KG", confidence: 0.85 });
  }
  if ((text.includes("гражданин") || text.includes("гражданка")) && (text.includes("казахстан") || text.includes("казахстанд"))) {
    facts.push({ key: "citizenship", value: "KZ", confidence: 0.9 });
  }
  if (/(?:гражданин|гражданка)[^.!?]{0,20}(?:кыргызстана|кыргызской республики|кыргыз\s+республики|кыргызстан)/i.test(text)) {
    facts.push({ key: "citizenship", value: "KG", confidence: 0.85 });
  }
  if (text.includes("без изъятия") || text.includes("без изятия")) facts.push({ key: "requestedProgram", value: "without_storage", confidence: 0.9 });
  if (text.includes("стоянк") || text.includes("на парковк") || /с\s+постановк(?:ой|у)?(?:\s+автомобил[яе])?/i.test(text)) facts.push({ key: "requestedProgram", value: "parking", confidence: 0.9 });
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
  if (/(?:я\s+оплатил|проверьте\s+оплату|остаток\s+долга|остал(?:ось|ся)\s+долг[а]?|задолженность|долга\s+по\s+договору|реквизит|действующ(?:ий|ему)\s+договор|не\s+работает\s+gps|перестал\s+работать\s+gps|вернуть\s+документ)/i.test(text)) {
    facts.push({ key: "existingContractQuestion", value: true, confidence: 0.9 });
  }
  if (/(?:я\s+оплатил|проверьте\s+оплату)/i.test(text)) facts.push({ key: "existingContractPaymentMessage", value: true, confidence: 0.9 });
  if (/(?:не\s+в\s+браке|не\s+женат|не\s+замужем|никогда\s+не\s+состоял(?:а)?|никогда\s+не\s+был\s+женат|никогда\s+не\s+была\s+замужем)/i.test(text)) {
    facts.push({ key: "familyStatus", value: "single", confidence: 0.9 });
  } else if (/(?:развед[её]н|разведена|в\s+разводе)/i.test(text)) {
    facts.push({ key: "familyStatus", value: "divorced", confidence: 0.9 });
  } else if (/(?:женат|замужем|состою\s+в\s+браке|(?:^|\s)в\s+браке)/i.test(text)) {
    facts.push({ key: "familyStatus", value: "married", confidence: 0.9 });
  }
  if (/(?:согласие|документ)[^.!?]{0,30}(?:готово|есть|оформлено)/i.test(text)) facts.push({ key: "spouseConsentReady", value: true, confidence: 0.85 });
  if (/(?:согласие)[^.!?]{0,30}(?:нет|не готово|не оформлено)/i.test(text)) facts.push({ key: "spouseConsentReady", value: false, confidence: 0.85 });
  if (/(?:свидетельств\w*\s+о\s+разводе|свидетельств\w*\s+о\s+расторжении\s+брака)[^.!?]{0,20}(?:есть|готово|на руках)/i.test(text)) {
    facts.push({ key: "divorceCertificateReady", value: true, confidence: 0.85 });
  }
  if (/(?:свидетельств\w*\s+о\s+разводе|свидетельств\w*\s+о\s+расторжении\s+брака)[^.!?]{0,20}(?:нет|не готово)/i.test(text)) {
    facts.push({ key: "divorceCertificateReady", value: false, confidence: 0.85 });
  }
  if (/(?:в\s+браке|во\s+время\s+брака)/i.test(text) && currentFacts.familyStatus === "divorced") {
    facts.push({ key: "vehicleBoughtDuringMarriage", value: true, confidence: 0.9 });
  }
  if (/(?:после\s+развода)/i.test(text) && currentFacts.familyStatus === "divorced") {
    facts.push({ key: "vehicleBoughtDuringMarriage", value: false, confidence: 0.9 });
  }
  if (/(?:супруг|супруга|муж|жена)[^.!?]{0,30}(?:за границей|в другом городе|не здесь)/i.test(text)) facts.push({ key: "spouseAway", value: true, confidence: 0.85 });
  if (/(?:поручитель)[^.!?]{0,20}(?:есть|будет|найду)/i.test(text) || /^(?:да|есть)$/i.test(text.trim()) && pendingFacts.includes("guarantorAvailable")) facts.push({ key: "guarantorAvailable", value: true, confidence: 0.85 });
  if (/(?:поручител)[^.!?]{0,20}(?:нет|не будет)|^нет$/i.test(text.trim()) && pendingFacts.includes("guarantorAvailable")) facts.push({ key: "guarantorAvailable", value: false, confidence: 0.85 });
  if (/(?:не\s+могу|не\s+буду|не\s+хочу|нет\s+возможности)[^.!?]{0,40}(?:прислать|отправить)[^.!?]{0,20}(?:документ|фото)/i.test(text)) facts.push({ key: "declinedDocuments", value: true, confidence: 0.9 });
  if (/(?:авто|машин)[^.!?]{0,25}(?:мужа|жены|супруга|супруги|брата|друга|не\s+моя)|оформлен[ао]?\s+на\s+(?:мужа|жену|другого)/i.test(text)) facts.push({ key: "borrowerIsOwner", value: false, confidence: 0.9 });
  if (/(?:собственник)[^.!?]{0,25}(?:приедет|сможет приехать)|(?:сможет\s+ли\s+собственник\s+приехать)[^.!?]{0,10}(?:да|сможет)/i.test(text)) facts.push({ key: "ownerCanVisit", value: true, confidence: 0.85 });
  if (/(?:собственник)[^.!?]{0,25}(?:не\s+приедет|не\s+сможет\s+приехать)|(?:собственник\s+приехать\s+не\s+сможет)/i.test(text)) facts.push({ key: "ownerCanVisit", value: false, confidence: 0.9 });
  if (/(?:приеду|могу\s+приехать|давайте|визит|уже\s+еду|хочу\s+приехать|кел[еэ]\s+алам|келе\s+аламбы)/i.test(text)) {
    facts.push({ key: "visitRequested", value: true, confidence: 0.8 });
  }
  if (/(?:уже\s+еду|я\s+в\s+пути|выехал)/i.test(text)) facts.push({ key: "onTheWay", value: true, confidence: 0.9 });
  if (/(?:уже\s+приехал|я\s+у\s+офиса|стою\s+у\s+офиса|я\s+на\s+месте)/i.test(text)) facts.push({ key: "arrivedAtOffice", value: true, confidence: 0.9 });
  const visitDate = parseVisitDate(text);
  const visitTime = text.match(/(?:^|\s|в)([01]?\d|2[0-3]):([0-5]\d)(?:\s|$|[.,!?])/i);
  if (visitDate) facts.push({ key: "visitDate", value: visitDate, confidence: 0.9 });
  if (visitTime) facts.push({ key: "visitTime", value: `${visitTime[1].padStart(2, "0")}:${visitTime[2]}`, confidence: 0.9 });
  if (text.includes("подумаю") || text.includes("позже")) facts.push({ key: "clientPaused", value: true, confidence: 0.8 });

  if (text.includes("?") || text.includes("какие") || text.includes("какая") || text.includes("сколько") || text.includes("можно ли") || text.includes("где ") || text.includes("почему") || text.includes("откуда")) {
    questions.push(...detectQuestions(input.text ?? ""));
    intents.push("question");
  }

  return {
    language,
    intents: [...new Set(intents)],
    questions,
    facts,
    moneyMentions: money.mentions,
    changedFacts: facts.map((fact) => ({ key: fact.key, newValue: fact.value })),
    route: { kind: "none" },
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
  const today = currentLocalDate();
  if (text.includes("завтра") || text.includes("эртең")) {
    return addDays(today, 1);
  }

  const weekdayOffset = parseRelativeWeekday(text, today);
  if (weekdayOffset !== undefined) {
    return addDays(today, weekdayOffset);
  }
  return undefined;
}

function detectLanguage(text: string): ExtractionResult["language"] {
  const normalized = text.toLocaleLowerCase("ru-RU");
  const kyrgyzSignals = /(менин|каттоом|кандай|эртең|келе\s+аламбы|салам|машинам|керек|сом\b)/i.test(normalized);
  const russianSignals = /[а-яё]/i.test(normalized) && /(здравствуйте|нужно|машина|процент|приехать|документ|браке|разводе|собственник)/i.test(normalized);
  if (kyrgyzSignals && russianSignals) return "mixed";
  if (kyrgyzSignals) return "kg";
  if (russianSignals) return "ru";
  return /[а-яё]/i.test(normalized) ? "ru" : "unknown";
}

function parseRelativeWeekday(text: string, referenceDate: string): number | undefined {
  const normalized = text.toLocaleLowerCase("ru-RU");
  const weekdays: Array<{ pattern: RegExp; day: number }> = [
    { pattern: /понедельник|дүйшөмбү/i, day: 1 },
    { pattern: /вторник|шейшемби/i, day: 2 },
    { pattern: /сред[ау]|шаршемби/i, day: 3 },
    { pattern: /четверг|бейшемби/i, day: 4 },
    { pattern: /пятниц[ау]|жума/i, day: 5 },
    { pattern: /суббот[ау]|ишемби/i, day: 6 },
    { pattern: /воскресенье|жекшемби/i, day: 0 }
  ];
  const target = weekdays.find((item) => item.pattern.test(normalized));
  if (!target) return undefined;

  const currentDay = new Date(`${referenceDate}T12:00:00Z`).getUTCDay();
  let delta = (target.day - currentDay + 7) % 7;
  if (delta === 0) delta = 7;
  return delta;
}

function currentLocalDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
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

function looksLikeClientQuestion(text: string): boolean {
  return /(?:\?\s*$|(?:^|[^\p{L}])(?:что|какая|какой|какие|где|когда|как|можно|почему|зачем|для\s+чего|сколько)(?=$|[^\p{L}])|(?:^|[^\p{L}])не\s+понял(?:а)?(?=$|[^\p{L}])|^\s*а\s+(?:без\s+из[ъь]?ятия|(?:с\s+)?постановк(?:ой|у)?|(?:на\s+)?стоянк))/iu.test(text.trim());
}

function questionTopic(text: string): string {
  const normalized = text.toLocaleLowerCase("ru-RU");
  if (/ставк|процент/.test(normalized)) return "interest_rate";
  if (/адрес|где.*офис|как доехать/.test(normalized)) return "office_location";
  if (/документ|что нужно взять/.test(normalized)) return "documents_required";
  if (/сумм|лимит|сколько.*получ|почему.*мало|откуда.*сумм|что.*мало/.test(normalized)) return "possible_amount";
  if (/график|когда работает|время работы/.test(normalized)) return "office_hours";
  if (/когда[^?]*менеджер[^?]*позвон/.test(normalized)) return "manager_callback_timing";
  if (/wi.?fi|wifi/.test(normalized) || /парков/.test(normalized)) return "office_amenities";
  return "general";
}

function detectTurnIntents(
  text: string,
  pendingFacts: ExtractionInput["pendingFacts"],
  facts: ApplicationFacts
): string[] {
  const normalized = text.trim().toLocaleLowerCase("ru-RU");
  if (!normalized) return [];
  const intents: string[] = [];
  if (/(?:^|[\s,.!?;:])(?:нет|не\s+так|точнее|теперь|уже|ошиб(?:ся|лась)|исправ|лучше)(?:$|[\s,.!?;:])/.test(normalized)) {
    intents.push("correction");
  }
  if (
    /(?:надо|нужно|хочу|дайте|выдайте)\s+больше|(?:мало|маловато|почему\s+так\s+мало|что\s+так\s+мало|а\s+что\s+так\s+мало|откуда\s+(?:эта|такая)\s+сумма)/.test(normalized) ||
    (facts.requestedProgram === "without_storage" && facts.residenceRegion && /(?:мне\s+)?(?:надо|нужно|хочу)\s+\d/.test(normalized))
  ) {
    intents.push("limit_objection");
  }
  if (/(?:я\s+)?(?:уже\s+)?(?:написал|писал|сказал|говорил|отправлял|указывал)|выше\s+(?:писал|написал|сказал)/.test(normalized)) {
    intents.push("already_provided");
  }
  if (/(?:почему|откуда|как\s+счит|как\s+рассчит|из-за\s+чего|по\s+какой\s+причине)/.test(normalized)) {
    intents.push("clarification_request");
  }
  if (/(?:не\s+могу|не\s+буду|не\s+хочу|нет\s+возможности|не\s+получится)[^.!?]{0,70}(?:прислать|отправить|скинуть)?[^.!?]{0,30}(?:документ|фото|техпаспорт|id|айди)/.test(normalized)) {
    intents.push("document_unavailable");
  }
  if (/(?:охренел|ужасн|безобраз|кошмар|возмут|не\s+устраива|слишком\s+(?:дорого|много)|плохие\s+услов)/.test(normalized)) {
    intents.push("complaint");
  }
  if (/(?:подумаю|позже\s+(?:напиш|отвеч)|пока\s+не\s+решил)/.test(normalized)) intents.push("pause");
  if (/(?:уже\s+(?:еду|выехал)|я\s+в\s+пути)/.test(normalized)) intents.push("on_the_way");
  if (/(?:уже\s+приехал|у\s+офиса|на\s+месте)/.test(normalized)) intents.push("arrived");
  if (
    normalized.length <= 4 &&
    !/\d/.test(normalized) &&
    (pendingFacts?.length ?? 0) > 0
  ) {
    intents.push("ambiguous_reply");
  }
  return intents;
}

function normalizeExtractionResult(payload: unknown, input?: ExtractionInput): ExtractionResult {
  const source = isRecord(payload) ? payload : {};
  const normalized: ExtractionResult = {
    language: normalizeLanguage(source.language),
    turnKind: normalizeTurnKind(source.turnKind),
    intents: normalizeStringArray(source.intents),
    questions: normalizeQuestions(source.questions),
    facts: normalizeFacts(source.facts),
    moneyMentions: [],
    changedFacts: normalizeChangedFacts(source.changedFacts),
    route: normalizeRouteProposal(source.route),
    attachments: normalizeAttachments(source.attachments),
    promptInjectionDetected: source.promptInjectionDetected === true,
    clarificationNeeded: source.clarificationNeeded === true
  };

  const modelMoneyMentions = normalizeMoneyMentions(source.moneyMentions);
  normalized.moneyMentions = reconcileMoneyMentionsWithText(modelMoneyMentions, input?.text);
  if (!input) return normalized;

  normalized.moneyMentions = harmonizeMoneyMentionCurrencies(normalized.moneyMentions, input.text);
  normalized.facts = backfillMoneyFacts(normalized.facts, normalized.moneyMentions);
  normalized.facts = discardUnconfirmedMoneyFacts(normalized.facts, normalized.moneyMentions, input.text);
  return normalized;
}

function prepareExtractionPayload(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload;
  }

  const facts = Array.isArray(payload.facts)
    ? payload.facts.flatMap((item) => {
        if (!isRecord(item)) return [];
        const key = typeof item.key === "string" ? item.key : typeof item.field === "string" ? item.field : undefined;
        if (!key) return [];
        // Foreign-currency amounts must stay in moneyMentions for FX conversion.
        if ((key === "vehicleValue" || key === "requestedAmount") && item.currency && item.currency !== "KGS") return [];
        return [{
          ...item,
          key,
          value: "value" in item ? item.value : "amount" in item ? item.amount : undefined
        }];
      })
    : payload.facts;
  const changedFacts = Array.isArray(payload.changedFacts)
    ? payload.changedFacts.flatMap((item) => {
        if (!isRecord(item)) return [];
        const key = typeof item.key === "string" ? item.key : typeof item.field === "string" ? item.field : undefined;
        if (!key) return [];
        return [{ ...item, key, newValue: "newValue" in item ? item.newValue : "amount" in item ? item.amount : undefined }];
      })
    : payload.changedFacts;

  return { ...payload, facts, changedFacts, route: payload.route ?? { kind: "none" } };
}

function buildLocalResponse(input: ResponseGenerationInput): string {
  const parts = [
    ...input.responsePlan.answers.map((answer) => answer.exactText).filter((value): value is string => Boolean(value)),
    ...input.responsePlan.requiredStatements.filter((statement) => !statement.startsWith("Попросить")),
    ...input.responsePlan.nextQuestions
  ];
  return [...new Set(parts)].filter(Boolean).join("\n\n").trim() || "Уточните, пожалуйста, модель, год автомобиля, ориентировочную стоимость и нужную сумму.";
}

function shouldUseDeterministicResponseFastPath(input: ResponseGenerationInput): boolean {
  const exactAnswers = input.responsePlan.answers.every((answer) => typeof answer.exactText === "string" && answer.exactText.trim().length > 0);
  const hasDeterministicContent =
    input.responsePlan.answers.length > 0 ||
    input.responsePlan.nextQuestions.length > 0 ||
    input.responsePlan.requiredStatements.some((statement) => !statement.startsWith("Попросить"));

  return exactAnswers && hasDeterministicContent;
}

function isDocumentCode(value: keyof ApplicationFacts | import("@ailyn/business-rules").DocumentCode): boolean {
  return value === "id_front" || value === "id_back" || value === "vehicle_registration_front" || value === "vehicle_registration_back" || value === "car_photo" || value === "unknown";
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
  return hint.includes("паспорт") || hint.includes("id card") || hint.includes("личн") || hint.includes("id front") || hint.includes("passport front");
}

function looksLikeIdBack(hint: string): boolean {
  return hint.includes("паспорт") && hint.includes("обрат") || hint.includes("id back") || hint.includes("passport back");
}

function looksLikeRegistrationFront(hint: string): boolean {
  return hint.includes("свидетельств") || hint.includes("регистрац") || hint.includes("техпаспорт") || hint.includes("registration front") || hint.includes("ts front") || hint.includes("sts front");
}

function looksLikeRegistrationBack(hint: string): boolean {
  return (hint.includes("свидетельств") || hint.includes("регистрац") || hint.includes("техпаспорт")) && hint.includes("обрат") || hint.includes("registration back") || hint.includes("ts back") || hint.includes("sts back");
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

function normalizeTurnKind(value: unknown): ExtractionResult["turnKind"] {
  return value === "fact_update" || value === "question" || value === "mixed" || value === "control" || value === "attachment" || value === "unknown"
    ? value
    : undefined;
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

function normalizeMoneyMentions(value: unknown): ModelMoneyMention[] {
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
      (item.currency !== null && item.currency !== "KGS" && item.currency !== "USD" && item.currency !== "EUR" && item.currency !== "KZT" && item.currency !== "RUB") ||
      (item.roleCandidate !== "requestedAmount" && item.roleCandidate !== "vehicleValue" && item.roleCandidate !== "unknown") ||
      typeof item.confidence !== "number"
    ) {
      return [];
    }

    return [{
      sourceText: item.sourceText,
      amount: item.amount,
      normalizedAmount: item.normalizedAmount,
      currency: item.currency,
      roleCandidate: item.roleCandidate,
      confidence: item.confidence
    }];
  });
}

function backfillMoneyFacts(
  facts: ExtractionResult["facts"],
  moneyMentions: ExtractionResult["moneyMentions"]
): ExtractionResult["facts"] {
  const byKey = new Map<keyof ApplicationFacts, ExtractionResult["facts"][number]>();
  const unknownMoneyRoles = new Set<"requestedAmount" | "vehicleValue">(moneyMentions.flatMap((mention) =>
    mention.currency === null && mention.roleCandidate !== "unknown" ? [mention.roleCandidate] : []
  ));
  for (const fact of facts) {
    if ((fact.key === "requestedAmount" || fact.key === "vehicleValue") && unknownMoneyRoles.has(fact.key)) {
      continue;
    }
    byKey.set(fact.key, fact);
  }

  for (const mention of moneyMentions) {
    if (mention.currency !== "KGS") {
      // The structured model may have emitted a numeric KGS fact alongside a
      // foreign-currency mention. Keep the amount exclusively in the FX path;
      // otherwise a raw value such as `10 к долларов` can be stored as 10 som.
      if (mention.currency !== null && (mention.roleCandidate === "vehicleValue" || mention.roleCandidate === "requestedAmount")) {
        byKey.delete(mention.roleCandidate);
      }
      continue;
    }
    if (mention.roleCandidate === "vehicleValue" && !byKey.has("vehicleValue")) {
      byKey.set("vehicleValue", { key: "vehicleValue", value: mention.normalizedAmount, confidence: mention.confidence });
    }
    if (mention.roleCandidate === "requestedAmount" && !byKey.has("requestedAmount")) {
      byKey.set("requestedAmount", { key: "requestedAmount", value: mention.normalizedAmount, confidence: mention.confidence });
    }
  }

  return [...byKey.values()];
}

function reconcileMoneyMentionsWithText(
  mentions: ModelMoneyMention[],
  text: string | undefined
): ExtractionResult["moneyMentions"] {
  if (mentions.length === 0) return [];
  if (!text) return mentions;
  const parsedFromText = detectMoneyMentions(text);
  const consumedParsedIndexes = new Set<number>();
  const consumedRanges = new Set<string>();

  return mentions.map((mention) => {
    const source = mention.sourceText.trim().toLocaleLowerCase("ru-RU");
    const exactIndex = parsedFromText.findIndex((candidate, index) =>
      !consumedParsedIndexes.has(index) && candidate.sourceText.trim().toLocaleLowerCase("ru-RU") === source
    );
    const equivalentIndexes = parsedFromText.flatMap((candidate, index) =>
      !consumedParsedIndexes.has(index) && candidate.normalizedAmount === mention.normalizedAmount ? [index] : []
    );
    const parsedIndex = exactIndex >= 0 ? exactIndex : equivalentIndexes.length === 1 ? equivalentIndexes[0] : undefined;
    const parsed = parsedIndex === undefined ? undefined : parsedFromText[parsedIndex];
    if (parsedIndex === undefined || !parsed) {
      const range = findSourceTextRange(text, mention.sourceText, consumedRanges);
      const currency = mention.currency === "KGS" ? null : mention.currency;
      return range === undefined
        ? { ...mention, currency }
        : { ...mention, sourceText: text.slice(range.start, range.end), currency, ...range };
    }
    consumedParsedIndexes.add(parsedIndex);
    consumedRanges.add(`${parsed.start}:${parsed.end}`);
    return {
      ...mention,
      sourceText: parsed.sourceText,
      amount: parsed.normalizedAmount,
      normalizedAmount: parsed.normalizedAmount,
      // A parser's implicit KGS default is not evidence that the model's
      // unknown currency is som. Explicit source markers can safely resolve it.
      currency: hasExplicitCurrencyMarker(parsed.sourceText)
        ? parsed.currency
        : mention.currency === "KGS" ? null : mention.currency,
      confidence: Math.max(mention.confidence, parsed.confidence),
      start: parsed.start,
      end: parsed.end
    };
  });
}

function findSourceTextRange(text: string, sourceText: string, consumedRanges: Set<string>): { start: number; end: number } | undefined {
  const normalizedSourceText = sourceText.trim().toLocaleLowerCase("ru-RU");
  if (!normalizedSourceText) return undefined;
  const normalizedText = text.toLocaleLowerCase("ru-RU");
  let start = normalizedText.indexOf(normalizedSourceText);
  while (start >= 0) {
    const end = start + normalizedSourceText.length;
    const rangeKey = `${start}:${end}`;
    if (!consumedRanges.has(rangeKey)) {
      consumedRanges.add(rangeKey);
      return { start, end };
    }
    start = normalizedText.indexOf(normalizedSourceText, start + normalizedSourceText.length);
  }
  return undefined;
}

function harmonizeMoneyMentionCurrencies(
  mentions: ExtractionResult["moneyMentions"],
  text: string | undefined
): ExtractionResult["moneyMentions"] {
  if (mentions.length !== 2 || !text) {
    return mentions;
  }

  const foreignMention = mentions.find((mention) => mention.currency !== null && mention.currency !== "KGS" && hasExplicitCurrencyMarker(mention.sourceText));
  if (!foreignMention) {
    return mentions;
  }

  const inferredMention = mentions.find((mention) =>
    mention !== foreignMention &&
    (mention.currency === "KGS" || mention.currency === null) &&
    !hasExplicitCurrencyMarker(mention.sourceText) &&
    mention.roleCandidate !== "unknown" &&
    foreignMention.roleCandidate !== "unknown" &&
    mention.roleCandidate !== foreignMention.roleCandidate
  );
  if (!inferredMention) {
    return mentions;
  }

  if (foreignMention.start === undefined || foreignMention.end === undefined || inferredMention.start === undefined || inferredMention.end === undefined) {
    return mentions;
  }
  const between = text.slice(
    Math.min(foreignMention.end, inferredMention.end),
    Math.max(foreignMention.start, inferredMention.start)
  );
  if (/[.!?\n]/.test(between)) {
    return mentions;
  }

  return mentions.map((mention) =>
    mention === inferredMention
      ? { ...mention, currency: foreignMention.currency, confidence: Math.max(0.7, mention.confidence - 0.08) }
      : mention
  );
}

function hasExplicitCurrencyMarker(sourceText: string): boolean {
  return /(?:\$|€|₸|₽|\busd\b|\beur\b|\bkzt\b|\brub\b|\bkgs\b|доллар|евро|тенге|сом|руб)/iu.test(sourceText);
}

function discardUnconfirmedMoneyFacts(
  facts: ExtractionResult["facts"],
  mentions: ExtractionResult["moneyMentions"],
  text: string | undefined
): ExtractionResult["facts"] {
  if (!text) return facts;
  const unknownRoles = new Set<"requestedAmount" | "vehicleValue">();
  for (const detected of detectMoneyMentions(text)) {
    if (detected.currency !== null || detected.roleCandidate === "unknown") continue;
    const hasCompatibleMention = mentions.some((mention) =>
      mention.roleCandidate === detected.roleCandidate &&
      mention.normalizedAmount === detected.normalizedAmount &&
      mention.currency !== null
    );
    if (!hasCompatibleMention) unknownRoles.add(detected.roleCandidate);
  }
  return facts.filter((fact) =>
    !((fact.key === "requestedAmount" || fact.key === "vehicleValue") && unknownRoles.has(fact.key))
  );
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
    const normalizedValue = normalizeApplicationFactValue(key, item.value);
    return [
      {
        key,
        value: normalizedValue,
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
    const key = item.key as keyof ApplicationFacts;
    return [{ key, newValue: normalizeApplicationFactValue(key, item.newValue) }];
  });
}

// RouterAI occasionally serializes a structured numeric value as a JSON string.
// This is deterministic post-processing of a value RouterAI already extracted,
// not local natural-language interpretation. Without it, a future vehicle year
// is silently rejected by the route validator before the business rule can ask
// the client to correct the typo.
function normalizeApplicationFactValue(key: keyof ApplicationFacts, value: unknown): unknown {
  if (key !== "vehicleYear" && key !== "vehicleValue" && key !== "requestedAmount" && key !== "reportedInvalidVehicleYear") {
    return value;
  }
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const normalized = value.trim().replace(/[\s,]/g, "");
  return /^\d+$/.test(normalized) ? Number(normalized) : value;
}

function normalizeRouteProposal(value: unknown): RouteProposal {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return { kind: "none" };
  }
  if (value.kind === "none") {
    return { kind: "none" };
  }
  if (typeof value.fact !== "string" || !applicationFactKeys.has(value.fact)) {
    return { kind: "none" };
  }
  const fact = value.fact as keyof ApplicationFacts;
  if (value.kind === "clarify") {
    return { kind: "clarify", fact };
  }
  if (value.kind === "set_fact" && "value" in value) {
    return { kind: "set_fact", fact, value: value.value };
  }
  return { kind: "none" };
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

function normalizeVisionResult(payload: unknown): VisionResult {
  if (!isRecord(payload)) {
    throw new Error("RouterAI vision response is not an object");
  }
  const type = typeof payload.type === "string" && isAttachmentType(payload.type) ? payload.type : undefined;
  const quality = payload.quality === "good" || payload.quality === "poor" || payload.quality === "unknown" ? payload.quality : undefined;
  if (!type || !quality) {
    throw new Error("RouterAI vision response does not match structured schema");
  }
  return {
    type,
    quality,
    extractedFacts: normalizeFacts(payload.extractedFacts)
  };
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
