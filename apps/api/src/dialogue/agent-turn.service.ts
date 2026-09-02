import { Injectable, Logger } from "@nestjs/common";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig } from "@ailyn/config";
import type { ApplicationFacts } from "@ailyn/business-rules";
import { RouterAiClient } from "../ai/router-ai/router-ai.client.js";
import type { InboundAttachment } from "../channels/channel.interface.js";
import { generatedDocumentationChunks } from "./documentation-chunks.generated.js";
import { agentTurnResultSchema, type AgentTurnResult } from "./agent-turn.contracts.js";
import type { Stage1Message } from "./stage1-store.service.js";

const PROMPT_VERSION = "single-agent-v1";
const NEUTRAL_REPLY = "Извините, сейчас не удалось обработать сообщение. Пожалуйста, напишите ещё раз или обратитесь к сотрудникам компании.";

@Injectable()
export class AgentTurnService {
  private readonly config = loadAppConfig();
  private readonly logger = new Logger(AgentTurnService.name);

  constructor(private readonly client: RouterAiClient) {}

  async run(input: { messages: Stage1Message[]; facts: ApplicationFacts; settings: object; text?: string; attachments: InboundAttachment[] }): Promise<{ result?: AgentTurnResult; reply: string; model: string; promptVersion: string; error?: string }> {
    if (!this.client.isConfigured()) return { reply: NEUTRAL_REPLY, model: "unconfigured", promptVersion: PROMPT_VERSION, error: "routerai_not_configured" };
    try {
      const response = await this.client.createChatCompletion({
        model: this.config.routerAiTextModel ?? "routerai-text-model-not-configured", temperature: 0.2, max_tokens: 1600, reasoning: { enabled: false }, response_format: { type: "json_object" },
        messages: [{ role: "system", content: loadPrompt("agent.system.md") }, { role: "user", content: buildMessage(input) }]
      }, { timeoutMs: this.config.routerAiTimeoutMs });
      const payload = normalizeAgentPayload(JSON.parse(response.choices?.[0]?.message?.content ?? "{}") as Record<string, unknown>);
      const parsed = agentTurnResultSchema.safeParse(payload);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
        const state = payload.dialogueState && typeof payload.dialogueState === "object"
          ? (payload.dialogueState as Record<string, unknown>).stage
          : undefined;
        throw new Error(`Agent response does not match AgentTurnResult (${issues}; stage=${JSON.stringify(state)}; targetEvent=${JSON.stringify(payload.targetEvent)})`);
      }
      return { result: parsed.data, reply: parsed.data.reply, model: response.model ?? this.config.routerAiTextModel ?? "routerai", promptVersion: PROMPT_VERSION };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Single-agent fallback activated: ${message}`);
      return { reply: NEUTRAL_REPLY, model: this.config.routerAiTextModel ?? "routerai", promptVersion: PROMPT_VERSION, error: message };
    }
  }
}

function buildMessage(input: { messages: Stage1Message[]; facts: ApplicationFacts; settings: object; text?: string; attachments: InboundAttachment[] }) {
  const context = { history: input.messages.map(({ author, body, createdAt }) => ({ author, text: body, createdAt })), leadCard: input.facts, settings: input.settings, currentMessage: input.text ?? "", knowledge: selectKnowledge([input.text ?? "", JSON.stringify(input.facts), input.messages.at(-1)?.body ?? ""].join(" ")) };
  const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "high" } }> = [{ type: "text", text: JSON.stringify(context) }];
  for (const attachment of input.attachments) {
    parts.push({ type: "text", text: JSON.stringify({ attachment: { id: attachment.id, fileName: attachment.fileName, mimeType: attachment.mimeType, textContent: attachment.textContent, metadata: attachment.metadata } }) });
    if (attachment.contentBase64 && /^image\/(jpeg|png|webp|gif)$/i.test(attachment.mimeType ?? "")) parts.push({ type: "image_url", image_url: { url: `data:${attachment.mimeType};base64,${attachment.contentBase64}`, detail: "high" } });
  }
  return parts;
}

function selectKnowledge(query: string) {
  const tokens = new Set(query.toLocaleLowerCase("ru-RU").match(/[\p{L}\p{N}]{4,}/gu) ?? []);
  const core = generatedDocumentationChunks.slice(0, 8);
  const relevant = generatedDocumentationChunks.map((chunk) => ({ chunk, score: chunk.keywords.reduce((n, word) => n + (tokens.has(word) ? 1 : 0), 0) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 8).map((item) => item.chunk);
  return [...new Map([...core, ...relevant].map((chunk) => [chunk.key, chunk])).values()].map(({ key, text }) => ({ key, text }));
}

function loadPrompt(name: string) {
  const directory = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(directory, "../ai/prompts", name), resolve(process.cwd(), "apps/api/src/ai/prompts", name)];
  const path = candidates.find(existsSync);
  if (!path) throw new Error(`Prompt file not found: ${name}`);
  return readFileSync(path, "utf8");
}

/** Translate model-friendly labels into the persisted Stage 1 enum before Zod
 * validates the final boundary. Unknown values stay unchanged and are rejected. */
function normalizeAgentPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const leadCardPatch = payload.leadCardPatch;
  if (leadCardPatch && typeof leadCardPatch === "object" && !Array.isArray(leadCardPatch)) {
    const patch = { ...(leadCardPatch as Record<string, unknown>) };
    for (const [alias, key] of Object.entries(leadCardAliases)) {
      if (patch[key] === undefined && patch[alias] !== undefined) patch[key] = patch[alias];
      delete patch[alias];
    }
    for (const key of numericLeadCardKeys) {
      if (typeof patch[key] === "string") {
        const value = Number(patch[key].replace(/[\s_]/g, "").replace(",", "."));
        if (Number.isFinite(value)) patch[key] = value;
      }
    }
    for (const key of booleanLeadCardKeys) {
      if (typeof patch[key] === "string" && ["true", "false"].includes(patch[key].trim().toLowerCase())) {
        patch[key] = patch[key].trim().toLowerCase() === "true";
      }
    }
    payload.leadCardPatch = patch;
  }
  const state = payload.dialogueState;
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const stage = (state as Record<string, unknown>).stage;
    if (typeof stage === "string") {
      const normalized = stageAliases[stage.trim().toLowerCase()];
      if (normalized) payload.dialogueState = { ...(state as Record<string, unknown>), stage: normalized };
    }
  }
  if (typeof payload.targetEvent === "string" && ["", "none", "null", "no"].includes(payload.targetEvent.trim().toLowerCase())) {
    payload.targetEvent = null;
  }
  return payload;
}

const stageAliases: Record<string, string> = {
  new: "NEW", initial: "NEW", collecting_vehicle: "COLLECTING_VEHICLE", collect_vehicle: "COLLECTING_VEHICLE",
  collecting_value: "COLLECTING_VALUE", collect_value: "COLLECTING_VALUE", collecting_amount: "COLLECTING_AMOUNT", collect_amount: "COLLECTING_AMOUNT",
  collecting_residence: "COLLECTING_RESIDENCE", collect_residence: "COLLECTING_RESIDENCE", eligibility_check: "ELIGIBILITY_CHECK",
  collecting_documents: "COLLECTING_DOCUMENTS", collect_documents: "COLLECTING_DOCUMENTS", collecting_family_status: "COLLECTING_FAMILY_STATUS",
  checking_guarantor: "CHECKING_GUARANTOR", check_guarantor: "CHECKING_GUARANTOR", scheduling_visit: "SCHEDULING_VISIT",
  target_reached_documents: "TARGET_REACHED_DOCUMENTS", target_reached_visit: "TARGET_REACHED_VISIT", refused: "REFUSED", paused: "PAUSED",
  existing_contract_redirect: "EXISTING_CONTRACT_REDIRECT"
};

const leadCardAliases: Record<string, string> = {
  carBrand: "vehicleMake", carMake: "vehicleMake", carModel: "vehicleModel", carYear: "vehicleYear", carValue: "vehicleValue",
  loanAmount: "requestedAmount", neededAmount: "requestedAmount", requestedLoanAmount: "requestedAmount",
  clientName: "fullName", customerName: "fullName", clientPhone: "phone", customerPhone: "phone",
  residence: "residenceRegion", program: "requestedProgram", visitDatetime: "visitDate"
};

const numericLeadCardKeys = new Set(["vehicleYear", "reportedInvalidVehicleYear", "vehicleValue", "requestedAmount"]);
const booleanLeadCardKeys = new Set([
  "residenceNeedsClarification", "ownerChanged", "plateChanged", "ownerIsLegalEntity", "borrowerIsLegalEntity", "vehicleInCredit", "vehiclePledged", "vehicleArrested", "registrationRestricted", "refinancingRequested", "buyoutRequested", "accidentNotDrivable", "foreignTravelQuestion", "existingContractQuestion", "existingContractPaymentMessage", "borrowerIsOwner", "ownerCanVisit", "vehicleBoughtDuringMarriage", "spouseConsentReady", "spouseAway", "guarantorAvailable", "visitRequested", "clientPaused", "clientClosed", "declinedDocuments", "declinedCarPhoto", "vehiclePurchasedDuringMarriage", "divorceCertificateReady", "visitConfirmationPending", "handedToManager", "onTheWay", "arrivedAtOffice"
]);
