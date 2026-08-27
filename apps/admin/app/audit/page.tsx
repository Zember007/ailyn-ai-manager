import { AdminShell, JsonPreview, Panel } from "../components.js";
import { formatDate, readJson } from "../lib/api.js";

interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export default async function AuditPage() {
  const audit = await readJson<AuditEntry[]>("/audit", []);

  return (
    <AdminShell title="Audit">
      <Panel title="Recent Events">
        <div className="table compact">
          {audit.map((event) => (
            <details className="resultRow" key={event.id}>
              <summary>
                <span>{event.action}</span>
                <span>{event.entityType}</span>
                <span>{event.entityId ?? ""}</span>
                <span>{formatDate(event.createdAt)}</span>
              </summary>
              <JsonPreview value={event.metadata ?? {}} />
            </details>
          ))}
          {audit.length === 0 ? <p className="muted">No audit events yet.</p> : null}
        </div>
      </Panel>
    </AdminShell>
  );
}
