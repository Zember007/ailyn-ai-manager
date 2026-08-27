import { AdminShell, Panel, StatusBadge } from "../components.js";
import { formatDate, readJson, type Stage1Conversation } from "../lib/api.js";

export default async function ConversationsPage() {
  const conversations = await readJson<Stage1Conversation[]>("/conversations", []);

  return (
    <AdminShell title="Conversations">
      <Panel title="Web Test Chats">
        <div className="toolbar">
          <p className="muted">Create a test conversation and continue it through the real Dialogue Orchestrator path.</p>
          <form action="/conversations/new" method="post">
            <button type="submit">New web test chat</button>
          </form>
        </div>
        <div className="table">
          {conversations.map((conversation) => (
            <a className="tableRow" href={`/conversations/${conversation.id}`} key={conversation.id}>
              <span>{conversation.externalContactId || conversation.contactId}</span>
              <span><StatusBadge status={conversation.application?.status ?? conversation.status} /></span>
              <span>{conversation.application?.stage ?? "NEW"}</span>
              <span>{conversation.messages.length} messages</span>
              <span>{formatDate(conversation.updatedAt)}</span>
            </a>
          ))}
          {conversations.length === 0 ? <p className="muted">No conversations yet.</p> : null}
        </div>
      </Panel>
    </AdminShell>
  );
}
