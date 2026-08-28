import { AdminShell, Field, JsonPreview, LeadCard, MessageList, Notice, Panel } from "../../components";
import { getSearchParamValue, readJson, toFeedbackMessage, type Stage1Conversation } from "../../lib/api";

export default async function ConversationDetailPage({
  params,
  searchParams
}: Readonly<{
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const resolvedParams = await params;
  const conversation = await readJson<Stage1Conversation | { error: string }>(`/conversations/${resolvedParams.id}`, { error: "not_found" });
  const attachments = await readJson<any[]>("/attachments", []);
  const query = (await searchParams) ?? {};
  const feedback = toFeedbackMessage(getSearchParamValue(query.notice) ?? getSearchParamValue(query.error));
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
    <AdminShell title="Диалог" eyebrow={conversation.externalContactId || conversation.id}>
      {feedback ? <Notice tone={feedback.tone}>{feedback.text}</Notice> : null}
      <section className="workspace">
        <section className="conversationPane">
          <div className="toolbar">
            <div>
              <h2>Тестовый веб-диалог</h2>
              <p className="muted">{conversation.id}</p>
            </div>
            <span className="status">{application?.stage ?? "NEW"}</span>
          </div>
          <MessageList messages={conversation.messages} />
          <form className="composer" action="/conversations/send" method="post">
            <input type="hidden" name="conversationId" value={conversation.id} />
            <textarea name="message" placeholder="Сообщение клиента" />
            <input name="kindHint" placeholder="Подсказка вложения: id-front, car, poor" />
            <input name="fileName" placeholder="Имя файла" />
            <button type="submit">Отправить</button>
          </form>
        </section>
        <aside className="leadPane">
          <Panel title="Карточка лида">
            <LeadCard application={application} attachments={conversationAttachments} />
          </Panel>
          <Panel title="Трассировка AI">
            <Field label="Модель RouterAI" value={latestAi?.metadata?.routerAiModel} />
            <Field label="Версия prompt" value={latestAi?.metadata?.promptVersion} />
            <Field label="Валидация" value={latestAi?.metadata?.validation} />
          </Panel>
        </aside>
      </section>
      <section className="grid">
        <Panel title="Факты">
          <JsonPreview value={application?.facts ?? {}} />
        </Panel>
        <Panel title="Решение">
          <JsonPreview value={application?.decision ?? {}} />
        </Panel>
        <Panel title="История фактов">
          <JsonPreview value={application?.factHistory ?? []} />
        </Panel>
        <Panel title="Вложения">
          <JsonPreview value={conversationAttachments} />
        </Panel>
      </section>
    </AdminShell>
  );
}
