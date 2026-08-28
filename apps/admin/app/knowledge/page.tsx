import { AdminShell, Notice, Panel, StatusBadge } from "../components";
import { getSearchParamValue, readJson, toFeedbackMessage } from "../lib/api";

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

export default async function KnowledgePage({ searchParams }: Readonly<{ searchParams?: Promise<Record<string, string | string[] | undefined>> }>) {
  const items = await readJson<KnowledgeItem[]>("/knowledge", []);
  const params = (await searchParams) ?? {};
  const feedback = toFeedbackMessage(getSearchParamValue(params.notice) ?? getSearchParamValue(params.error));
  const approvedCount = items.filter((item) => item.status === "approved" && item.active).length;
  const draftCount = items.filter((item) => item.status === "draft").length;
  const blockedCount = items.filter((item) => item.status === "blocked").length;

  return (
    <AdminShell title="База знаний">
      {feedback ? <Notice tone={feedback.tone}>{feedback.text}</Notice> : null}
      <section className="grid">
        <Panel title="Записи базы знаний">
          <div className="stack helperText">
            <p>Здесь хранятся утвержденные ответы и справочные записи. Acceptance-сценарии не являются контентом базы знаний и не должны использоваться как RAG.</p>
            <p className="muted">Активных approved: {approvedCount}. Черновиков: {draftCount}. BLOCKED: {blockedCount}.</p>
          </div>
          <div className="table">
            {items.map((item) => (
              <div className="tableRow" key={item.id}>
                <span>{item.key}</span>
                <span>{item.category}</span>
                <span><StatusBadge status={item.status} /></span>
                <span>v{item.version}</span>
                <span>{item.active ? "Активна" : "Выключена"}</span>
              </div>
            ))}
            {items.length === 0 ? <p className="muted">В базе знаний пока нет записей.</p> : null}
          </div>
        </Panel>
        <Panel title="Добавить или обновить запись">
          <form className="stack" action="/knowledge/save" method="post">
            <input name="key" placeholder="Ключ, например documents_required" required />
            <input name="category" placeholder="Категория, например documents" required />
            <input name="aliases" placeholder="Алиасы через запятую" />
            <textarea name="answerRu" placeholder="Утвержденный ответ на русском" required />
            <input name="priority" type="number" defaultValue={50} />
            <select name="status" defaultValue="draft">
              <option value="draft">Черновик</option>
              <option value="approved">Утверждено</option>
              <option value="blocked">BLOCKED</option>
            </select>
            <label className="checkboxRow"><input name="active" type="checkbox" defaultChecked /> Активна</label>
            <button type="submit">Сохранить запись</button>
          </form>
        </Panel>
      </section>
    </AdminShell>
  );
}
