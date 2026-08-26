export type ServiceStatus = "ok" | "degraded" | "unconfigured" | "error";

export interface HealthDependency {
  status: ServiceStatus;
  latencyMs?: number;
  message?: string;
}

export interface ApiHealthResponse {
  status: ServiceStatus;
  version: string;
  stage: string;
  dependencies: {
    postgres: HealthDependency;
    redis: HealthDependency;
    ai: HealthDependency;
  };
  checkedAt: string;
}

export const APPLICATION_STATES = [
  "draft",
  "collecting_facts",
  "ready_for_review",
  "approved",
  "refused",
  "closed"
] as const;

export type ApplicationState = (typeof APPLICATION_STATES)[number];
