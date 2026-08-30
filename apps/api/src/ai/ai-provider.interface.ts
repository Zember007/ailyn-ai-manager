import type { ApplicationFacts, DecisionResult, DocumentCode } from "@ailyn/business-rules";

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
  facts: ApplicationFacts;
  pendingFacts?: (keyof ApplicationFacts | DocumentCode)[];
}

export interface ExtractionResult {
  language: "ru" | "kg" | "mixed" | "unknown";
  intents: string[];
  questions: { text: string; topic: string }[];
  facts: { key: keyof ApplicationFacts; value: unknown; confidence: number }[];
  changedFacts: { key: keyof ApplicationFacts; newValue: unknown }[];
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
