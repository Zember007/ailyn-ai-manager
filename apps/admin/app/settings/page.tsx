import { AdminShell, Panel } from "../components";
import { readJson, type SettingsResponse } from "../lib/api";

export default async function SettingsPage() {
  const settings = await readJson<SettingsResponse>("/settings", { values: {}, fields: [] });

  return (
    <AdminShell title="Settings">
      <Panel title="Editable Stage 1 Parameters">
        <form className="settingsForm" action="/settings/save" method="post">
          {settings.fields.map((field) => (
            <label className="settingRow" key={field.key}>
              <span>
                <strong>{field.label}</strong>
                {field.reason ? <small>{field.reason}</small> : null}
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
          <button type="submit">Save settings</button>
        </form>
      </Panel>
    </AdminShell>
  );
}
