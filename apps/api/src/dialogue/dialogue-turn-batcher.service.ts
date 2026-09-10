import { Injectable } from "@nestjs/common";
import type { InboundMessage } from "../channels/channel.interface.js";
import { DialogueOrchestratorService, type DialogueResult } from "./dialogue-orchestrator.service.js";

const COALESCE_WINDOW_MS = 650;

type Deferred = { resolve: (result: DialogueResult) => void; reject: (error: unknown) => void };
type PendingTurn = {
  messages: InboundMessage[];
  waiters: Deferred[];
  timer?: ReturnType<typeof setTimeout>;
  active?: { controller: AbortController; messages: InboundMessage[]; waiters: Deferred[] };
};

/**
 * Quick successive messages are delayed together, but never collapsed into
 * one semantic turn. A batch may contain a question, a programme decision,
 * an upload and another question; each must see the facts and history left by
 * the preceding message. A newer message still aborts work that has not yet
 * reached its own turn.
 */
@Injectable()
export class DialogueTurnBatcherService {
  private readonly pending = new Map<string, PendingTurn>();

  constructor(private readonly orchestrator: DialogueOrchestratorService) {}

  enqueue(message: InboundMessage): Promise<DialogueResult> {
    const key = `${message.channel}:${message.externalConversationId ?? message.externalContactId}`;
    return new Promise<DialogueResult>((resolve, reject) => {
      const pending = this.pending.get(key) ?? { messages: [], waiters: [] };
      this.pending.set(key, pending);
      if (pending.active) {
        pending.active.controller.abort();
        // The callers of the superseded request receive the fresh result.
        pending.messages.unshift(...pending.active.messages);
        pending.waiters.push(...pending.active.waiters);
        pending.active = undefined;
      }
      if (pending.timer) clearTimeout(pending.timer);
      pending.messages.push(message);
      pending.waiters.push({ resolve, reject });
      pending.timer = this.schedule(key);
    });
  }

  private schedule(key: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => void this.flush(key), COALESCE_WINDOW_MS);
  }

  private async flush(key: string): Promise<void> {
    const pending = this.pending.get(key);
    if (!pending || pending.active || pending.messages.length === 0) return;
    pending.timer = undefined;
    const messages = pending.messages.splice(0);
    const waiters = pending.waiters.splice(0);
    const controller = new AbortController();
    pending.active = { controller, messages, waiters };
    try {
      const results: DialogueResult[] = [];
      const deferReplyPersistence = messages.length > 1;
      for (let index = 0; index < messages.length; index += 1) {
        // On abort, enqueue() returns only this not-yet-committed suffix to
        // the queue. Earlier messages were already persisted as independent
        // turns and must never be replayed.
        if (pending.active?.controller === controller) pending.active.messages = messages.slice(index);
        throwIfAborted(controller.signal);
        results.push(await this.orchestrator.receiveBatch([messages[index]!], { signal: controller.signal, deferReplyPersistence }));
        throwIfAborted(controller.signal);
      }
      const finalResult = results.at(-1);
      let result = finalResult;
      if (!result) throw new Error("dialogue_batch_empty_result");
      if (deferReplyPersistence) {
        result = await this.orchestrator.publishDeferredBatchReply(
          result,
          combineSequentialReplies(messages, results),
          messages.at(-1)!.externalMessageId
        );
      }
      if (controller.signal.aborted) return;
      this.pending.delete(key);
      waiters.forEach(({ resolve }) => resolve(result));
    } catch (error) {
      if (controller.signal.aborted) return;
      this.pending.delete(key);
      waiters.forEach(({ reject }) => reject(error));
    } finally {
      const current = this.pending.get(key);
      if (current?.active?.controller === controller) current.active = undefined;
    }
  }
}

function combineSequentialReplies(messages: InboundMessage[], results: DialogueResult[]): string {
  const parts = results
    .map((result, index) => ({ result, message: messages[index]!, isLast: index === results.length - 1 }))
    .filter(({ message, isLast }) => isLast || message.attachments.length > 0 || isClientQuestion(message.text))
    .map(({ result, isLast }) => isLast ? result.reply : removeIntermediateWorkflow(result.reply))
    .filter(Boolean);
  return [...new Map(parts.map((part) => [normalizeReply(part), part])).values()].join("\n\n");
}

function removeIntermediateWorkflow(reply: string): string {
  const withoutCanonicalPrompt = reply
    .replace(/\s*\n\n(?:подскажите,?\s+пожалуйста,?|какая\s+сумма\s+займа|вас\s+интересует|пожалуйста,?\s+(?:отправьте|пришлите)|офис\s+работает)[\s\S]*$/iu, "")
    .replace(/\s*Сумма\s+[\d\s]+\s+сом\s+по\s+этой\s+программе\s+не\s+проходит\.[\s\S]*$/iu, "")
    // A factual reply in an early batched message may be followed by the
    // canonical guarantor gate. The next client message can make that gate
    // inactive (for example, «давайте стоянку»), so only the final turn is
    // allowed to contribute a server workflow question to the visible reply.
    .replace(/\s*И\s+Вам\s+потребуется\s+поручитель\s*:[\s\S]*$/iu, "")
    .replace(/\s*Поручитель\s+обязателен[^?!\n]{0,220}(?:можем|можно|давайте)[\s\S]*$/iu, "")
    .trim();
  return withoutCanonicalPrompt;
}

function isClientQuestion(text: string | undefined): boolean {
  const value = text?.trim() ?? "";
  return /[?？]/u.test(value)
    || /^(?:(?:а|и|ну)\s+)?(?:где|как|какой|какая|какие|можно|сколько|когда|почему|зачем|ставк|процент)/iu.test(value)
    || /(?:стоянк|парковк).{0,40}(?:где|адрес)/iu.test(value);
}

function normalizeReply(value: string): string {
  return value.replace(/[?!.]/gu, "").replace(/\s+/gu, " ").trim().toLocaleLowerCase("ru-RU");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Dialogue turn superseded by a newer client message", "AbortError");
}
