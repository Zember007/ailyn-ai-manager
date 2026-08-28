import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const sourceDir = resolve(projectRoot, "apps/api/src/ai/prompts");
const targetDir = resolve(projectRoot, "apps/api/dist/apps/api/src/ai/prompts");

if (!existsSync(sourceDir)) {
  throw new Error(`Prompt source directory not found: ${sourceDir}`);
}

mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });
