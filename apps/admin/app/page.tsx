import { AdminShell, Field, Panel, StatusBadge } from "./components.js";
import { formatDate, readJson, type HealthResponse, type ScenarioRun, type Stage1Conversation } from "./lib/api.js";

export default async function DashboardPage() {
  const [health, conversations, runs] = await Promise.all([
    readJson<HealthResponse | null>("/health", null),
    readJson<Stage1Conversation[]>("/conversations", []),
    readJson<ScenarioRun[]>("/scenarios/runs", [])
  ]);
  const latestRun = runs[0];

  return (
    <AdminShell title="Dashboard">
      <section className="summaryGrid">
        <Panel title="System">
          <div className="metricRow"><span>API</span><StatusBadge status={health?.status ?? "offline"} /></div>
          <div className="metricRow"><span>Postgres</span><StatusBadge status={health?.dependencies?.postgres?.status} /></div>
          <div className="metricRow"><span>Redis</span><StatusBadge status={health?.dependencies?.redis?.status} /></div>
          <div className="metricRow"><span>RouterAI</span><StatusBadge status={health?.dependencies?.ai?.status} /></div>
        </Panel>
        <Panel title="Dialogue Work">
          <Field label="Conversations" value={conversations.length} />
          <Field label="Latest update" value={conversations[0] ? formatDate(conversations[0].updatedAt) : "none"} />
          <a className="buttonLink" href="/conversations">Open conversations</a>
        </Panel>
        <Panel title="Acceptance">
          <Field label="Latest run" value={latestRun?.id} />
          <Field label="Status" value={latestRun?.status ?? "not_run"} />
          <Field label="Summary" value={latestRun?.summary} />
          <a className="buttonLink" href="/scenarios">Open scenarios</a>
        </Panel>
      </section>
      <section className="panel">
        <h2>Recent Conversations</h2>
        <div className="table">
          {conversations.slice(0, 8).map((conversation) => (
            <a className="tableRow" href={`/conversations/${conversation.id}`} key={conversation.id}>
              <span>{conversation.externalContactId || conversation.contactId}</span>
              <span>{conversation.application?.stage ?? "NEW"}</span>
              <span>{formatDate(conversation.updatedAt)}</span>
            </a>
          ))}
          {conversations.length === 0 ? <p className="muted">No conversations yet.</p> : null}
        </div>
      </section>
    </AdminShell>
  );
}
