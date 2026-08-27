export const apiBaseUrl = process.env.API_INTERNAL_URL ?? "http://localhost:3001/api";

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
  createdAt: string;
  metadata?: Record<string, unknown>;
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
  createdAt: string;
  updatedAt: string;
}

export interface Stage1Conversation {
  id: string;
  contactId: string;
  externalContactId: string;
  channel: string;
  status: string;
  messages: Stage1Message[];
  applicationId: string;
  application?: Stage1Application;
  createdAt: string;
  updatedAt: string;
}

export interface ScenarioRun {
  id: string;
  status: "PASS" | "FAIL" | "BLOCKED";
  summary: Record<string, number>;
  results: {
    id: string;
    status: "PASS" | "FAIL" | "BLOCKED";
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

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, { cache: "no-store" });
    if (!response.ok) return fallback;
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

export async function postJson<T>(path: string, body: unknown, fallback: T): Promise<T> {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store"
    });
    if (!response.ok) return fallback;
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

export async function patchJson<T>(path: string, body: unknown, fallback: T): Promise<T> {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store"
    });
    if (!response.ok) return fallback;
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

export function formatDate(value: string): string {
  return new Date(value).toLocaleString("ru-RU");
}

export function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "unknown";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
