import { AdminShell, Field, Panel, StatusBadge } from "../../../components.js";
import { formatDate, readJson, type ScenarioRun } from "../../../lib/api.js";

export default async function ScenarioRunPage({ params }: Readonly<{ params: { id: string } }>) {
  const run = await readJson<ScenarioRun | { error: string }>(`/scenarios/runs/${params.id}`, { error: "not_found" });
  if ("error" in run) {
    return (
      <AdminShell title="Scenario Run Not Found">
        <Panel title="Missing">
          <p className="muted">This scenario run was not found.</p>
        </Panel>
      </AdminShell>
    );
  }

  return (
    <AdminShell title="Scenario Run" eyebrow={run.id}>
      <section className="summaryGrid">
        <Panel title="Summary">
          <StatusBadge status={run.status} />
          <Field label="Created" value={formatDate(run.createdAt)} />
          <Field label="Totals" value={run.summary} />
        </Panel>
      </section>
      <Panel title="Results">
        <div className="table compact">
          {run.results.map((result) => (
            <details className="resultRow" key={result.id} open={result.status === "FAIL"}>
              <summary>
                <span>{result.id}</span>
                <StatusBadge status={result.status} />
                <span>{result.expected}</span>
              </summary>
              <p><strong>Actual:</strong> {result.actual}</p>
              <p><strong>Assertions:</strong> {result.assertions.join(", ")}</p>
              {result.error ? <p className="errorText">{result.error}</p> : null}
            </details>
          ))}
        </div>
      </Panel>
    </AdminShell>
  );
}
