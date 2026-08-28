import { AdminShell, Field, Notice, Panel, StatusBadge } from "./components";
import { formatDate, getSearchParamValue, readQuery, toFeedbackMessage, type HealthResponse, type ScenarioRun, type Stage1Conversation } from "./lib/api";

export default async function DashboardPage({ searchParams }: Readonly<{ searchParams?: Promise<Record<string, string | string[] | undefined>> }>) {
  const [healthResult, conversationsResult, runsResult] = await Promise.all([
    readQuery<HealthResponse | null>("/health", null),
    readQuery<Stage1Conversation[]>("/conversations", []),
    readQuery<ScenarioRun[]>("/scenarios/runs", [])
  ]);
  const health = healthResult.data;
  const conversations = conversationsResult.data;
/*   const runs = runsResult.data; */
  const params = (await searchParams) ?? {};
  const feedback = toFeedbackMessage(
    getSearchParamValue(params.notice) ??
      getSearchParamValue(params.error) ??
      conversationsResult.error ??
      runsResult.error ??
      healthResult.error
  );
/*   const latestRun = runs[0]; */

  return (
    <AdminShell title="Обзор">
      {feedback ? <Notice tone={feedback.tone}>{feedback.text}</Notice> : null}
      <section className="summaryGrid">
        <Panel title="Система">
          <div className="metricRow"><span>API</span><StatusBadge status={health?.status ?? "offline"} /></div>
          <div className="metricRow"><span>PostgreSQL</span><StatusBadge status={health?.dependencies?.postgres?.status} /></div>
          <div className="metricRow"><span>Redis</span><StatusBadge status={health?.dependencies?.redis?.status} /></div>
          <div className="metricRow"><span>RouterAI</span><StatusBadge status={health?.dependencies?.ai?.status} /></div>
        </Panel>
        <Panel title="Диалоговый контур">
          <Field label="Диалогов" value={conversations.length} />
          <Field label="Последнее обновление" value={conversations[0] ? formatDate(conversations[0].updatedAt) : "Пока нет"} />
          <a className="buttonLink" href="/conversations">Открыть диалоги</a>
        </Panel>
        {/* <Panel title="Приемочные сценарии">
          <Field label="Последний прогон" value={latestRun?.id} />
          <Field label="Статус" value={latestRun?.status ?? "not_run"} />
          <Field label="Сводка" value={latestRun?.summary} />
          <a className="buttonLink" href="/scenarios">Открыть сценарии</a>
        </Panel> */}
      </section>
      <section className="panel">
        <h2>Последние диалоги</h2>
        <div className="table">
          {conversations.slice(0, 8).map((conversation) => (
            <a className="tableRow" href={`/conversations/${conversation.id}`} key={conversation.id}>
              <span>{conversation.externalContactId || conversation.contactId}</span>
              <span>{conversation.application?.stage ?? "NEW"}</span>
              <span>{formatDate(conversation.updatedAt)}</span>
            </a>
          ))}
          {conversations.length === 0 ? <p className="muted">Диалогов пока нет.</p> : null}
        </div>
      </section>
    </AdminShell>
  );
}
