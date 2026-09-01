import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "docs/АЙЛИН 6.2.docx");
const output = resolve(root, "apps/api/src/dialogue/documentation-chunks.generated.ts");

if (!existsSync(source)) {
  if (!existsSync(output)) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, "export const generatedDocumentationChunks = [];\n", "utf8");
  }
  process.exit(0);
}

const xml = execFileSync("unzip", ["-p", source, "word/document.xml"], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
const paragraphs = [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
  .map((match) => decodeXml([...match[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((item) => item[1]).join("")))
  .map((value) => value.replace(/\s+/g, " ").trim())
  .filter(Boolean);

const chunks = [];
let buffer = [];
let size = 0;
for (const paragraph of paragraphs) {
  if (buffer.length > 0 && (size + paragraph.length > 1_200 || buffer.length >= 5)) {
    chunks.push(buffer.join(" "));
    buffer = [];
    size = 0;
  }
  buffer.push(paragraph);
  size += paragraph.length + 1;
}
if (buffer.length > 0) chunks.push(buffer.join(" "));

const serialized = chunks.map((text, index) => ({
  key: `docx_${String(index + 1).padStart(4, "0")}`,
  keywords: [...new Set(text.toLocaleLowerCase("ru-RU").match(/[\p{L}\p{N}]{4,}/gu) ?? [])].slice(0, 80),
  text
}));
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `// Generated from docs/АЙЛИН 6.2.docx. Do not edit manually.\nexport const generatedDocumentationChunks = ${JSON.stringify(serialized, null, 2)} as const;\n`, "utf8");
console.log(`Generated ${serialized.length} documentation chunks from ${source}`);

function decodeXml(value) {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
