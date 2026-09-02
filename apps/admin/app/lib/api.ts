export const apiBaseUrl = process.env.API_INTERNAL_URL ?? "http://localhost:3001/api";

export interface ApiMutationResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

export interface ApiReadResult<T> {
  ok: boolean;
  status: number;
  data: T;
  error?: string;
}

export interface HealthResponse {
  status: string;
  version: string;
  stage: string;
  dependencies: Record<string, { status: string; message?: string }>;
  checkedAt: string;
}

export interface Stage1Message {
  id: string;
  author: string;
  body: string;
  attachmentIds: string[];
  attachments: Stage1Attachment[];
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface Stage1Attachment {
  id: string;
  messageId?: string;
  conversationId: string;
  type: string;
  status: string;
  fileName?: string;
  mimeType?: string;
  byteSize?: number;
  storageKey?: string;
  createdAt: string;
}

export interface Stage1Application {
  id: string;
  conversationId: string;
  contactId: string;
  status: string;
  stage: string;
  facts: Record<string, unknown>;
  factHistory: { key: string; previousValue: unknown; newValue: unknown; changedAt: string }[];
  decision?: Record<string, unknown>;
  agentState?: { nextAction: string; cardSummary: string; intent: string; preliminaryLimit?: number | null };
  createdAt: string;
  updatedAt: string;
}

export interface Stage1Conversation {
  id: string;
  contactId: string;
  externalContactId: string;
  externalConversationId: string;
  channel: string;
  status: string;
  messages: Stage1Message[];
  applicationId: string;
  application?: Stage1Application;
  createdAt: string;
  updatedAt: string;
}

export interface TestChatSendResponse {
  reply: string;
  persisted: boolean;
  conversation: Stage1Conversation;
  conversationId: string;
  application: Stage1Application;
  validation: { passed: boolean; errors: string[] };
  routerAiModel: string;
  promptVersion: string;
}

export interface BackendLogEntry {
  id: string;
  level: string;
  context: string;
  message: string;
  requestId?: string;
  method?: string;
  path?: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
  stack?: string;
  createdAt: string;
}

export interface ScenarioRun {
  id: string;
  status: "PASS" | "FAIL" | "BLOCKED";
  summary: Record<string, number>;
  results: {
    id: string;
    status: "PASS" | "FAIL" | "BLOCKED";
    evaluationMode?: "deterministic" | "contract" | "blocked";
    expected: string;
    actual: string;
    assertions: string[];
    error?: string;
  }[];
  createdAt: string;
}

export interface Scenario {
  id: string;
  category: string;
  title: string;
  critical: boolean;
  blocked: boolean;
}

export interface SettingsResponse {
  values: Record<string, unknown>;
  fields: {
    key: string;
    label: string;
    value: unknown;
    type: "text" | "number" | "blocked";
    editable: boolean;
    blocked: boolean;
    reason?: string;
  }[];
}

export async function readQuery<T>(path: string, fallback: T): Promise<ApiReadResult<T>> {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, { cache: "no-store" });
    const payload = response.status === 204 ? null : await parsePayload(response);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data: fallback,
        error: extractApiError(payload) ?? `request_failed_${response.status}`
      };
    }

    return {
      ok: true,
      status: response.status,
      data: (payload as T | null) ?? fallback
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: fallback,
      error: error instanceof Error ? error.message : "api_unavailable"
    };
  }
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  const result = await readQuery(path, fallback);
  return result.data;
}

async function mutateJson<T>(method: "POST" | "PATCH", path: string, body: unknown): Promise<ApiMutationResult<T>> {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store"
    });
    const payload = response.status === 204 ? null : ((await parsePayload(response)) as T | null);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data: payload,
        error: extractApiError(payload) ?? `request_failed_${response.status}`
      };
    }

    return {
      ok: true,
      status: response.status,
      data: payload
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error instanceof Error ? error.message : "api_unavailable"
    };
  }
}

async function parsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json().catch(() => null);
  }
  return response.text().catch(() => null);
}

export async function postJson<T>(path: string, body: unknown, fallback: T): Promise<T> {
  const result = await mutateJson<T>("POST", path, body);
  return result.ok && result.data !== null ? result.data : fallback;
}

export async function patchJson<T>(path: string, body: unknown, fallback: T): Promise<T> {
  const result = await mutateJson<T>("PATCH", path, body);
  return result.ok && result.data !== null ? result.data : fallback;
}

export function postAction<T>(path: string, body: unknown): Promise<ApiMutationResult<T>> {
  return mutateJson<T>("POST", path, body);
}

export async function postMultipartAction<T>(path: string, body: FormData): Promise<ApiMutationResult<T>> {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method: "POST",
      body,
      cache: "no-store"
    });
    const payload = response.status === 204 ? null : ((await parsePayload(response)) as T | null);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data: payload,
        error: extractApiError(payload) ?? `request_failed_${response.status}`
      };
    }

    return {
      ok: true,
      status: response.status,
      data: payload
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error instanceof Error ? error.message : "api_unavailable"
    };
  }
}

export function patchAction<T>(path: string, body: unknown): Promise<ApiMutationResult<T>> {
  return mutateJson<T>("PATCH", path, body);
}

export async function postMultipart<T>(path: string, body: FormData): Promise<ApiMutationResult<T>> {
  try {
    const response = await fetch(path, {
      method: "POST",
      body,
      cache: "no-store"
    });
    const payload = response.status === 204 ? null : ((await parsePayload(response)) as T | null);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data: payload,
        error: extractApiError(payload) ?? `request_failed_${response.status}`
      };
    }

    return {
      ok: true,
      status: response.status,
      data: payload
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error instanceof Error ? error.message : "api_unavailable"
    };
  }
}

export function formatDate(value: string): string {
  return new Date(value).toLocaleString("ru-RU");
}

export function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "Не указано";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function getSearchParamValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function toFeedbackMessage(code?: string): { tone: "success" | "error" | "warning"; text: string } | null {
  switch (code) {
    case "conversation_created":
      return { tone: "success", text: "Тестовый диалог создан." };
    case "message_sent":
      return { tone: "success", text: "Сообщение отправлено в оркестратор диалога." };
    case "settings_saved":
      return { tone: "success", text: "Настройки сохранены." };
    case "knowledge_saved":
      return { tone: "success", text: "Запись базы знаний сохранена." };
    case "scenarios_started":
      return { tone: "success", text: "Прогон сценариев запущен." };
    case "api_unavailable":
      return { tone: "error", text: "API недоступен. Проверьте, что backend запущен и подключен к базе данных." };
    case "conversation_create_failed":
      return { tone: "error", text: "Не удалось создать тестовый диалог." };
    case "message_send_failed":
      return { tone: "error", text: "Не удалось отправить сообщение в тестовый чат." };
    case "conversation_not_found":
      return { tone: "error", text: "Текущий диалог не найден. Возможно, он был удален или устарел." };
    case "message_empty":
      return { tone: "warning", text: "Введите сообщение или прикрепите хотя бы один файл." };
    case "settings_save_failed":
      return { tone: "error", text: "Не удалось сохранить настройки." };
    case "knowledge_save_failed":
      return { tone: "error", text: "Не удалось сохранить запись базы знаний." };
    case "scenario_run_failed":
      return { tone: "error", text: "Не удалось запустить сценарии." };
    case "database_schema_missing":
      return { tone: "error", text: "Схема PostgreSQL не инициализирована. Примените Prisma-миграции и повторите действие." };
    case "scenario_contract_mode":
      return { tone: "warning", text: "Часть сценариев сейчас автоматизирована как contract-check, а не как полный admin -> api E2E-прогон." };
    case "message_send_in_progress":
      return { tone: "warning", text: "Айлин обрабатывает сообщение." };
    default:
      return code ? { tone: "error", text: `Backend вернул ошибку: ${code}` } : null;
  }
}

function extractApiError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as { message?: unknown; error?: unknown }).message ?? (payload as { error?: unknown }).error;
  if (typeof value !== "string") return undefined;
  if (value.startsWith("database_schema_missing")) return "database_schema_missing";
  if (value.startsWith("conversation_not_found")) return "conversation_not_found";
  if (value.startsWith("message_empty")) return "message_empty";
  return value;
}
