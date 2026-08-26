export interface AppConfig {
  nodeEnv: string;
  appVersion: string;
  apiPort: number;
  databaseUrl: string;
  redisUrl: string;
  openAiApiKey?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadAppConfig(): AppConfig {
  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    appVersion: process.env.APP_VERSION ?? "0.1.0",
    apiPort: Number(process.env.API_PORT ?? "3001"),
    databaseUrl: requireEnv("DATABASE_URL"),
    redisUrl: requireEnv("REDIS_URL"),
    openAiApiKey: process.env.OPENAI_API_KEY || undefined
  };
}
