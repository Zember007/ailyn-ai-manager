import { AdminShell, Notice, Panel } from "../components";
import { getSearchParamValue, readQuery, toFeedbackMessage, type SettingsResponse } from "../lib/api";

export default async function SettingsPage({ searchParams }: Readonly<{ searchParams?: Promise<Record<string, string | string[] | undefined>> }>) {
  const result = await readQuery<SettingsResponse>("/settings", { values: {}, fields: [] });
  const settings = result.data;
  const params = (await searchParams) ?? {};
  const feedback = toFeedbackMessage(getSearchParamValue(params.notice) ?? getSearchParamValue(params.error) ?? result.error);
  const editableCount = settings.fields.filter((field) => field.editable).length;
  const blockedCount = settings.fields.filter((field) => field.blocked).length;

  return (
    <AdminShell title="Настройки">
      {feedback ? <Notice tone={feedback.tone}>{feedback.text}</Notice> : null}
      <Panel title="Параметры">
        <div className="stack helperText">
          <p>В этом разделе редактируются только подтвержденные параметры. Неподтвержденные бизнес-значения должны оставаться `BLOCKED`.</p>
          <p className="muted">Редактируемых полей: {editableCount}. BLOCKED-полей: {blockedCount}.</p>
        </div>
        <form className="settingsForm" action="/settings/save" method="post">
          {settings.fields.map((field) => (
            <label className="settingRow" key={field.key}>
              <span>
                <strong>{field.label}</strong>
                <small>{field.blocked ? field.reason : field.editable ? "Поле можно изменить в админке." : "Поле недоступно для редактирования."}</small>
              </span>
              <input type="hidden" name={`__type:${field.key}`} value={field.type === "number" ? "number" : "text"} />
              <input
                name={field.key}
                type={field.type === "number" ? "number" : "text"}
                step={field.key.toLowerCase().includes("percent") ? "0.01" : "1"}
                defaultValue={typeof field.value === "object" ? JSON.stringify(field.value) : String(field.value ?? "")}
                disabled={!field.editable}
              />
            </label>
          ))}
          {settings.fields.length === 0 ? <p className="muted">{result.ok ? "Настройки пока пусты." : "Настройки не загрузились из API."}</p> : null}
          <button type="submit">Сохранить настройки</button>
        </form>
      </Panel>
    </AdminShell>
  );
}
