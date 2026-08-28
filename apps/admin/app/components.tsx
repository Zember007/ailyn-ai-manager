import { displayValue, formatDate, type Stage1Application } from "./lib/api";

export function AdminShell({ title, eyebrow, children }: Readonly<{ title: string; eyebrow?: string; children: React.ReactNode }>) {
  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">{eyebrow ?? "Ailyn Stage 1"}</p>
          <h1>{title}</h1>
        </div>
        <form action="/login/logout" method="post">
          <button className="buttonSecondary" type="submit">Logout</button>
        </form>
      </header>
      <nav className="tabs">
        <a href="/">Dashboard</a>
        <a href="/conversations">Conversations</a>
        <a href="/scenarios">Scenarios</a>
        <a href="/settings">Settings</a>
        <a href="/knowledge">Knowledge</a>
        <a href="/audit">Audit</a>
      </nav>
      {children}
    </main>
  );
}

export function Panel({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function StatusBadge({ status }: Readonly<{ status?: string }>) {
  return <span className={`status ${(status ?? "unknown").toLowerCase()}`}>{status ?? "unknown"}</span>;
}

export function LeadCard({ application, attachments = [] }: Readonly<{ application?: Stage1Application; attachments?: any[] }>) {
  const facts = application?.facts ?? {};
  return (
    <dl className="lead">
      <Field label="Application ID" value={application?.id} />
      <Field label="Stage" value={application?.stage} />
      <Field label="Status" value={application?.status} />
      <Field label="Name" value={facts.fullName} />
      <Field label="Phone" value={facts.phone} />
      <Field label="Language" value={facts.language} />
      <Field label="Residence" value={facts.residenceRegion} />
      <Field label="Vehicle" value={[facts.vehicleMake, facts.vehicleModel].filter(Boolean).join(" ")} />
      <Field label="Year" value={facts.vehicleYear} />
      <Field label="Value" value={facts.vehicleValue} />
      <Field label="Requested amount" value={facts.requestedAmount} />
      <Field label="Eligible programs" value={(application?.decision?.eligiblePrograms as string[] | undefined)?.join(", ")} />
      <Field label="Calculated limits" value={application?.decision?.calculatedLimits} />
      <Field label="Family status" value={facts.familyStatus} />
      <Field label="Guarantor" value={facts.guarantorAvailable} />
      <Field label="Documents" value={attachments.map((attachment) => `${attachment.type}:${attachment.status}`).join(", ")} />
      <Field label="Visit" value={[facts.visitDate, facts.visitTime].filter(Boolean).join(" ")} />
      <Field label="Next action" value={application?.decision?.nextAction} />
    </dl>
  );
}

export function Field({ label, value }: Readonly<{ label: string; value: unknown }>) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{displayValue(value)}</dd>
    </div>
  );
}

export function MessageList({ messages }: Readonly<{ messages: { id: string; author: string; body: string; createdAt: string; attachmentIds?: string[] }[] }>) {
  return (
    <div className="messages">
      {messages.length === 0 ? <p className="muted">No messages yet</p> : null}
      {messages.map((message) => (
        <article className={`message ${message.author}`} key={message.id}>
          <p>{message.body || "[attachment]"}</p>
          {message.attachmentIds?.length ? <p className="muted">{message.attachmentIds.length} attachment(s)</p> : null}
          <time>{formatDate(message.createdAt)}</time>
        </article>
      ))}
    </div>
  );
}

export function JsonPreview({ value }: Readonly<{ value: unknown }>) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}
