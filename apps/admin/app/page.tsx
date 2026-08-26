import type { ApiHealthResponse } from "@ailyn/shared";

const apiBaseUrl = process.env.API_INTERNAL_URL ?? "http://api:3001/api";

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, { cache: "no-store" });
    if (!response.ok) {
      return fallback;
    }
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

export default async function AdminPage() {
  const [health, conversations, applications, messages, facts] = await Promise.all([
    readJson<ApiHealthResponse | null>("/health", null),
    readJson("/conversations", []),
    readJson("/applications", []),
    readJson("/messages", []),
    readJson("/facts", [])
  ]);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Ailyn Stage 1</p>
          <h1>Admin console</h1>
        </div>
        <span className={`status ${health?.status ?? "error"}`}>{health?.status ?? "offline"}</span>
      </header>

      <section className="grid">
        <Panel title="Health">
          <dl className="health">
            <div>
              <dt>API</dt>
              <dd>{health?.status ?? "unreachable"}</dd>
            </div>
            <div>
              <dt>PostgreSQL</dt>
              <dd>{health?.dependencies.postgres.status ?? "unknown"}</dd>
            </div>
            <div>
              <dt>Redis</dt>
              <dd>{health?.dependencies.redis.status ?? "unknown"}</dd>
            </div>
            <div>
              <dt>AI</dt>
              <dd>{health?.dependencies.ai.status ?? "unknown"}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{health?.version ?? "n/a"}</dd>
            </div>
          </dl>
        </Panel>

        <Panel title="Conversations">
          <JsonPreview value={conversations} />
        </Panel>

        <Panel title="Applications">
          <JsonPreview value={applications} />
        </Panel>

        <Panel title="Client facts">
          <JsonPreview value={facts} />
        </Panel>

        <Panel title="Messages">
          <JsonPreview value={messages} />
        </Panel>

        <Panel title="Test chat">
          <form className="chat" action={`${apiBaseUrl}/messages/test-chat`} method="post">
            <input name="message" placeholder="Type a smoke-test message" />
            <button type="submit">Send</button>
          </form>
        </Panel>
      </section>
    </main>
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

function JsonPreview({ value }: Readonly<{ value: unknown }>) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}
