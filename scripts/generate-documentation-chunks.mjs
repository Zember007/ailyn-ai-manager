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
let section = "general";
for (const paragraph of paragraphs) {
  // Word often puts a new numbered subsection into the same paragraph as
  // the preceding answer. Split it before chunking so 5.15 and 5.16 cannot
  // become one mixed knowledge fragment.
  const parts = paragraph.split(/(?=\b(?:3|4|5|13|20|21)\.\d+(?:\.\d+)?\s)/u).map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const heading = part.match(/^(?:3|4|5|13|20|21)\.\d+(?:\.\d+)?/u)?.[0];
    if (heading) {
      if (buffer.length > 0) {
        chunks.push({ text: buffer.join(" "), section });
        buffer = [];
        size = 0;
      }
      section = heading;
    }
    const paragraphText = part;
    if (buffer.length > 0 && (size + paragraphText.length > 1_200 || buffer.length >= 5)) {
      chunks.push({ text: buffer.join(" "), section });
      buffer = [];
      size = 0;
    }
    buffer.push(paragraphText);
    size += paragraphText.length + 1;
  }
}
if (buffer.length > 0) chunks.push({ text: buffer.join(" "), section });

const serialized = chunks.map(({ text, section }, index) => ({
  key: `docx_${String(index + 1).padStart(4, "0")}`,
  keywords: [...new Set(text.toLocaleLowerCase("ru-RU").match(/[\p{L}\p{N}]{4,}/gu) ?? [])].slice(0, 80),
  section,
  primaryStage: primaryStageForSection(section, text),
  stages: stagesForSection(section, text),
  text
}));
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `// Generated from docs/АЙЛИН 6.2.docx. Do not edit manually.\nexport const generatedDocumentationChunks = ${JSON.stringify(serialized, null, 2)} as const;\n`, "utf8");
console.log(`Generated ${serialized.length} documentation chunks from ${source}`);

function decodeXml(value) {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function stagesForSection(section, text) {
  const value = `${section} ${text}`.toLocaleLowerCase("ru-RU");
  const stages = new Set();
  if (/5\.15|3\.7\.3|3\.9\.[023]|4\.2[56]|супруг|браке|развод/u.test(value)) stages.add("family_status");
  if (/5\.16|20\.2\.1|21\.2\.1|3\.9\.[01]|поручител/u.test(value)) stages.add("guarantor");
  if (/5\.17|21\.2|пропис|регион/u.test(value)) stages.add("residence");
  if (/3\.7\.1|документ|паспорт|стс|свидетельств/u.test(value)) stages.add("documents");
  if (/3\.7\.2|фотограф.*автомоб|фото.*автомоб/u.test(value)) stages.add("vehicle_photos");
  if (/3\.8|3\.9|визит|дата.*врем|офис/u.test(value)) stages.add("visit");
  if (/автомобил|марка|модель|год|стоимост|сумм.*займ/u.test(value)) stages.add("application");
  return [...stages];
}

function primaryStageForSection(section, text) {
  if (/^5\.15\b/u.test(section) || /^3\.7\.3\b/u.test(section) || /^3\.9\.[023]\b/u.test(section) || /супруг|браке|развод/u.test(text)) return "family_status";
  if (/^5\.16\b/u.test(section) || /^20\.2\.1\b/u.test(section) || /^21\.2\.1\b/u.test(section) || /поручител/u.test(text)) return "guarantor";
  if (/^5\.17\b/u.test(section) || /^21\.2\b/u.test(section) || /пропис|регион/u.test(text)) return "residence";
  if (/^3\.7\.1\b/u.test(section) || /документ|паспорт|стс|свидетельств/u.test(text)) return "documents";
  if (/^3\.7\.2\b/u.test(section) || /фото.*автомоб|фотограф.*автомоб/u.test(text)) return "vehicle_photos";
  if (/^3\.8\b/u.test(section) || /^3\.9\b/u.test(section) || /визит|дата.*врем|офис/u.test(text)) return "visit";
  return "application";
}
