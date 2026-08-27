import { AdminShell, Field, JsonPreview, LeadCard, MessageList, Panel } from "../../components.js";
import { readJson, type Stage1Conversation } from "../../lib/api.js";

export default async function ConversationDetailPage({ params }: Readonly<{ params: { id: string } }>) {
  const conversation = await readJson<Stage1Conversation | { error: string }>(`/conversations/${params.id}`, { error: "not_found" });
  const attachments = await readJson<any[]>("/attachments", []);
  if ("error" in conversation) {
    return (
      <AdminShell title="Conversation Not Found">
        <Panel title="Missing">
          <p className="muted">This conversation was not found.</p>
        </Panel>
      </AdminShell>
    );
  }
  const application = conversation.application;
  const conversationAttachments = attachments.filter((attachment) => attachment.conversationId === conversation.id);
  const latestAi = [...conversation.messages].reverse().find((message) => message.author === "ai");

  return (
    <AdminShell title="Conversation Detail" eyebrow={conversation.externalContactId || conversation.id}>
      <section className="workspace">
        <section className="conversationPane">
          <div className="toolbar">
            <div>
              <h2>Web Test Conversation</h2>
              <p className="muted">{conversation.id}</p>
            </div>
            <span className="status">{application?.stage ?? "NEW"}</span>
          </div>
          <MessageList messages={conversation.messages} />
          <form className="composer" action="/conversations/send" method="post">
            <input type="hidden" name="conversationId" value={conversation.id} />
            <textarea name="message" placeholder="Напишите сообщение клиента" />
            <input name="kindHint" placeholder="attachment hint: id-front, car, poor" />
            <input name="fileName" placeholder="file name" />
            <button type="submit">Send</button>
          </form>
        </section>
        <aside className="leadPane">
          <Panel title="Lead Card">
            <LeadCard application={application} attachments={conversationAttachments} />
          </Panel>
          <Panel title="AI Trace">
            <Field label="RouterAI model" value={latestAi?.metadata?.routerAiModel} />
            <Field label="Prompt version" value={latestAi?.metadata?.promptVersion} />
            <Field label="Validation" value={latestAi?.metadata?.validation} />
          </Panel>
        </aside>
      </section>
      <section className="grid">
        <Panel title="Facts">
          <JsonPreview value={application?.facts ?? {}} />
        </Panel>
        <Panel title="Decision">
          <JsonPreview value={application?.decision ?? {}} />
        </Panel>
        <Panel title="Fact History">
          <JsonPreview value={application?.factHistory ?? []} />
        </Panel>
        <Panel title="Attachments">
          <JsonPreview value={conversationAttachments} />
        </Panel>
      </section>
    </AdminShell>
  );
}
