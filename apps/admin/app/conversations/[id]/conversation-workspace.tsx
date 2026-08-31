"use client";

import { useEffect, useRef, useState } from "react";
import { Field, JsonPreview, LeadCard, MessageList, Notice, Panel } from "../../components";
import { toFeedbackMessage, type Stage1Attachment, type Stage1Conversation, type Stage1Message, type TestChatSendResponse } from "../../lib/api";
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
  const [optimisticMessage, setOptimisticMessage] = useState<Stage1Message | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const application = conversation.application;
  const displayedMessages = optimisticMessage ? [...conversation.messages, optimisticMessage] : conversation.messages;
  const conversationAttachments = flattenAttachments(displayedMessages);
  const latestAi = [...displayedMessages].reverse().find((message) => message.author === "ai");

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
    setOptimisticMessage(null);
    setConversation({
      ...payload.conversation,
      application: payload.application ?? payload.conversation.application
    });
    setFeedback(toFeedbackMessage("message_sent"));
  }

  function handleError(code: string) {
    setOptimisticMessage(null);
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
            <MessageList messages={displayedMessages} pendingMessage={isPendingReply ? "Айлин думает" : undefined} />
          </div>
          <ConversationComposer
            conversationId={conversation.id}
            onError={handleError}
            onSubmitStart={({ message, files }) => {
              setOptimisticMessage(buildOptimisticMessage(conversation.id, message, files));
            }}
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

function buildOptimisticMessage(conversationId: string, message: string, files: File[]): Stage1Message {
  const createdAt = new Date().toISOString();
  const attachments = files.map((file, index) => ({
    id: `pending-${index}-${file.name}-${file.lastModified}`,
    conversationId,
    type: "unknown",
    status: "pending",
    fileName: file.name,
    mimeType: file.type || undefined,
    byteSize: file.size,
    createdAt
  }));

  return {
    id: `pending-${createdAt}`,
    author: "client",
    body: message,
    attachmentIds: attachments.map((attachment) => attachment.id),
    attachments,
    createdAt,
    metadata: { optimistic: true }
  };
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
