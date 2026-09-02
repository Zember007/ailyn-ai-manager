import { Injectable } from "@nestjs/common";
import { calculateLoanLimits, defaultBusinessRuleSettings, type ApplicationFacts, type BusinessRuleSettings } from "@ailyn/business-rules";
import { AgentTurnService } from "./agent-turn.service.js";
import type { InboundMessage } from "../channels/channel.interface.js";
import { SettingsService } from "../settings/settings.service.js";
import { BackendLogsService } from "../logs/backend-logs.service.js";
import { Stage1StoreService, type Stage1Application, type Stage1Conversation } from "./stage1-store.service.js";

export interface DialogueResult { conversation: Stage1Conversation; application: Stage1Application; reply: string; validation: { passed: boolean; errors: string[] }; routerAiModel: string; promptVersion: string; }
const managerDeltaFactKeys = new Set(["requestedAmount", "requestedProgram", "visitDate", "visitTime", "vehicleValue", "vehicleMake", "vehicleModel", "vehicleYear", "fullName", "phone"]);

@Injectable()
export class DialogueOrchestratorService {
  constructor(private readonly agent: AgentTurnService, private readonly store: Stage1StoreService, private readonly settings: SettingsService, private readonly logs: BackendLogsService) {}

  async receive(message: InboundMessage): Promise<DialogueResult> {
    const { conversation, application: initialApplication } = await this.store.getOrCreateConversation({ externalContactId: message.externalContactId, externalConversationId: message.externalConversationId, channel: message.channel });
    const inbound = await this.store.addMessage(conversation, { author: "client", body: message.text?.trim() ?? "", attachmentIds: [], attachments: [], metadata: { externalMessageId: message.externalMessageId, channel: message.channel } });
    const turn = await this.agent.run({ messages: [...conversation.messages, inbound], facts: initialApplication.facts, settings: await this.settings.getValues(), text: message.text, attachments: message.attachments });
    let application = initialApplication;
    let changedFactKeys: string[] = [];
    let managerEvent: "initial" | "delta" | null = null;
    if (turn.result) {
      const leadCardPatch: Partial<ApplicationFacts> = {
        ...turn.result.leadCardPatch,
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
    await this.store.addMessage(conversation, { author: "ai", body: turn.reply, attachmentIds: [], attachments: [], metadata: { sourceMessageId: inbound.id, routerAiModel: turn.model, promptVersion: turn.promptVersion, validation, trace: { singleModel: true, changedFactKeys, managerEvent, intent: turn.result?.intent, targetEvent: turn.result?.targetEvent } } });
    const refreshedConversation = (await this.store.getConversation(conversation.id)) ?? conversation;
    const refreshedApplication = (await this.store.getApplication(application.id)) ?? refreshedConversation.application ?? application;
    void this.logs.log("dialogue.single-agent", "Processed dialogue turn", { conversationId: conversation.id, metadata: { applicationId: refreshedApplication.id, validModelResult: Boolean(turn.result), model: turn.model } });
    return { conversation: refreshedConversation, application: refreshedApplication, reply: turn.reply, validation, routerAiModel: turn.model, promptVersion: turn.promptVersion };
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
export async function resolveForeignCurrencyFacts(): Promise<{ facts: Partial<ApplicationFacts>; traces: []; blockedRoles: [] }> { return { facts: {}, traces: [], blockedRoles: [] }; }

function selectedProgramLimit(facts: ApplicationFacts, settings: object): number | null {
  if (!facts.requestedProgram || !facts.residenceRegion) return null;
  const limits = calculateLoanLimits(facts, { ...defaultBusinessRuleSettings, ...(settings as Partial<BusinessRuleSettings>) });
  return facts.requestedProgram === "without_storage" ? limits.withoutStorage ?? null : limits.parking ?? null;
}
