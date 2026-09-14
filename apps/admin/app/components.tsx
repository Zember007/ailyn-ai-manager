import { displayValue, formatDate, type Stage1Application, type Stage1Attachment } from "./lib/api";

export function AdminShell({
  title,
  eyebrow,
  children,
  fullWidth = false
}: Readonly<{ title: string; eyebrow?: string; children: React.ReactNode; fullWidth?: boolean }>) {
  return (
    <main className={`shell${fullWidth ? " shellFullWidth" : ""}`}>
      <header className="topbar">
        <div>
          <p className="eyebrow">{eyebrow ?? "Ailyn"}</p>
          <h1>{title}</h1>
        </div>
        <form action="/login/logout" method="post">
          <button className="buttonSecondary" type="submit">Выйти</button>
        </form>
      </header>
      <nav className="tabs">
        <a href="/">Обзор</a>
        <a href="/conversations">Диалоги</a>
        <a href="/logs">Логи</a>
  {/*       <a href="/scenarios">Сценарии</a>
        <a href="/settings">Настройки</a>
        <a href="/knowledge">База знаний</a> */}
        <a href="/audit">Аудит</a>
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
  const normalized = (status ?? "unknown").toLowerCase();
  return <span className={`status ${normalized}`}>{translateStatus(status)}</span>;
}

export function LeadCard({ application, attachments = [] }: Readonly<{ application?: Stage1Application; attachments?: any[] }>) {
  const facts = application?.facts ?? {};
  return (
    <dl className="lead">
      <Field label="ID заявки" value={application?.publicId ?? application?.id} />
      <Field label="ФИО" value={facts.fullName} />
      <Field label="Телефон" value={facts.phone} />
      <Field label="Язык" value={facts.language} />
      <Field label="Прописка" value={facts.residenceRegion} />
      <Field label="Автомобиль" value={[facts.vehicleMake, facts.vehicleModel].filter(Boolean).join(" ")} />
      <Field label="Год" value={facts.vehicleYear} />
      <Field label="Оценочная стоимость" value={facts.vehicleValue} />
      <Field label="Нужная сумма" value={facts.requestedAmount} />
      <Field label="Текущая программа" value={translateProgram(facts.requestedProgram)} />
      <Field label="Предварительный лимит" value={application?.agentState?.preliminaryLimit} />
      <Field label="Семейное положение" value={facts.familyStatus} />
      <Field label="Поручитель" value={translateBoolean(facts.guarantorAvailable)} />
      <Field label="Документы" value={formatReceivedDocuments(attachments)} />
      <Field label="Визит" value={[facts.visitDate, facts.visitTime].filter(Boolean).join(" ")} />
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

export function MessageList({
  messages,
  pendingMessage
}: Readonly<{
  messages: { id: string; author: string; body: string; createdAt: string; attachmentIds?: string[]; attachments?: Stage1Attachment[]; metadata?: Record<string, unknown> }[];
  pendingMessage?: string;
}>) {
  
  return (
    <div className="messages">
      {messages.length === 0 ? <p className="muted">Сообщений пока нет.</p> : null}
      {messages.map((message) => (
        <article className={`message ${message.author}${message.metadata?.optimistic ? " pending" : ""}`} key={message.id}>
          <p className="messageAuthor">{translateAuthor(message.author)}</p>
          <p>{message.body || "[вложение]"}</p>
          {message.attachments?.length ? (
            <div className="attachmentPills">
              {message.attachments.map((attachment) => (
                <span className="attachmentPill" key={attachment.id}>
                  <strong>{translateAttachmentType(attachment.type)}</strong>
                  <span>{attachment.fileName || "Файл"}</span>
                </span>
              ))}
            </div>
          ) : message.attachmentIds?.length ? <p className="muted">Вложений: {message.attachmentIds.length}</p> : null}
          <time>{formatDate(message.createdAt)}</time>
        </article>
      ))}
      {pendingMessage ? (
        <article className="message ai pending">
          <p className="messageAuthor">Айлин</p>
          <div className="thinkingRow">
            <span>{pendingMessage}</span>
            <span className="thinkingDots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </div>
        </article>
      ) : null}
    </div>
  );
}

export function JsonPreview({ value }: Readonly<{ value: unknown }>) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

export function Notice({ tone, children }: Readonly<{ tone: "success" | "error" | "warning"; children: React.ReactNode }>) {
  return <div className={`notice ${tone}`}>{children}</div>;
}

export function ScenarioEvaluationBadge({ mode }: Readonly<{ mode?: "deterministic" | "contract" | "blocked" }>) {
  const normalized = mode ?? "contract";
  return <span className={`modeBadge ${normalized}`}>{translateScenarioMode(normalized)}</span>;
}

function translateStatus(status?: string): string {
  const value = status ?? "unknown";
  const map: Record<string, string> = {
    ok: "ОК",
    offline: "Недоступно",
    degraded: "Есть проблемы",
    error: "Ошибка",
    pass: "PASS",
    fail: "FAIL",
    blocked: "BLOCKED",
    unknown: "Неизвестно",
    unconfigured: "Не настроено",
    open: "Открыт",
    new: "Новая",
    need_more_data: "Нужно больше данных",
    refuse: "Отказ",
    redirect_existing_contract: "Перенаправить по действующему договору",
    target_reached_documents: "Цель достигнута: документы",
    target_reached_visit: "Цель достигнута: визит",
    pause: "Пауза",
    received: "Получено",
    poor_quality: "Плохое качество"
  };
  return map[value.toLowerCase()] ?? value;
}

function translateProgram(program?: unknown): string {
  if (typeof program !== "string") return "Не указана";
  return ({
    without_storage: "Без изъятия",
    parking: "Стоянка"
  }[program] ?? program);
}

function translateBoolean(value: unknown): string {
  if (value === true) return "Да";
  if (value === false) return "Нет";
  return "Не указано";
}

function translateAttachmentType(value: unknown): string {
  if (typeof value !== "string") return displayValue(value);
  const map: Record<string, string> = {
    id_front: "ID лицевая сторона",
    id_back: "ID обратная сторона",
    vehicle_registration_front: "СТС лицевая сторона",
    vehicle_registration_back: "СТС обратная сторона",
    car: "Фото автомобиля",
    unknown: "Неизвестное вложение",
    poor_quality: "Нечитаемое изображение"
  };
  return map[value] ?? value;
}

function formatReceivedDocuments(attachments: { type?: unknown; status?: unknown }[]): string {
  const receivedTypes = new Set(
    attachments
      .filter((attachment) => attachment.status === "received")
      .map((attachment) => attachment.type)
  );
  const documents: string[] = [];

  if (receivedTypes.has("id_front") || receivedTypes.has("id_back")) {
    documents.push("Получено ID");
  }
  if (receivedTypes.has("vehicle_registration_front") || receivedTypes.has("vehicle_registration_back")) {
    documents.push("Получен СТС");
  }

  return documents.join(", ");
}

function translateAuthor(author: string): string {
  const map: Record<string, string> = {
    client: "Клиент",
    ai: "Айлин",
    manager: "Менеджер",
    system: "Система"
  };
  return map[author] ?? author;
}

function translateScenarioMode(mode: "deterministic" | "contract" | "blocked"): string {
  const map: Record<typeof mode, string> = {
    deterministic: "Детерминированный",
    contract: "Контрактный",
    blocked: "BLOCKED"
  };
  return map[mode];
}
