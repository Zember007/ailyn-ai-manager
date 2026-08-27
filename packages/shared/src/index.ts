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
  "NEW",
  "COLLECTING_VEHICLE",
  "COLLECTING_VALUE",
  "COLLECTING_AMOUNT",
  "COLLECTING_RESIDENCE",
  "ELIGIBILITY_CHECK",
  "COLLECTING_DOCUMENTS",
  "COLLECTING_FAMILY_STATUS",
  "CHECKING_GUARANTOR",
  "SCHEDULING_VISIT",
  "TARGET_REACHED_DOCUMENTS",
  "TARGET_REACHED_VISIT",
  "REFUSED",
  "PAUSED",
  "EXISTING_CONTRACT_REDIRECT"
] as const;

export type ApplicationState = (typeof APPLICATION_STATES)[number];
