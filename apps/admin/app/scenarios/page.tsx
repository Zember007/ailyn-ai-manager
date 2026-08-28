import { AdminShell, Notice, Panel, StatusBadge } from "../components";
import { formatDate, getSearchParamValue, readJson, toFeedbackMessage, type Scenario, type ScenarioRun } from "../lib/api";

export default async function ScenariosPage({ searchParams }: Readonly<{ searchParams?: Promise<Record<string, string | string[] | undefined>> }>) {
  const [scenarios, runs] = await Promise.all([
    readJson<Scenario[]>("/scenarios", []),
    readJson<ScenarioRun[]>("/scenarios/runs", [])
  ]);
  const params = (await searchParams) ?? {};
  const externalFeedback = toFeedbackMessage(getSearchParamValue(params.notice) ?? getSearchParamValue(params.error));
  const categories = [...new Set(scenarios.map((scenario) => scenario.category))].sort();
  const latest = runs[0];
  const hasPlaceholderResults = runs.some((run) => run.results.some((result) => result.evaluationMode === "placeholder"));
  const placeholderFeedback = hasPlaceholderResults ? toFeedbackMessage("scenario_placeholder") : null;

  return (
    <AdminShell title="Сценарии">
      {externalFeedback ? <Notice tone={externalFeedback.tone}>{externalFeedback.text}</Notice> : null}
      {placeholderFeedback ? <Notice tone={placeholderFeedback.tone}>{placeholderFeedback.text}</Notice> : null}
      <section className="summaryGrid">
        <Panel title="Запуск сценариев">
          <form className="stack" action="/scenarios/run" method="post">
            <select name="category" defaultValue="">
              <option value="">Все сценарии</option>
              {categories.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
            <button type="submit">Запустить сценарии</button>
          </form>
        </Panel>
        <Panel title="Последний прогон">
          <StatusBadge status={latest?.status ?? "not_run"} />
          <p className="muted">{latest ? formatDate(latest.createdAt) : "Прогонов пока не было."}</p>
          {latest ? <a className="buttonLink" href={`/scenarios/runs/${latest.id}`}>Открыть прогон</a> : null}
        </Panel>
      </section>
      <section className="grid">
        <Panel title="Источник приемки">
          <div className="table compact">
            {scenarios.map((scenario) => (
              <div className="tableRow" key={scenario.id}>
                <span>{scenario.id}</span>
                <span>{scenario.category}</span>
                <span>{scenario.title}</span>
                <span>{scenario.critical ? "critical" : ""}</span>
                <span>{scenario.blocked ? "BLOCKED" : "Готов"}</span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="История прогонов">
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
            {runs.length === 0 ? <p className="muted">История прогонов пуста.</p> : null}
          </div>
        </Panel>
      </section>
    </AdminShell>
  );
}
