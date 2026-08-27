import type { ApiHealthResponse } from "@ailyn/shared";

const apiBaseUrl = process.env.API_INTERNAL_URL ?? "http://localhost:3001/api";

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, { cache: "no-store" });
    if (!response.ok) return fallback;
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

export default async function AdminPage() {
  const [health, conversations, applications, messages, facts, attachments, settings, knowledge, audit, scenarios, runs] =
    await Promise.all([
      readJson<ApiHealthResponse | null>("/health", null),
      readJson<any[]>("/conversations", []),
      readJson<any[]>("/applications", []),
      readJson<any[]>("/messages", []),
      readJson<any[]>("/facts", []),
      readJson<any[]>("/attachments", []),
      readJson<Record<string, unknown>>("/settings", {}),
      readJson<any[]>("/knowledge", []),
      readJson<any[]>("/audit", []),
      readJson<any[]>("/scenarios", []),
      readJson<any[]>("/scenarios/runs", [])
    ]);
  const activeApplication = applications[0];
  const latestRun = runs[0];
  const latestAiMessage = [...messages].reverse().find((message) => message.author === "ai");

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Ailyn Stage 1</p>
          <h1>Admin console</h1>
        </div>
        <span className={`status ${health?.status ?? "error"}`}>{health?.status ?? "offline"}</span>
      </header>

      <nav className="tabs">
        {["dashboard", "conversations", "scenarios", "settings", "knowledge", "audit"].map((item) => (
          <a key={item} href={`/${item === "dashboard" ? "" : item}`}>{item}</a>
        ))}
      </nav>

      <section className="workspace">
        <section className="conversationPane">
          <div className="toolbar">
            <h2>Test conversation</h2>
            <form action={`${apiBaseUrl}/messages/test-chat`} method="post">
              <input type="hidden" name="conversationId" value="stage1-web-conversation" />
              <button type="submit">New</button>
            </form>
          </div>
          <div className="messages">
            {messages.length === 0 ? <p className="muted">No messages yet</p> : null}
            {messages.map((message) => (
              <article className={`message ${message.author}`} key={message.id}>
                <p>{message.body || "[attachment]"}</p>
                <time>{new Date(message.createdAt).toLocaleString("ru-RU")}</time>
              </article>
            ))}
          </div>
          <form className="composer" action={`${apiBaseUrl}/messages/test-chat`} method="post">
            <input name="conversationId" defaultValue="stage1-web-conversation" />
            <textarea name="message" placeholder="Напишите сообщение клиента" />
            <input name="attachments[0][kindHint]" placeholder="attachment hint: id-front, car, poor" />
            <button type="submit">Send</button>
          </form>
        </section>

        <aside className="leadPane">
          <Panel title="Lead card">
            <LeadCard application={activeApplication} attachments={attachments} />
          </Panel>
          <Panel title="Debug">
            <KeyValues
              value={{
                extractedFacts: facts.length,
                ruleCodes: activeApplication?.decision?.rulesApplied ?? [],
                selectedKnowledge: knowledge.map((item) => item.key),
                routerAiModel: latestAiMessage?.metadata?.routerAiModel ?? "n/a",
                promptVersion: latestAiMessage?.metadata?.promptVersion ?? "n/a",
                decision: activeApplication?.decision ?? null,
                validation: latestAiMessage?.metadata?.validation ?? null
              }}
            />
          </Panel>
        </aside>
      </section>

      <section className="grid">
        <Panel title="Scenario runner">
          <form className="row" action={`${apiBaseUrl}/scenarios/run`} method="post">
            <button type="submit">Run all Stage 1</button>
          </form>
          <KeyValues
            value={{
              scenarios: scenarios.length,
              latestRun: latestRun?.id ?? "none",
              status: latestRun?.status ?? "not_run",
              summary: latestRun?.summary ?? null
            }}
          />
        </Panel>

        <Panel title="Settings">
          <KeyValues value={settings} />
        </Panel>

        <Panel title="Knowledge">
          <JsonPreview value={knowledge} />
        </Panel>

        <Panel title="Audit">
          <JsonPreview value={audit.slice(0, 20)} />
        </Panel>

        <Panel title="Health">
          <KeyValues value={health ?? { status: "offline" }} />
        </Panel>

        <Panel title="Conversations">
          <JsonPreview value={conversations} />
        </Panel>
      </section>
    </main>
  );
}

function LeadCard({ application, attachments }: Readonly<{ application: any; attachments: any[] }>) {
  const facts = application?.facts ?? {};
  return (
    <dl className="lead">
      <Field label="Application ID" value={application?.id} />
      <Field label="Stage" value={application?.stage} />
      <Field label="Status" value={application?.status} />
      <Field label="Name" value={facts.fullName} />
      <Field label="Phone" value={facts.phone} />
      <Field label="Residence" value={facts.residenceRegion} />
      <Field label="Vehicle" value={[facts.vehicleMake, facts.vehicleModel].filter(Boolean).join(" ")} />
      <Field label="Year" value={facts.vehicleYear} />
      <Field label="Value" value={facts.vehicleValue} />
      <Field label="Requested amount" value={facts.requestedAmount} />
      <Field label="Eligible programs" value={application?.decision?.eligiblePrograms?.join(", ")} />
      <Field label="Calculated limits" value={JSON.stringify(application?.decision?.calculatedLimits ?? {})} />
      <Field label="Family status" value={facts.familyStatus} />
      <Field label="Guarantor" value={String(facts.guarantorAvailable ?? "unknown")} />
      <Field label="Documents" value={attachments.map((attachment) => `${attachment.type}:${attachment.status}`).join(", ")} />
      <Field label="Visit" value={[facts.visitDate, facts.visitTime].filter(Boolean).join(" ")} />
      <Field label="Next action" value={application?.decision?.nextAction} />
    </dl>
  );
}

function Field({ label, value }: Readonly<{ label: string; value: unknown }>) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value === undefined || value === "" ? "unknown" : String(value)}</dd>
    </div>
  );
}

function Panel({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function KeyValues({ value }: Readonly<{ value: object }>) {
  return (
    <dl className="lead">
      {Object.entries(value as Record<string, unknown>).map(([key, item]) => (
        <Field key={key} label={key} value={typeof item === "object" ? JSON.stringify(item) : item} />
      ))}
    </dl>
  );
}

function JsonPreview({ value }: Readonly<{ value: unknown }>) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}
