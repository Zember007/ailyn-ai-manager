import { AdminShell, Panel, StatusBadge } from "../components.js";
import { formatDate, readJson, type Scenario, type ScenarioRun } from "../lib/api.js";

export default async function ScenariosPage() {
  const [scenarios, runs] = await Promise.all([
    readJson<Scenario[]>("/scenarios", []),
    readJson<ScenarioRun[]>("/scenarios/runs", [])
  ]);
  const categories = [...new Set(scenarios.map((scenario) => scenario.category))].sort();
  const latest = runs[0];

  return (
    <AdminShell title="Scenarios">
      <section className="summaryGrid">
        <Panel title="Runner">
          <form className="stack" action="/scenarios/run" method="post">
            <select name="category" defaultValue="">
              <option value="">All Stage 1</option>
              {categories.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
            <button type="submit">Run scenarios</button>
          </form>
        </Panel>
        <Panel title="Latest Run">
          <StatusBadge status={latest?.status ?? "not_run"} />
          <p className="muted">{latest ? formatDate(latest.createdAt) : "No runs yet."}</p>
          {latest ? <a className="buttonLink" href={`/scenarios/runs/${latest.id}`}>Open latest</a> : null}
        </Panel>
      </section>
      <section className="grid">
        <Panel title="Acceptance Source">
          <div className="table compact">
            {scenarios.map((scenario) => (
              <div className="tableRow" key={scenario.id}>
                <span>{scenario.id}</span>
                <span>{scenario.category}</span>
                <span>{scenario.title}</span>
                <span>{scenario.critical ? "critical" : ""}</span>
                <span>{scenario.blocked ? "BLOCKED" : "ready"}</span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Runs">
          <div className="table">
            {runs.map((run) => (
              <a className="tableRow" href={`/scenarios/runs/${run.id}`} key={run.id}>
                <span>{run.id}</span>
                <span><StatusBadge status={run.status} /></span>
                <span>{run.summary.pass ?? 0} pass</span>
                <span>{run.summary.fail ?? 0} fail</span>
                <span>{run.summary.blocked ?? 0} blocked</span>
                <span>{formatDate(run.createdAt)}</span>
              </a>
            ))}
          </div>
        </Panel>
      </section>
    </AdminShell>
  );
}
