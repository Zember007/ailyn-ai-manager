export interface AppConfig {
  nodeEnv: string;
  appVersion: string;
  apiPort: number;
  databaseUrl: string;
  redisUrl: string;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  aiProvider: "routerai";
  routerAiApiKey?: string;
  routerAiTextModel?: string;
  /** Model which turns a server-owned response plan into client-facing prose. */
  routerAiOutputModel?: string;
  routerAiKnowledgeModel?: string;
  routerAiVisionModel?: string;
  routerAiEvalModel?: string;
  routerAiNormalizerModel?: string;
  routerAiTimeoutMs: number;
  routerAiMaxRetries: number;
  whatsappProvider: "wazzup";
  wazzupApiKey?: string;
  wazzupBaseUrl?: string;
  wazzupChannelId?: string;
  wazzupWebhookSecret?: string;
  wazzupPhoneNumber?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

export function loadAppConfig(): AppConfig {
  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    appVersion: process.env.APP_VERSION ?? "0.1.0",
    apiPort: Number(process.env.API_PORT ?? "3001"),
    databaseUrl: requireEnv("DATABASE_URL"),
    redisUrl: requireEnv("REDIS_URL"),
    s3Endpoint: optionalEnv("S3_ENDPOINT"),
    s3Bucket: optionalEnv("S3_BUCKET"),
    s3AccessKey: optionalEnv("S3_ACCESS_KEY"),
    s3SecretKey: optionalEnv("S3_SECRET_KEY"),
    aiProvider: "routerai",
    routerAiApiKey: optionalEnv("ROUTERAI_API_KEY"),
    routerAiTextModel: optionalEnv("ROUTERAI_TEXT_MODEL"),
    routerAiOutputModel: optionalEnv("ROUTERAI_OUTPUT_MODEL"),
    routerAiKnowledgeModel: optionalEnv("ROUTERAI_KNOWLEDGE_MODEL"),
    routerAiVisionModel: optionalEnv("ROUTERAI_VISION_MODEL"),
    routerAiEvalModel: optionalEnv("ROUTERAI_EVAL_MODEL"),
    routerAiNormalizerModel: optionalEnv("ROUTERAI_NORMALIZER_MODEL"),
    routerAiTimeoutMs: Number(process.env.ROUTERAI_TIMEOUT_MS ?? "30000"),
    routerAiMaxRetries: Number(process.env.ROUTERAI_MAX_RETRIES ?? "2"),
    whatsappProvider: "wazzup",
    wazzupApiKey: optionalEnv("WAZZUP_API_KEY"),
    wazzupBaseUrl: optionalEnv("WAZZUP_BASE_URL"),
    wazzupChannelId: optionalEnv("WAZZUP_CHANNEL_ID"),
    wazzupWebhookSecret: optionalEnv("WAZZUP_WEBHOOK_SECRET"),
    wazzupPhoneNumber: optionalEnv("WAZZUP_PHONE_NUMBER")
  };
}
