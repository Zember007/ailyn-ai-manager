import type { ApplicationFacts, DocumentCode, DocumentStatus } from "@ailyn/business-rules";

const repeatLoanPatterns = [
  /(?:хочу|можно|нуж(?:ен|ны)|дайте|оформ(?:ить|ляем)).{0,50}(?:снова|ещ[её]|повторно).{0,50}(?:займ|деньг)/iu,
  /(?:снова|ещ[её]|повторно).{0,40}(?:хочу|нуж(?:ен|ны)|можно|дайте).{0,50}(?:займ|деньг)/iu,
  /(?:выкупил(?:ся|ась)?|погасил(?:а)?|закрыл(?:а)?).{0,60}(?:снова|ещ[её]|опять|нуж(?:ен|ны)|займ|деньг)/iu,
  /(?:выкупил(?:ся|ась)?|погасил(?:а)?|закрыл(?:а)?).{0,80}(?:машин|автомобил|договор)/iu,
  /займ.{0,35}(?:снова|ещ[её]|повторно).{0,35}(?:дадите|можно|нуж)/iu
];

const activeContractPatterns = [
  /(?:где|как|чем).{0,40}(?:оплатить|платить|погасить).{0,40}(?:действующий|текущий|мой).{0,30}(?:займ|договор)/iu,
  /(?:gps|джипиэс|датчик|трекер).{0,50}(?:не\s*работ|сломал|отключ|снял)/iu
];

const persistentFactKeys: (keyof ApplicationFacts)[] = [
  "fullName",
  "phone",
  "residenceRegion",
  "residenceText",
  "residenceCategory",
  "familyStatus"
];

const idDocumentCodes = new Set<DocumentCode>(["id_front", "id_back"]);

export function isRepeatLoanRequest(text: string): boolean {
  const normalized = text.trim();
  return normalized.length > 0
    && !activeContractPatterns.some((pattern) => pattern.test(normalized))
    && repeatLoanPatterns.some((pattern) => pattern.test(normalized));
}

/** Copies only facts that remain valid between applications. Collateral,
 * financial parameters and vehicle-registration documents always belong to
 * the application that collected them. */
export function persistentClientFacts(facts: ApplicationFacts): Partial<ApplicationFacts> {
  const persistent: Partial<ApplicationFacts> = {};
  for (const key of persistentFactKeys) {
    const value = facts[key];
    if (value !== undefined) {
      (persistent as Record<string, unknown>)[key] = value;
    }
  }
  const documents = persistentIdDocuments(facts.documents);
  if (Object.keys(documents).length > 0) persistent.documents = documents;
  return persistent;
}

function persistentIdDocuments(documents: ApplicationFacts["documents"]): Partial<Record<DocumentCode, DocumentStatus>> {
  return Object.fromEntries(
    Object.entries(documents ?? {}).filter(([code, status]) => idDocumentCodes.has(code as DocumentCode) && status === "received")
  ) as Partial<Record<DocumentCode, DocumentStatus>>;
}
