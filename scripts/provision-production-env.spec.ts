import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readEnvValue(envFile: string, key: string): string | undefined {
  const line = readFileSync(envFile, "utf8")
    .split("\n")
    .find((entry) => entry.startsWith(`${key}=`));
  return line?.slice(key.length + 1);
}

describe("provision-production-env.sh", () => {
  it("rebuilds internal DATABASE_URL and REDIS_URL with percent-encoded credentials", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ailyn-provision-"));
    const envFile = join(tempDir, ".env.production");

    try {
      writeFileSync(
        envFile,
        [
          "POSTGRES_DB=ailyn",
          "POSTGRES_USER=ailyn",
          "POSTGRES_PASSWORD=oldpass",
          "REDIS_PASSWORD=oldredis",
          "DATABASE_URL=postgresql://ailyn:oldpass@postgres:5432/ailyn?schema=public",
          "REDIS_URL=redis://:oldredis@redis:6379"
        ].join("\n")
      );

      execFileSync("bash", ["./scripts/provision-production-env.sh"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ENV_FILE: envFile,
          POSTGRES_PASSWORD: "p@ss:w#rd/[]?=",
          REDIS_PASSWORD: "r@d:is#pw/[]?="
        }
      });

      expect(readEnvValue(envFile, "DATABASE_URL")).toBe(
        "postgresql://ailyn:p%40ss%3Aw%23rd%2F%5B%5D%3F%3D@postgres:5432/ailyn?schema=public"
      );
      expect(readEnvValue(envFile, "REDIS_URL")).toBe("redis://:r%40d%3Ais%23pw%2F%5B%5D%3F%3D@redis:6379");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves external DATABASE_URL and REDIS_URL overrides", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ailyn-provision-"));
    const envFile = join(tempDir, ".env.production");

    try {
      writeFileSync(
        envFile,
        [
          "DATABASE_URL=postgresql://external_user:external_pass@db.example.com:5432/ailyn?schema=public",
          "REDIS_URL=redis://:external_secret@cache.example.com:6379"
        ].join("\n")
      );

      execFileSync("bash", ["./scripts/provision-production-env.sh"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ENV_FILE: envFile,
          POSTGRES_PASSWORD: "newpass",
          REDIS_PASSWORD: "newredis"
        }
      });

      expect(readEnvValue(envFile, "DATABASE_URL")).toBe(
        "postgresql://external_user:external_pass@db.example.com:5432/ailyn?schema=public"
      );
      expect(readEnvValue(envFile, "REDIS_URL")).toBe("redis://:external_secret@cache.example.com:6379");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
