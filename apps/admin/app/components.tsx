import { displayValue, formatDate, type Stage1Application } from "./lib/api";

export function AdminShell({ title, eyebrow, children }: Readonly<{ title: string; eyebrow?: string; children: React.ReactNode }>) {
  return (
    <main className="shell">
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
        <a href="/scenarios">Сценарии</a>
        <a href="/settings">Настройки</a>
        <a href="/knowledge">База знаний</a>
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
      <Field label="ID заявки" value={application?.id} />
      <Field label="Этап" value={translateStage(application?.stage)} />
      <Field label="Статус" value={translateStatus(application?.status)} />
      <Field label="ФИО" value={facts.fullName} />
      <Field label="Телефон" value={facts.phone} />
      <Field label="Язык" value={facts.language} />
      <Field label="Прописка" value={facts.residenceRegion} />
      <Field label="Автомобиль" value={[facts.vehicleMake, facts.vehicleModel].filter(Boolean).join(" ")} />
      <Field label="Год" value={facts.vehicleYear} />
      <Field label="Оценочная стоимость" value={facts.vehicleValue} />
      <Field label="Нужная сумма" value={facts.requestedAmount} />
      <Field label="Доступные программы" value={translatePrograms(application?.decision?.eligiblePrograms as string[] | undefined)} />
      <Field label="Предварительные лимиты" value={application?.decision?.calculatedLimits} />
      <Field label="Семейное положение" value={facts.familyStatus} />
      <Field label="Поручитель" value={translateBoolean(facts.guarantorAvailable)} />
      <Field label="Документы" value={attachments.map((attachment) => `${translateAttachmentType(attachment.type)}: ${translateStatus(attachment.status)}`).join(", ")} />
      <Field label="Визит" value={[facts.visitDate, facts.visitTime].filter(Boolean).join(" ")} />
      <Field label="Следующее действие" value={translateNextAction(application?.decision?.nextAction)} />
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
      {messages.length === 0 ? <p className="muted">Сообщений пока нет.</p> : null}
      {messages.map((message) => (
        <article className={`message ${message.author}`} key={message.id}>
          <p className="messageAuthor">{translateAuthor(message.author)}</p>
          <p>{message.body || "[вложение]"}</p>
          {message.attachmentIds?.length ? <p className="muted">Вложений: {message.attachmentIds.length}</p> : null}
          <time>{formatDate(message.createdAt)}</time>
        </article>
      ))}
    </div>
  );
}

export function JsonPreview({ value }: Readonly<{ value: unknown }>) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

export function Notice({ tone, children }: Readonly<{ tone: "success" | "error" | "warning"; children: React.ReactNode }>) {
  return <div className={`notice ${tone}`}>{children}</div>;
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

function translateStage(stage?: string): string {
  const value = stage ?? "unknown";
  const map: Record<string, string> = {
    NEW: "Новая заявка",
    COLLECTING_VEHICLE: "Сбор данных об автомобиле",
    COLLECTING_VALUE: "Сбор стоимости",
    COLLECTING_AMOUNT: "Сбор суммы",
    COLLECTING_RESIDENCE: "Сбор прописки",
    ELIGIBILITY_CHECK: "Проверка условий",
    COLLECTING_DOCUMENTS: "Сбор документов",
    COLLECTING_FAMILY_STATUS: "Семейное положение",
    CHECKING_GUARANTOR: "Проверка поручителя",
    SCHEDULING_VISIT: "Согласование визита",
    TARGET_REACHED_DOCUMENTS: "Цель достигнута: документы",
    TARGET_REACHED_VISIT: "Цель достигнута: визит",
    REFUSED: "Отказ",
    PAUSED: "Пауза",
    EXISTING_CONTRACT_REDIRECT: "Действующий договор"
  };
  return map[value] ?? value;
}

function translatePrograms(programs?: string[]): string {
  if (!programs?.length) return "Не определены";
  return programs.map((program) => ({
    without_storage: "Без изъятия",
    parking: "Стоянка"
  }[program] ?? program)).join(", ");
}

function translateBoolean(value: unknown): string {
  if (value === true) return "Да";
  if (value === false) return "Нет";
  return "Не указано";
}

function translateNextAction(value: unknown): string {
  if (typeof value !== "string") return displayValue(value);
  const map: Record<string, string> = {
    ask_vehicle: "Запросить данные об автомобиле",
    ask_vehicle_value: "Запросить стоимость автомобиля",
    ask_amount: "Запросить нужную сумму",
    ask_residence: "Запросить прописку",
    ask_documents: "Запросить документы",
    ask_family_status: "Запросить семейное положение",
    ask_visit: "Согласовать визит",
    refuse: "Сообщить отказ",
    pause: "Остановить до продолжения клиента",
    redirect_existing_contract: "Перенаправить к сотрудникам"
  };
  return map[value] ?? value;
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

function translateAuthor(author: string): string {
  const map: Record<string, string> = {
    client: "Клиент",
    ai: "Айлин",
    manager: "Менеджер",
    system: "Система"
  };
  return map[author] ?? author;
}
