import { AdminShell, Field, Notice, Panel, StatusBadge } from "../../../components";
import { formatDate, getSearchParamValue, readJson, toFeedbackMessage, type ScenarioRun } from "../../../lib/api";

export default async function ScenarioRunPage({
  params,
  searchParams
}: Readonly<{
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const resolvedParams = await params;
  const run = await readJson<ScenarioRun | { error: string }>(`/scenarios/runs/${resolvedParams.id}`, { error: "not_found" });
  const query = (await searchParams) ?? {};
  const feedback = toFeedbackMessage(getSearchParamValue(query.notice) ?? getSearchParamValue(query.error));
  if ("error" in run) {
    return (
      <AdminShell title="Прогон не найден">
        <Panel title="Нет данных">
          <p className="muted">Такой прогон сценариев не найден.</p>
        </Panel>
      </AdminShell>
    );
  }

  return (
    <AdminShell title="Прогон сценариев" eyebrow={run.id}>
      {feedback ? <Notice tone={feedback.tone}>{feedback.text}</Notice> : null}
      <section className="summaryGrid">
        <Panel title="Сводка">
          <StatusBadge status={run.status} />
          <Field label="Создан" value={formatDate(run.createdAt)} />
          <Field label="Итоги" value={run.summary} />
        </Panel>
      </section>
      <Panel title="Результаты">
        <div className="table compact">
          {run.results.map((result) => (
            <details className="resultRow" key={result.id} open={result.status === "FAIL"}>
              <summary>
                <span>{result.id}</span>
                <StatusBadge status={result.status} />
                <span>{result.expected}</span>
              </summary>
              <p><strong>Режим проверки:</strong> {result.evaluationMode === "placeholder" ? "placeholder assertions" : result.evaluationMode === "blocked" ? "blocked by source" : "детерминированная проверка"}</p>
              <p><strong>Факт:</strong> {result.actual}</p>
              <p><strong>Проверки:</strong> {result.assertions.join(", ")}</p>
              {result.error ? <p className="errorText">{result.error}</p> : null}
            </details>
          ))}
        </div>
      </Panel>
    </AdminShell>
  );
}
