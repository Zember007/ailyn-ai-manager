import { Injectable } from "@nestjs/common";
import { calculateLoanLimits, defaultBusinessRuleSettings, type ApplicationFacts, type BusinessRuleSettings } from "@ailyn/business-rules";
import { AgentTurnService } from "./agent-turn.service.js";
import type { InboundMessage } from "../channels/channel.interface.js";
import { SettingsService } from "../settings/settings.service.js";
import { BackendLogsService } from "../logs/backend-logs.service.js";
import { Stage1StoreService, type Stage1Application, type Stage1Conversation } from "./stage1-store.service.js";
import { DeferredIntegrationsService } from "./deferred-integrations.service.js";
import { formatMoney, resolveMoneyFacts, type ForeignMoneyCurrencyCode } from "./money-normalization.js";

export interface DialogueResult { conversation: Stage1Conversation; application: Stage1Application; reply: string; validation: { passed: boolean; errors: string[] }; routerAiModel: string; promptVersion: string; }
const managerDeltaFactKeys = new Set(["requestedAmount", "requestedProgram", "visitDate", "visitTime", "vehicleValue", "vehicleMake", "vehicleModel", "vehicleYear", "fullName", "phone"]);

@Injectable()
export class DialogueOrchestratorService {
  constructor(private readonly agent: AgentTurnService, private readonly store: Stage1StoreService, private readonly settings: SettingsService, private readonly logs: BackendLogsService, private readonly integrations?: DeferredIntegrationsService) {}

  async receive(message: InboundMessage): Promise<DialogueResult> {
    const { conversation, application: initialApplication } = await this.store.getOrCreateConversation({ externalContactId: message.externalContactId, externalConversationId: message.externalConversationId, channel: message.channel });
    const inbound = await this.store.addMessage(conversation, { author: "client", body: message.text?.trim() ?? "", attachmentIds: [], attachments: [], metadata: { externalMessageId: message.externalMessageId, channel: message.channel } });
    const currency = await resolveForeignCurrencyFacts(message.text, initialApplication.facts, this.integrations);
    const turn = await this.agent.run({ messages: [...conversation.messages, inbound], facts: { ...initialApplication.facts, ...currency.facts }, settings: await this.settings.getValues(), text: message.text, attachments: message.attachments, currencyConversions: currency.conversions });
    let application = initialApplication;
    let changedFactKeys: string[] = [];
    let managerEvent: "initial" | "delta" | null = null;
    if (turn.result) {
      const leadCardPatch: Partial<ApplicationFacts> = {
        ...turn.result.leadCardPatch,
        ...currency.facts,
        ...(turn.result.language === "unknown" ? {} : { language: turn.result.language })
      };
      changedFactKeys = await this.store.updateFacts(application, leadCardPatch);
      await this.store.saveAgentState(application, {
        ...turn.result.dialogueState,
        cardSummary: turn.result.cardSummary,
        intent: turn.result.intent,
        preliminaryLimit: selectedProgramLimit({ ...application.facts, ...leadCardPatch }, await this.settings.getValues())
      });
      application = (await this.store.getApplication(application.id)) ?? application;
      for (const attachment of message.attachments) {
        const recognized = turn.result.attachments.find((item) => item.attachmentId === attachment.id);
        await this.store.addAttachment({ conversationId: conversation.id, messageId: inbound.id, type: recognized?.type ?? "unknown", status: recognized?.status ?? "received", fileName: attachment.fileName, mimeType: attachment.mimeType, byteSize: typeof attachment.metadata?.byteSize === "number" ? attachment.metadata.byteSize : undefined, storageKey: typeof attachment.metadata?.storageKey === "string" ? attachment.metadata.storageKey : undefined });
      }
      const initial = turn.result.managerUpdate.kind === "initial" && turn.result.targetEvent && !application.facts.handedToManager;
      const delta = turn.result.managerUpdate.kind === "delta" && application.facts.handedToManager && changedFactKeys.some((key) => managerDeltaFactKeys.has(key));
      if (initial) {
        if (await this.store.createManagerNotification(application, "initial", { event: turn.result.targetEvent, summary: turn.result.cardSummary, facts: application.facts })) managerEvent = "initial";
        await this.store.updateFacts(application, { handedToManager: true });
      } else if (delta) {
        const fields = changedFactKeys.filter((key) => managerDeltaFactKeys.has(key));
        if (await this.store.createManagerNotification(application, "delta", { summary: turn.result.cardSummary, changedFactKeys: fields, facts: Object.fromEntries(fields.map((key) => [key, (application.facts as Record<string, unknown>)[key]])) })) managerEvent = "delta";
      }
    }
    const validation = { passed: Boolean(turn.result), errors: turn.error ? [turn.error] : [] };
    const reply = [currency.clientText, turn.reply].filter((item): item is string => Boolean(item)).join("\n\n");
    await this.store.addMessage(conversation, { author: "ai", body: reply, attachmentIds: [], attachments: [], metadata: { sourceMessageId: inbound.id, routerAiModel: turn.model, promptVersion: turn.promptVersion, validation, trace: { singleModel: true, changedFactKeys, managerEvent, intent: turn.result?.intent, targetEvent: turn.result?.targetEvent } } });
    const refreshedConversation = (await this.store.getConversation(conversation.id)) ?? conversation;
    const refreshedApplication = (await this.store.getApplication(application.id)) ?? refreshedConversation.application ?? application;
    void this.logs.log("dialogue.single-agent", "Processed dialogue turn", { conversationId: conversation.id, metadata: { applicationId: refreshedApplication.id, validModelResult: Boolean(turn.result), model: turn.model } });
    return { conversation: refreshedConversation, application: refreshedApplication, reply, validation, routerAiModel: turn.model, promptVersion: turn.promptVersion };
  }
}

// Public compatibility symbols kept while the old orchestration path is removed.
export function buildDialogueContext(): never { throw new Error("Dialogue context is owned by AgentTurnService."); }
export function alignExtractionToPendingFacts<T>(value: T): T { return value; }
export function selectClientQuestions(): [] { return []; }
export function detectRecoveryHint(): undefined { return undefined; }
export const MAX_DIALOGUE_RECENT_MESSAGES = Number.MAX_SAFE_INTEGER;
export const MAX_DIALOGUE_MESSAGE_LENGTH = Number.MAX_SAFE_INTEGER;
export const MAX_DIALOGUE_SUMMARY_LENGTH = Number.MAX_SAFE_INTEGER;
export function validateRouteProposal(): { kind: "none" } { return { kind: "none" }; }
export function discardUnknownCurrencyMoneyFacts(): void {}
export function getWritableMoneyMentionKeys(): [] { return []; }
export async function resolveForeignCurrencyFacts(text: string | undefined, currentFacts: ApplicationFacts, integrations?: DeferredIntegrationsService): Promise<{ facts: Partial<ApplicationFacts>; conversions: { role: "requestedAmount" | "vehicleValue"; amount: number; currency: ForeignMoneyCurrencyCode; somValue: number; effectiveDate: string }[]; clientText?: string }> {
  if (!text || !integrations) return { facts: {}, conversions: [] };
  const money = resolveMoneyFacts({ text, currentFacts });
  const mentionFor = (role: "requestedAmount" | "vehicleValue") => money.mentions.find((item) => item.roleCandidate === role);
  const requestedMention = mentionFor("requestedAmount");
  const vehicleMention = mentionFor("vehicleValue");
  const detectedCurrencies = [money.requestedAmountCurrency, money.vehicleValueCurrency, ...money.mentions.map((item) => item.currency)].filter(isForeignCurrency);
  const sharedCurrency = new Set(detectedCurrencies).size === 1 ? detectedCurrencies[0] : undefined;
  const candidates: Array<{ role: "requestedAmount" | "vehicleValue"; amount?: number; currency?: string }> = [
    { role: "requestedAmount", amount: money.requestedAmount ?? requestedMention?.normalizedAmount, currency: money.requestedAmountCurrency ?? requestedMention?.currency ?? sharedCurrency },
    { role: "vehicleValue", amount: money.vehicleValue ?? vehicleMention?.normalizedAmount, currency: money.vehicleValueCurrency ?? vehicleMention?.currency ?? sharedCurrency }
  ];
  const facts: Partial<ApplicationFacts> = {};
  const conversions: { role: "requestedAmount" | "vehicleValue"; amount: number; currency: ForeignMoneyCurrencyCode; somValue: number; effectiveDate: string }[] = [];
  for (const candidate of candidates) {
    if (!candidate.amount || !candidate.currency || candidate.currency === "KGS" || !isForeignCurrency(candidate.currency)) continue;
    const conversion = await integrations.convertToSom({ amount: candidate.amount, currency: candidate.currency });
    if (!conversion.available) continue;
    facts[candidate.role] = conversion.value;
    facts[candidate.role === "requestedAmount" ? "requestedAmountSourceCurrency" : "vehicleValueSourceCurrency"] = candidate.currency;
    conversions.push({ role: candidate.role, amount: candidate.amount, currency: candidate.currency, somValue: conversion.value, effectiveDate: conversion.effectiveDate });
  }
  const clientText = conversions.length
    ? `По официальному курсу НБКР: ${conversions.map((item) => `${formatForeignMoney(item.amount, item.currency)} — ориентировочно ${formatMoney(item.somValue)} сом`).join("; ")}.`
    : undefined;
  return { facts, conversions, clientText };
}

function isForeignCurrency(value: string | null | undefined): value is ForeignMoneyCurrencyCode {
  return value === "USD" || value === "EUR" || value === "KZT" || value === "RUB";
}

function formatForeignMoney(amount: number, currency: ForeignMoneyCurrencyCode): string {
  const label = { USD: "долларов США", EUR: "евро", KZT: "тенге", RUB: "российских рублей" }[currency];
  return `${formatMoney(amount)} ${label}`;
}

function selectedProgramLimit(facts: ApplicationFacts, settings: object): number | null {
  if (!facts.requestedProgram || !facts.residenceRegion) return null;
  const limits = calculateLoanLimits(facts, { ...defaultBusinessRuleSettings, ...(settings as Partial<BusinessRuleSettings>) });
  return facts.requestedProgram === "without_storage" ? limits.withoutStorage ?? null : limits.parking ?? null;
}
