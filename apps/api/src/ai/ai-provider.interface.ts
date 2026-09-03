import type { ApplicationFacts, DecisionResult, DocumentCode } from "@ailyn/business-rules";
import type { MoneyCurrencyCode, MoneyMention, MoneyRoleCandidate } from "../dialogue/money-normalization.js";

export type NormalizedMoneyValue = {
  field: "vehicleValue" | "requestedAmount";
  amount: number;
  currency: MoneyCurrencyCode;
  confidence: number;
};

export interface InboundAttachment {
  id: string;
  mimeType?: string;
  fileName?: string;
  kindHint?: string;
  contentBase64?: string;
  textContent?: string;
  metadata?: Record<string, unknown>;
}

export interface ExtractionInput {
  text?: string;
  attachments: InboundAttachment[];
  /** Bounded runtime state supplied by the dialogue orchestrator. */
  dialogueContext?: DialogueContext;
  /** @deprecated Use dialogueContext.currentFacts. */
  facts?: ApplicationFacts;
  /** @deprecated Use dialogueContext.pendingFacts. */
  pendingFacts?: (keyof ApplicationFacts | DocumentCode)[];
}

export interface DialogueContext {
  summary: string;
  recentMessages: Array<{ author: "client" | "ai"; text: string }>;
  currentFacts: ApplicationFacts;
  pendingFacts: Array<keyof ApplicationFacts | DocumentCode>;
  decisionEnvelope: {
    allowedNextFacts: string[];
    activeOffer?: "parking_after_without_storage_limit";
  };
}

export type RouteProposal =
  | { kind: "set_fact"; fact: keyof ApplicationFacts; value: unknown }
  | { kind: "clarify"; fact: keyof ApplicationFacts }
  | { kind: "none" };

/**
 * RouterAI's structured extraction record. Unlike the runtime MoneyMention,
 * it may report an unknown currency and never needs text offsets.
 */
export interface ModelMoneyMention {
  sourceText: string;
  amount: number;
  normalizedAmount: number;
  currency: MoneyCurrencyCode | null;
  roleCandidate: MoneyRoleCandidate;
  confidence: number;
}

export interface ExtractionResult {
  language: "ru" | "kg" | "mixed" | "unknown";
  /** Primary classification of the current client turn, produced by RouterAI. */
  turnKind?: "fact_update" | "question" | "mixed" | "control" | "attachment" | "unknown";
  intents: string[];
  questions: { text: string; topic: string }[];
  facts: { key: keyof ApplicationFacts; value: unknown; confidence: number }[];
  moneyMentions: MoneyMention[];
  changedFacts: { key: keyof ApplicationFacts; newValue: unknown }[];
  route: RouteProposal;
  attachments: {
    attachmentId: string;
    type:
      | "id_front"
      | "id_back"
      | "vehicle_registration_front"
      | "vehicle_registration_back"
      | "car"
      | "unknown"
      | "poor_quality";
    confidence: number;
  }[];
  promptInjectionDetected: boolean;
  clarificationNeeded: boolean;
}

export interface VisionInput {
  attachment: InboundAttachment;
}

export interface VisionResult {
  type:
    | "id_front"
    | "id_back"
    | "vehicle_registration_front"
    | "vehicle_registration_back"
    | "car"
    | "unknown"
    | "poor_quality";
  extractedFacts: { key: keyof ApplicationFacts; value: unknown; confidence: number }[];
  quality: "good" | "poor" | "unknown";
}

export interface ResponseGenerationInput {
  userText?: string;
  facts: ApplicationFacts;
  decision: DecisionResult;
  responsePlan: ResponsePlan;
}

export interface ResponsePlan {
  answers: { topic: string; meaning: string; exactText?: string }[];
  nextAction: string;
  nextQuestions: string[];
  allowedFacts: Record<string, unknown>;
  allowedFinancialValues: number[];
  requiredStatements: string[];
  forbiddenStatements: string[];
  language: "ru" | "kg";
}

export interface GeneratedResponse {
  message: string;
  model: string;
  promptVersion: string;
}

export interface AiProvider {
  extract(input: ExtractionInput): Promise<ExtractionResult>;
  generateResponse(input: ResponseGenerationInput): Promise<GeneratedResponse>;
  analyzeImage(input: VisionInput): Promise<VisionResult>;
}
