import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "docs/АЙЛИН 6.2.docx");
const output = resolve(root, "apps/api/src/dialogue/documentation-chunks.generated.ts");
// Paragraph chunking is intentionally generic, but §§20.3–20.4 are a
// catalogue of approved client replies. Mark them explicitly so the agent
// never paraphrases a matching answer. The two corrections below are the
// approved wording supplied by the business owner and take precedence over
// an outdated phrase in the DOCX extraction.
const verbatimAnswerSections = new Set(["20.3", "20.4"]);
const approvedAnswerOverrides = [
  {
    section: "3.4.1",
    match: /Компания принимает в залог только легковые автомобили/u,
    replacementText: "3.4.1 Основания для отказа. Компания не принимает в залог только спецтехнику: тракторы, экскаваторы, бульдозеры, погрузчики, автокраны, комбайны, грейдеры и асфальтоукладчики. Грузовики, пикапы, микроавтобусы, автобусы, мотоциклы, скутеры, лодки, катера и прицепы не являются стоп-фактором по типу транспорта. При спецтехнике Айлин использует ответ: «К сожалению, спецтехнику мы не принимаем в залог.»"
  },
  {
    section: "20.4",
    match: /Можно получить деньги на банковскую карту/u,
    question: "Можно получить деньги на банковскую карту?",
    answer: "К сожалению только наличными"
  },
  {
    section: "20.4",
    match: /Ставится ли на машину GPS\/трекер/u,
    question: "Ставится ли на машину GPS/трекер?",
    answer: "Это зависит от суммы займа и состояния автомобиля. Точно ответить сможем после осмотра автомобиля."
  },
  {
    section: "5.23.1",
    match: /Процентные ставки/u,
    replacementText: "5.23.1 Процентные ставки. При вопросе о процентных ставках о кредите ответ Айлин: по программе со стоянкой ставка составляет 2,4% в месяц, парковка — 130 сом в сутки. По программе без изъятия ставка определяется индивидуально после осмотра автомобиля и проверки документов."
  },
  {
    section: "5.23.3",
    match: /Где находится парковка\?/u,
    replacementText: "Где находится парковка? Парковка находится недалеко от нашего офиса и находится под охраной. Точный адрес парковки не сообщается. Парковка платная — 130 сом в сутки.",
    retrievalAnswer: "Парковка находится недалеко от нашего офиса и находится под охраной. Точный адрес парковки не сообщается. Парковка платная — 130 сом в сутки."
  },
  {
    section: "17.2",
    match: /Проверка корректности года выпуска/u,
    replacementText: "17.2 Последовательные сообщения. Если клиент отправляет несколько сообщений подряд с небольшими интервалами времени, они объединяются в один логический запрос. Ответ формируется после завершения серии сообщений. Проверка корректности года выпуска: если указанный год выпуска больше текущего календарного года, Айлин не продолжает оформление и не использует этот год в карточке клиента. Используется ответ: «___ год ещё не наступил. Уточните, пожалуйста, верный год выпуска автомобиля.» После получения корректного года оформление продолжается."
  }
];

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
  .map((value) => value.replace(/\s+/g, " ").replace(/(\d+)\.\s+(\d+)/gu, "$1.$2").trim())
  .filter(Boolean);

const groups = splitDocumentIntoGroups(paragraphs);
const serialized = [];
for (const group of groups) {
  const records = verbatimAnswerSections.has(group.sourceSection)
    ? splitApprovedQuestionAnswers(group.text, group.sourceSection)
    : splitWithOverlap(group.text);
  for (const [chunkIndex, record] of records.entries()) {
    const override = approvedAnswerOverrides.find((item) => item.section === group.sourceSection && item.match.test(record.text));
    const text = override?.replacementText ?? record.text;
    serialized.push({
      key: `docx_${String(serialized.length + 1).padStart(4, "0")}`,
      keywords: [...new Set(text.toLocaleLowerCase("ru-RU").match(/[\p{L}\p{N}]{4,}/gu) ?? [])].slice(0, 80),
      section: group.sourceSection,
      sourceSection: group.sourceSection,
      parentContext: group.parentContext,
      chunkIndex,
      ...(record.overlapFromPrevious ? { overlapFromPrevious: record.overlapFromPrevious } : {}),
      ...(verbatimAnswerSections.has(group.sourceSection) ? {
        responsePolicy: "verbatim",
        ...(record.approvedQuestion ? { approvedQuestion: record.approvedQuestion } : {}),
        ...(override?.answer ?? record.approvedAnswer ? { approvedAnswer: override?.answer ?? record.approvedAnswer } : {})
      } : record.retrievalQuestion ? {
        retrievalQuestion: override?.retrievalQuestion ?? record.retrievalQuestion,
        retrievalAnswer: override?.retrievalAnswer ?? record.retrievalAnswer
      } : {}),
      primaryStage: primaryStageForSection(group.sourceSection, text),
      stages: stagesForSection(group.sourceSection, text),
      text
    });
  }
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `// Generated from docs/АЙЛИН 6.2.docx. Do not edit manually.\nexport const generatedDocumentationChunks = ${JSON.stringify(serialized, null, 2)} as const;\n`, "utf8");
console.log(`Generated ${serialized.length} documentation chunks from ${source}`);

function splitDocumentIntoGroups(sourceParagraphs) {
  const groups = [];
  let current = { sourceSection: "general", parentContext: "Документ «АЙЛИН 6.2»: общие правила работы Айлин.", paragraphs: [] };
  for (const paragraph of sourceParagraphs) {
    // A top-level heading (for example, `21. Настройки компании`) and a
    // continuation label (`Продолжение раздела 20.4`) are semantic document
    // boundaries too. Without them, their administrative text is appended to
    // the preceding FAQ answer and may be sent to a client verbatim.
    // Keep a continuation label whole. Otherwise the generic numeric splitter
    // can start again at `20.4` inside the label and leave the words
    // «Продолжение раздела» attached to the preceding FAQ answer.
    const parts = /^Продолжение\s+раздела\s+/iu.test(paragraph)
      ? [paragraph]
      : paragraph.split(/(?=(?<![\d.])(?:[1-9]\d*)(?:\.(?:[1-9]\d*)){0,2}\.?\s+(?=[А-ЯЁ]))/u);
    for (const part of parts.map((value) => value.trim()).filter(Boolean)) {
      const heading = sectionHeadingOf(part);
      if (heading) {
        if (current.paragraphs.length > 0) groups.push({ ...current, text: current.paragraphs.join(" ") });
        current = { sourceSection: heading, parentContext: contextForSection(heading, part), paragraphs: [part] };
    } else if ((isQuestionParagraph(part) || isSemanticSubheading(part)) && current.paragraphs.length > 0) {
        // The source document stores most FAQ entries as a question paragraph
        // followed by one or more answer paragraphs under one broad heading.
        // Keep every pair together; otherwise a 1,200-character chunk can
        // merge many unrelated questions and retrieval becomes ambiguous.
        groups.push({ ...current, text: current.paragraphs.join(" ") });
        current = { sourceSection: current.sourceSection, parentContext: current.parentContext, paragraphs: [part] };
      } else current.paragraphs.push(part);
    }
  }
  if (current.paragraphs.length > 0) groups.push({ ...current, text: current.paragraphs.join(" ") });
  return groups;
}

function sectionHeadingOf(text) {
  const continuation = text.match(/^Продолжение\s+раздела\s+((?:[1-9]\d*)(?:\.(?:[1-9]\d*)){0,2})\.?\s*/iu)?.[1];
  if (continuation) return continuation;
  return text.match(/^((?:[1-9]\d*)(?:\.(?:[1-9]\d*)){0,2})\.?\s+(?=[А-ЯЁ])/u)?.[1];
}

function isQuestionParagraph(text) {
  return text.includes("?") && text.trim().endsWith("?");
}

// The DOCX contains topic labels such as «Клиент сообщает о неисправности
// GPS» directly after FAQ answers, without a numbered heading. They must
// begin a new retrieval unit; otherwise an answer about parking can absorb a
// later, unrelated servicing rule and become a false semantic match.
function isSemanticSubheading(text) {
  return /^(?:Клиент\s+(?:сообщает|спрашивает|интересуется|просит)|Если\s+клиент\s+(?:сообщает|спрашивает|просит)|Вопросы\s+о\s+)/iu.test(text.trim());
}

function contextForSection(section, text) {
  const firstSentence = text.match(/^[\s\S]{1,320}?[.!?](?:\s|$)/u)?.[0]?.trim() ?? text.slice(0, 320).trim();
  return firstSentence.startsWith(section) ? firstSentence : `${section}. ${firstSentence}`;
}

function splitWithOverlap(text, maximumLength = 1_200) {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/gu) ?? [text];
  const records = [];
  let current = "";
  let overlapFromPrevious;
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (current && current.length + trimmed.length + 1 > maximumLength) {
      records.push(withRetrievalQuestionAnswer(current.trim(), overlapFromPrevious));
      overlapFromPrevious = tailSentences(current, 2, 320);
      current = `${overlapFromPrevious} ${trimmed}`;
    } else current = `${current} ${trimmed}`.trim();
  }
  if (current) records.push(withRetrievalQuestionAnswer(current, overlapFromPrevious));
  return records;
}

function withRetrievalQuestionAnswer(text, overlapFromPrevious) {
  const match = text.match(/^([^?.!]{3,}\?)\s+([\s\S]+)$/u);
  return {
    text,
    ...(overlapFromPrevious ? { overlapFromPrevious } : {}),
    ...(match ? { retrievalQuestion: match[1].trim(), retrievalAnswer: match[2].trim() } : {})
  };
}

function tailSentences(text, count, maximumLength) {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/gu) ?? [text];
  return sentences.slice(-count).join(" ").trim().slice(-maximumLength);
}

function splitApprovedQuestionAnswers(text, section) {
  const records = [];
  const pattern = /(?:^|(?<=[.!]\s))([^?.!]{3,}\?)\s*([\s\S]*?)(?=(?:\s+[А-ЯЁ][^?.!]{3,}\?)|$)/gu;
  for (const match of text.matchAll(pattern)) {
    const approvedQuestion = match[1].trim();
    const approvedAnswer = match[2].trim();
    if (approvedAnswer) records.push({ text: `${approvedQuestion} ${approvedAnswer}`, approvedQuestion, approvedAnswer });
  }
  const requiredOverrides = approvedAnswerOverrides.filter((item) => item.section === section && item.answer && item.question);
  for (const override of requiredOverrides) {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (override.match.test(records[index].text)) records.splice(index, 1);
    }
    records.push({ text: `${override.question} ${override.answer}`, approvedQuestion: override.question, approvedAnswer: override.answer });
  }
  return records.length > 0 ? records : [{ text }];
}

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
