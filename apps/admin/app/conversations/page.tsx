import { AdminShell, Notice, Panel, StatusBadge } from "../components";
import { formatDate, getSearchParamValue, readJson, toFeedbackMessage, type Stage1Conversation } from "../lib/api";

export default async function ConversationsPage({ searchParams }: Readonly<{ searchParams?: Promise<Record<string, string | string[] | undefined>> }>) {
  const conversations = await readJson<Stage1Conversation[]>("/conversations", []);
  const params = (await searchParams) ?? {};
  const feedback = toFeedbackMessage(getSearchParamValue(params.notice) ?? getSearchParamValue(params.error));

  return (
    <AdminShell title="Диалоги">
      {feedback ? <Notice tone={feedback.tone}>{feedback.text}</Notice> : null}
      <Panel title="Тестовые веб-чаты">
        <div className="toolbar">
          <p className="muted">Создайте тестовый диалог и продолжайте его через реальный `DialogueOrchestratorService`.</p>
          <form action="/conversations/new" method="post">
            <button type="submit">Новый тестовый чат</button>
          </form>
        </div>
        <div className="table">
          {conversations.map((conversation) => (
            <a className="tableRow" href={`/conversations/${conversation.id}`} key={conversation.id}>
              <span>{conversation.externalContactId || conversation.contactId}</span>
              <span><StatusBadge status={conversation.application?.status ?? conversation.status} /></span>
              <span>{conversation.application?.stage ?? "NEW"}</span>
              <span>{conversation.messages.length} сообщений</span>
              <span>{formatDate(conversation.updatedAt)}</span>
            </a>
          ))}
          {conversations.length === 0 ? <p className="muted">Диалогов пока нет.</p> : null}
        </div>
      </Panel>
    </AdminShell>
  );
}
