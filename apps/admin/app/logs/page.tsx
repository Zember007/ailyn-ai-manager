import { AdminShell, JsonPreview, Panel } from "../components";
import { formatDate, getSearchParamValue, readJson, type BackendLogEntry } from "../lib/api";

export default async function LogsPage({
  searchParams
}: Readonly<{
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const query = (await searchParams) ?? {};
  const conversationId = getSearchParamValue(query.conversationId);
  const path = conversationId ? `/logs?conversationId=${encodeURIComponent(conversationId)}` : "/logs";
  const logs = await readJson<BackendLogEntry[]>(path, []);

  return (
    <AdminShell title="Логи" eyebrow={conversationId ? `Диалог ${conversationId}` : "Ailyn"}>
      <Panel title="Последние backend-события">
        {conversationId ? <p className="muted">Фильтр по диалогу: {conversationId}</p> : null}
        <div className="table compact">
          {logs.map((entry) => (
            <details className="resultRow" key={entry.id}>
              <summary>
                <span>{entry.level.toUpperCase()}</span>
                <span>{entry.context}</span>
                <span>{entry.message}</span>
                <span>{formatDate(entry.createdAt)}</span>
              </summary>
              <JsonPreview
                value={{
                  requestId: entry.requestId,
                  method: entry.method,
                  path: entry.path,
                  conversationId: entry.conversationId,
                  metadata: entry.metadata ?? {},
                  stack: entry.stack ?? null
                }}
              />
            </details>
          ))}
          {logs.length === 0 ? <p className="muted">Логов пока нет.</p> : null}
        </div>
      </Panel>
    </AdminShell>
  );
}
