import { z } from "@ailyn/schemas";
import type { ApplicationFacts, DecisionResult } from "@ailyn/business-rules";

export const languageSchema = z.enum(["ru", "kg", "mixed", "unknown"]);
export const questionSchema = z.object({ text: z.string().min(1), topic: z.string().min(1) });
export const extractionSchema = z.object({
  language: languageSchema,
  intents: z.array(z.string()).default([]),
  questions: z.array(questionSchema).default([]),
  facts: z.array(z.object({ key: z.string(), value: z.unknown(), confidence: z.number().min(0).max(1) })).default([]),
  changedFacts: z.array(z.object({ key: z.string(), newValue: z.unknown() })).default([]),
  attachments: z.array(z.object({ attachmentId: z.string(), type: z.string(), confidence: z.number().min(0).max(1) })).default([]),
  promptInjectionDetected: z.boolean().default(false),
  clarificationNeeded: z.boolean().default(false)
});
export const responseGenerationSchema = z.object({ message: z.string().min(1).max(4000) });

export type StructuredExtraction = z.infer<typeof extractionSchema>;

export interface KnowledgeAnswer {
  key: string;
  text: string;
  exact: boolean;
  blocked?: boolean;
}

export interface ResponsePlanV62 {
  language: "ru" | "kg";
  answers: KnowledgeAnswer[];
  nextAction: DecisionResult["nextAction"];
  nextQuestions: string[];
  requiredStatements: string[];
  forbiddenStatements: string[];
  knownFactKeys: (keyof ApplicationFacts)[];
  validation: {
    requiresPreliminaryDisclaimer: boolean;
    visitConfirmation?: { date: string; time: string; address: string; latestArrivalTime: string };
    firstMessage: boolean;
  };
  trace: {
    intents: string[];
    questionCount: number;
    kbKeys: string[];
    blocked: string[];
    recovery?: {
      unresolvedFacts: string[];
      reason: "unrecognized_reply" | "attachment_issue";
    };
  };
}

export interface DeferredIntegrationResult<T> {
  available: false;
  code: "SPEC_GAP_STT" | "SPEC_GAP_FX" | "SPEC_GAP_CALENDAR" | "SPEC_GAP_MANAGER_DELIVERY";
  value?: T;
}

export interface SpeechToTextProvider { transcribe(): Promise<DeferredIntegrationResult<string>>; }
export interface FxRateProvider { convertToSom(): Promise<DeferredIntegrationResult<number>>; }
export interface WorkingCalendarProvider { isWorkingTime(): Promise<DeferredIntegrationResult<boolean>>; }
export interface ManagerNotificationChannel { deliver(): Promise<DeferredIntegrationResult<void>>; }
