import { z } from "@ailyn/schemas";
import type { ApplicationFacts, DecisionResult } from "@ailyn/business-rules";
import type { MoneyCurrencyCode, MoneyMention, MoneyRoleCandidate } from "./money-normalization.js";

export const languageSchema = z.enum(["ru", "kg", "mixed", "unknown"]);
export const questionSchema = z.object({ text: z.string().min(1), topic: z.string().min(1) });
export const extractionSchema = z.object({
  language: languageSchema,
  intents: z.array(z.string()).default([]),
  questions: z.array(questionSchema).default([]),
  facts: z.array(z.object({ key: z.string(), value: z.unknown(), confidence: z.number().min(0).max(1) })).default([]),
  moneyMentions: z.array(z.object({
    sourceText: z.string().min(1),
    amount: z.number(),
    normalizedAmount: z.number(),
    currency: z.enum(["KGS", "USD", "EUR", "KZT", "RUB"]),
    roleCandidate: z.enum(["requestedAmount", "vehicleValue", "unknown"]),
    confidence: z.number().min(0).max(1),
    start: z.number().int().min(0),
    end: z.number().int().min(0)
  })).default([]),
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
    moneyMentions?: MoneyMention[];
    fxConversions?: FxConversionTrace[];
    recovery?: {
      unresolvedFacts: string[];
      reason: "unrecognized_reply" | "attachment_issue" | "fx_unavailable";
    };
  };
}

export interface DeferredIntegrationResult<T> {
  available: false;
  code: "SPEC_GAP_STT" | "SPEC_GAP_FX" | "SPEC_GAP_CALENDAR" | "SPEC_GAP_MANAGER_DELIVERY";
  value?: T;
}

export interface SpeechToTextProvider { transcribe(): Promise<DeferredIntegrationResult<string>>; }
export interface FxConversionResult {
  available: true;
  value: number;
  currency: MoneyCurrencyCode;
  rate: number;
  nominal: number;
  source: "NBKR";
  sourceUrl: string;
  effectiveDate: string;
}

export interface FxConversionTrace {
  role: Exclude<MoneyRoleCandidate, "unknown">;
  sourceText: string;
  currency: MoneyCurrencyCode;
  amount: number;
  somValue?: number;
  status: "converted" | "blocked";
  source?: "NBKR";
  sourceUrl?: string;
  effectiveDate?: string;
  code?: DeferredIntegrationResult<number>["code"];
}

export interface FxRateProvider {
  convertToSom(input: { amount: number; currency: Exclude<MoneyCurrencyCode, "KGS"> }): Promise<FxConversionResult | DeferredIntegrationResult<number>>;
}
export interface WorkingCalendarProvider { isWorkingTime(): Promise<DeferredIntegrationResult<boolean>>; }
export interface ManagerNotificationChannel { deliver(): Promise<DeferredIntegrationResult<void>>; }
