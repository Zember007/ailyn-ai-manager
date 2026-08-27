import { AdminShell, Panel } from "../components.js";
import { readJson } from "../lib/api.js";

interface KnowledgeItem {
  id: string;
  key: string;
  category: string;
  aliases: string[];
  answerRu: string;
  status: "approved" | "blocked" | "draft";
  priority: number;
  version: number;
  active: boolean;
}

export default async function KnowledgePage() {
  const items = await readJson<KnowledgeItem[]>("/knowledge", []);

  return (
    <AdminShell title="Knowledge">
      <section className="grid">
        <Panel title="Knowledge Items">
          <div className="table">
            {items.map((item) => (
              <div className="tableRow" key={item.id}>
                <span>{item.key}</span>
                <span>{item.category}</span>
                <span>{item.status}</span>
                <span>v{item.version}</span>
                <span>{item.active ? "active" : "off"}</span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Add Or Update">
          <form className="stack" action="/knowledge/save" method="post">
            <input name="key" placeholder="key" required />
            <input name="category" placeholder="category" required />
            <input name="aliases" placeholder="aliases, comma separated" />
            <textarea name="answerRu" placeholder="Approved answer in Russian" required />
            <input name="priority" type="number" defaultValue={50} />
            <select name="status" defaultValue="draft">
              <option value="draft">draft</option>
              <option value="approved">approved</option>
              <option value="blocked">blocked</option>
            </select>
            <label className="checkboxRow"><input name="active" type="checkbox" defaultChecked /> Active</label>
            <button type="submit">Save knowledge</button>
          </form>
        </Panel>
      </section>
    </AdminShell>
  );
}
