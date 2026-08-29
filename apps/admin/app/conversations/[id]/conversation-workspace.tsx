"use client";

import { useEffect, useRef, useState } from "react";
import { Field, JsonPreview, LeadCard, MessageList, Notice, Panel } from "../../components";
import { toFeedbackMessage, type Stage1Attachment, type Stage1Conversation, type TestChatSendResponse } from "../../lib/api";
import { ConversationComposer } from "./conversation-composer";

export function ConversationWorkspace({
  initialConversation,
  initialFeedback
}: Readonly<{
  initialConversation: Stage1Conversation;
  initialFeedback?: { tone: "success" | "error" | "warning"; text: string } | null;
}>) {
  const [conversation, setConversation] = useState(initialConversation);
  const [feedback, setFeedback] = useState(initialFeedback ?? null);
  const [isPendingReply, setIsPendingReply] = useState(false);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const application = conversation.application;
  const conversationAttachments = flattenAttachments(conversation.messages);
  const latestAi = [...conversation.messages].reverse().find((message) => message.author === "ai");

  useEffect(() => {
    const container = messageListRef.current?.querySelector(".messages");
    if (!(container instanceof HTMLElement)) {
      return;
    }
    container.scrollTo({
      top: container.scrollHeight,
      behavior: "smooth"
    });
  }, [conversation.messages, isPendingReply]);

  function handleSuccess(payload: TestChatSendResponse) {
    setConversation({
      ...payload.conversation,
      application: payload.application ?? payload.conversation.application
    });
    setFeedback(toFeedbackMessage("message_sent"));
  }

  function handleError(code: string) {
    setFeedback(toFeedbackMessage(code) ?? { tone: "error", text: `Backend вернул ошибку: ${code}` });
  }

  return (
    <>
      {feedback ? <Notice tone={feedback.tone}>{feedback.text}</Notice> : null}
      <section className="conversationWorkspace">
        <section className="conversationStage">
          <div className="conversationHeader">
            <div>
              <h2>Тестовый веб-диалог</h2>
              <p className="muted">{conversation.id}</p>
            </div>
            <div className="conversationMeta">
              <span className="status">{application?.stage ?? "NEW"}</span>
              <span className="muted">External chat: {conversation.externalConversationId || "Не задан"}</span>
            </div>
          </div>
          <div className="messageListFrame" ref={messageListRef}>
            <MessageList messages={conversation.messages} pendingMessage={isPendingReply ? "Айлин думает" : undefined} />
          </div>
          <ConversationComposer
            conversationId={conversation.id}
            onError={handleError}
            onPendingChange={(pending) => {
              setIsPendingReply(pending);
              if (pending) {
                setFeedback(toFeedbackMessage("message_send_in_progress"));
              }
            }}
            onSuccess={handleSuccess}
          />
        </section>
        <aside className="conversationSidebar">
          <Panel title="Карточка лида">
            <LeadCard application={application} attachments={conversationAttachments} />
          </Panel>
          <Panel title="Трассировка AI">
            <Field label="Модель RouterAI" value={latestAi?.metadata?.routerAiModel} />
            <Field label="Версия prompt" value={latestAi?.metadata?.promptVersion} />
            <Field label="Валидация" value={latestAi?.metadata?.validation} />
            <p><a href={`/logs?conversationId=${conversation.id}`}>Открыть backend-логи по этому диалогу</a></p>
          </Panel>
          <Panel title="Вложения">
            <JsonPreview value={conversationAttachments} />
          </Panel>
        </aside>
      </section>
      <section className="conversationDiagnostics">
        <Panel title="Факты">
          <JsonPreview value={application?.facts ?? {}} />
        </Panel>
        <Panel title="Решение">
          <JsonPreview value={application?.decision ?? {}} />
        </Panel>
        <Panel title="История фактов">
          <JsonPreview value={application?.factHistory ?? []} />
        </Panel>
      </section>
    </>
  );
}

function flattenAttachments(messages: Stage1Conversation["messages"]): Stage1Attachment[] {
  const seen = new Set<string>();
  const attachments: Stage1Attachment[] = [];
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (seen.has(attachment.id)) {
        continue;
      }
      seen.add(attachment.id);
      attachments.push(attachment);
    }
  }
  return attachments;
}
