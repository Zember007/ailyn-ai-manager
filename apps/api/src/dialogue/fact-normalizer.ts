import type { ApplicationFacts, DocumentCode, ResidenceCategory } from "@ailyn/business-rules";

export interface NormalizeTurnFactsInput {
  text?: string;
  pendingFacts: (keyof ApplicationFacts | DocumentCode)[];
  currentFacts: ApplicationFacts;
}

const bishkekPattern = /(?:^|[^А-ЯЁа-яёA-Za-z])(?:бишкек(?:е|а|ом)?|bishkek)(?=$|[^А-ЯЁа-яёA-Za-z])/i;
const chuyPattern = /(?:^|[^А-ЯЁа-яё])(?:чуй(?:ская|ской|скую)?(?:\s+област(?:ь|и))?|чүй(?:\s+облусу)?)(?=$|[^А-ЯЁа-яё])/i;
const foreignPattern = /(?:иностранн\w*|за\s+границ\w*|друг(?:ая|ой)\s+стран\w*|foreign)/i;
const vagueResidencePattern = /(?:городская|сельская|временная|постоянная|местная)/i;

export function normalizeTurnFacts(input: NormalizeTurnFactsInput): Partial<ApplicationFacts> {
  const source = input.text?.trim();
  if (!source) {
    return {};
  }

  const facts: Partial<ApplicationFacts> = {};
  const pendingOwnerResidence = input.pendingFacts.includes("ownerResidenceRegion");
  if (input.pendingFacts.includes("residenceRegion") || pendingOwnerResidence) {
    const explicit = extractExplicitResidence(source);
    if (explicit) {
      Object.assign(facts, {
        ...(pendingOwnerResidence ? { ownerResidenceRegion: explicit.text } : {}),
        residenceText: explicit.text,
        residenceRegion: explicit.text,
        residenceCategory: explicit.category,
        residenceNeedsClarification: false
      });
    } else {
      const vague = source.match(vagueResidencePattern)?.[0]?.toLocaleLowerCase("ru-RU");
      if (vague) {
        Object.assign(facts, {
          residenceText: vague,
          residenceNeedsClarification: true
        });
      }
    }
  }

  if (input.pendingFacts.includes("familyStatus")) {
    const familyStatus = extractFamilyStatus(source);
    if (familyStatus) {
      facts.familyStatus = familyStatus;
    }
  }

  const spouseConsentReady = extractSpouseConsentReady(source);
  if (spouseConsentReady !== undefined) {
    facts.spouseConsentReady = spouseConsentReady;
  }

  if (input.pendingFacts.includes("guarantorAvailable")) {
    const guarantorAvailable = extractGuarantorAvailability(source);
    if (guarantorAvailable !== undefined) {
      facts.guarantorAvailable = guarantorAvailable;
    }
  }

  const requestedProgram = extractRequestedProgram(source);
  if (requestedProgram) {
    facts.requestedProgram = requestedProgram;
  }
  if (extractDeclinedDocuments(source)) {
    facts.declinedDocuments = true;
  }

  return facts;
}

function extractExplicitResidence(text: string): { text: string; category: ResidenceCategory } | undefined {
  if (bishkekPattern.test(text)) {
    return { text: "Бишкек", category: "BISHKEK" };
  }
  if (chuyPattern.test(text)) {
    return { text: "Чуйская область", category: "CHUY" };
  }
  if (foreignPattern.test(text)) {
    return { text: text.trim(), category: "FOREIGN" };
  }

  if (/(?:^|[^А-ЯЁа-яё])ош(?:е|а|ом)?(?=$|[^А-ЯЁа-яё])/i.test(text)) {
    return { text: "Ош", category: "OTHER_KG" };
  }

  const namedLocation = text.match(
    /(?:пропис(?:ан|ана|ка)|жив[уе]т|из)\s+(?:в\s+)?(?:городе\s+|селе\s+|области\s+)?([А-ЯЁ][А-ЯЁа-яё-]{2,}(?:\s+[А-ЯЁ][А-ЯЁа-яё-]{2,})?)/u
  )?.[1];
  if (namedLocation && !vagueResidencePattern.test(namedLocation)) {
    return { text: namedLocation.trim(), category: "OTHER_KG" };
  }

  const shortLocation = text.match(/^\s*(?:г\.?\s*)?([А-ЯЁ][А-ЯЁа-яё-]{2,})\s*$/u)?.[1];
  if (shortLocation && !vagueResidencePattern.test(shortLocation)) {
    return { text: shortLocation.trim(), category: "OTHER_KG" };
  }

  return undefined;
}

function extractFamilyStatus(text: string): ApplicationFacts["familyStatus"] | undefined {
  const normalized = text.toLocaleLowerCase("ru-RU");
  if (/не\s+женат|не\s+замужем|никогда\s+не\s+состоял/.test(normalized)) return "single";
  if (/развед[её]н|разведена|в\s+разводе/.test(normalized)) return "divorced";
  if (/женат|замужем|состою\s+в\s+браке/.test(normalized)) return "married";
  return undefined;
}

function extractSpouseConsentReady(text: string): boolean | undefined {
  const normalized = text.toLocaleLowerCase("ru-RU");
  if (!/согласи/.test(normalized)) return undefined;
  if (/не\s+готов|нет|не\s+оформлен/.test(normalized)) return false;
  if (/готов|есть|оформлен/.test(normalized)) return true;
  return undefined;
}

function extractGuarantorAvailability(text: string): boolean | undefined {
  const normalized = text.trim().toLocaleLowerCase("ru-RU");
  if (/^(да|есть)$/.test(normalized) || /поручител[^.!?]{0,20}(есть|будет|найду)/.test(normalized)) return true;
  if (/^нет$/.test(normalized) || /поручител[^.!?]{0,20}(нет|не\s+будет)/.test(normalized)) return false;
  return undefined;
}

function extractRequestedProgram(text: string): ApplicationFacts["requestedProgram"] | undefined {
  const normalized = text.toLocaleLowerCase("ru-RU");
  if (/без\s+из[ъя]тия/.test(normalized)) return "without_storage";
  if (/стоянк|парковк/.test(normalized)) return "parking";
  return undefined;
}

function extractDeclinedDocuments(text: string): boolean {
  const normalized = text.toLocaleLowerCase("ru-RU");
  return /(?:не\s+могу|не\s+буду|не\s+хочу|нет\s+возможности)[^.!?]{0,60}(?:прислать|отправить|скинуть)?[^.!?]{0,30}(?:документ|фото)/.test(normalized);
}
