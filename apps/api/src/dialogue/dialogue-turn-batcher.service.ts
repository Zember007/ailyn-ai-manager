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
 * One conversation has at most one useful model turn. Quick successive
 * messages are joined into one call. A newer message aborts an obsolete
 * inference, so it cannot race the reply for the latest client context.
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
      const result = await this.orchestrator.receiveBatch(messages, { signal: controller.signal });
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
