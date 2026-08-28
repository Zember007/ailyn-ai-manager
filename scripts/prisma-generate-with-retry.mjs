import { spawn } from "node:child_process";

const schemaPath = process.argv[2];

if (!schemaPath) {
  console.error("Usage: node scripts/prisma-generate-with-retry.mjs <schema-path>");
  process.exit(1);
}

const maxAttempts = 4;
const baseDelayMs = 3000;

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  console.log(`Prisma generate attempt ${attempt}/${maxAttempts} for ${schemaPath}`);
  const exitCode = await runGenerate(schemaPath);

  if (exitCode === 0) {
    process.exit(0);
  }

  if (attempt === maxAttempts) {
    process.exit(exitCode ?? 1);
  }

  const delayMs = baseDelayMs * attempt;
  console.warn(`Prisma generate failed on attempt ${attempt}. Retrying in ${delayMs}ms.`);
  await sleep(delayMs);
}

function runGenerate(schema) {
  return new Promise((resolve) => {
    const child = spawn(getPnpmCommand(), ["exec", "prisma", "generate", "--schema", schema], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env
    });

    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

function getPnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
