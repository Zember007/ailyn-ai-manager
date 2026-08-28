import { AdminShell, Field, JsonPreview, LeadCard, MessageList, Notice, Panel } from "../../components";
import { getSearchParamValue, readQuery, toFeedbackMessage, type Stage1Attachment, type Stage1Conversation } from "../../lib/api";
import { ConversationComposer } from "./conversation-composer";

export default async function ConversationDetailPage({
  params,
  searchParams
}: Readonly<{
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const resolvedParams = await params;
  const conversationResult = await readQuery<Stage1Conversation | { error: string }>(`/conversations/${resolvedParams.id}`, { error: "not_found" });
  const attachmentsResult = await readQuery<Stage1Attachment[]>("/attachments", []);
  const conversation = conversationResult.data;
  const attachments = attachmentsResult.data;
  const query = (await searchParams) ?? {};
  const feedback = toFeedbackMessage(
    getSearchParamValue(query.notice) ?? getSearchParamValue(query.error) ?? conversationResult.error ?? attachmentsResult.error
  );
  if ("error" in conversation) {
    return (
      <AdminShell title="Диалог не найден">
        <Panel title="Нет данных">
          <p className="muted">Такой диалог не найден.</p>
        </Panel>
      </AdminShell>
    );
  }
  const application = conversation.application;
  const conversationAttachments = attachments.filter((attachment) => attachment.conversationId === conversation.id);
  const latestAi = [...conversation.messages].reverse().find((message) => message.author === "ai");

  return (
    <AdminShell fullWidth title="Диалог" eyebrow={conversation.externalContactId || conversation.id}>
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
          <MessageList messages={conversation.messages} />
          <ConversationComposer conversationId={conversation.id} />
        </section>
        <aside className="conversationSidebar">
          <Panel title="Карточка лида">
            <LeadCard application={application} attachments={conversationAttachments} />
          </Panel>
          <Panel title="Трассировка AI">
            <Field label="Модель RouterAI" value={latestAi?.metadata?.routerAiModel} />
            <Field label="Версия prompt" value={latestAi?.metadata?.promptVersion} />
            <Field label="Валидация" value={latestAi?.metadata?.validation} />
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
    </AdminShell>
  );
}
