import type { ApplicationFacts } from "@ailyn/business-rules";

export type MoneyCurrencyCode = "KGS" | "USD" | "EUR" | "KZT" | "RUB";
/** Currencies that are eligible for the NBKR foreign-exchange conversion path. */
export type ForeignMoneyCurrencyCode = Exclude<MoneyCurrencyCode, "KGS">;
export type MoneyRoleCandidate = "requestedAmount" | "vehicleValue" | "unknown";

export interface MoneyMention {
  sourceText: string;
  amount: number;
  normalizedAmount: number;
  /** Null means RouterAI identified an amount but could not identify its currency. */
  currency: MoneyCurrencyCode | null;
  roleCandidate: MoneyRoleCandidate;
  confidence: number;
  /** Runtime reconciliation computes positions when the source text is available. */
  start?: number;
  end?: number;
}

export interface ResolvedMoneyFacts {
  mentions: MoneyMention[];
  requestedAmount?: number;
  requestedAmountCurrency?: MoneyCurrencyCode;
  requestedAmountConfidence: number;
  vehicleValue?: number;
  vehicleValueCurrency?: MoneyCurrencyCode;
  vehicleValueConfidence: number;
}

// Emergency fallback and numeric post-processing only. Do not expand this into
// a natural-language understanding layer; RouterAI owns flexible wording.
const moneyPattern =
  /(?:(\$|€|₸|₽|usd|eur|kzt|kgs?\.?|rub|доллар(?:ов|а|ы)?|евро|тенге|сом(?:а|ов)?|руб(?:ль|ля|лей)?)\s*)?(\d{1,3}(?:[ \u00a0.,]\d{3})+|\d+(?:[.,]\d+)?)(?:\s*)(млн|миллион(?:а|ов)?|тыс(?:яч[аи]?)?|тыщ|[kк])?(?:\s*)(\$|€|₸|₽|usd|eur|kzt|kgs?\.?|rub|доллар(?:ов|а|ы)?|евро|тенге|сом(?:а|ов)?|руб(?:ль|ля|лей)?)?/giu;
const requestedCuePattern = /(нужн|надо|сумм|займ|получить|оформить|хочу|хотел(?:ось)?|надобно|требуется|дайте|выдайте)/i;
const vehicleCuePattern = /(стоит|стоимость|цена|оцен|машина|авто|автомобил|рыночн)/i;
const requestedCorrectionPattern = /(?:уже|теперь|нет|не\s+так|точнее|лучше|надо\s+больше|нужно\s+больше|хочу\s+больше)[^.!?]{0,40}(?:нужн|надо|сумм|займ|получить|хочу)?/i;
const vehicleCorrectionPattern = /(?:уже|теперь|нет|не\s+так|точнее|ошиб(?:ся|лась)|сто(?:ит|имость)|цен[ауы])[^.!?]{0,40}(?:сто(?:ит|имость)|цен[ауы]|оцен)/i;

export function resolveMoneyFacts(input: {
  text?: string;
  currentFacts: ApplicationFacts;
  pendingFacts?: (keyof ApplicationFacts)[];
}): ResolvedMoneyFacts {
  const mentions = detectMoneyMentions(input.text ?? "");
  const context = getMoneyContext(input.text ?? "", input.currentFacts, input.pendingFacts ?? []);
  const vehicle = chooseMoneyMention("vehicleValue", mentions, input.currentFacts, context);
  if (vehicle && vehicle.roleCandidate === "unknown") {
    vehicle.roleCandidate = "vehicleValue";
  }
  const requested = chooseMoneyMention("requestedAmount", mentions, input.currentFacts, context, vehicle ? [vehicle] : []);
  if (requested && requested.roleCandidate === "unknown") {
    requested.roleCandidate = "requestedAmount";
  }

  return {
    mentions,
    requestedAmount: requested?.normalizedAmount,
    requestedAmountCurrency: requested?.currency ?? undefined,
    requestedAmountConfidence: requested?.confidence ?? 0,
    vehicleValue: vehicle?.normalizedAmount,
    vehicleValueCurrency: vehicle?.currency ?? undefined,
    vehicleValueConfidence: vehicle?.confidence ?? 0
  };
}

export function detectMoneyMentions(text: string): MoneyMention[] {
  const source = text ?? "";
  const mentions: MoneyMention[] = [];

  for (const match of source.matchAll(moneyPattern)) {
    const raw = match[0]?.trim();
    const numberPart = match[2];
    if (!raw || !numberPart || match.index === undefined) {
      continue;
    }

    const contextBefore = source.slice(Math.max(0, match.index - 32), match.index);
    const contextAfter = source.slice(match.index + raw.length, Math.min(source.length, match.index + raw.length + 32));
    const unit = match[3] ?? "";
    const prefixCurrency = normalizeCurrency(match[1]);
    const suffixCurrency = normalizeCurrency(match[4]);
    const currency = suffixCurrency ?? prefixCurrency ?? "KGS";
    const amount = parseNormalizedAmount(numberPart, unit);

    if (amount === undefined || !looksLikeMoneyMention({ fullText: source, raw, amount, unit, prefixCurrency, suffixCurrency, contextBefore, contextAfter })) {
      continue;
    }

    const role = inferMoneyRoleCandidate(contextBefore, contextAfter);
    const explicitCurrency = Boolean(prefixCurrency || suffixCurrency);
    const explicitUnit = Boolean(unit);
    const confidence = role === "unknown"
      ? explicitCurrency || explicitUnit ? 0.82 : 0.7
      : explicitCurrency || explicitUnit ? 0.96 : 0.88;

    mentions.push({
      sourceText: raw,
      amount,
      normalizedAmount: amount,
      currency,
      roleCandidate: role,
      confidence,
      start: match.index,
      end: match.index + raw.length
    });
  }

  return dedupeMentions(mentions);
}

export function formatMoney(value: number): string {
  return new Intl.NumberFormat("ru-RU").format(value).replace(/\u00a0/g, " ");
}

function chooseMoneyMention(
  role: Extract<MoneyRoleCandidate, "requestedAmount" | "vehicleValue">,
  mentions: MoneyMention[],
  currentFacts: ApplicationFacts,
  context: MoneyContext,
  excluded: MoneyMention[] = []
): MoneyMention | undefined {
  if (role === "requestedAmount" && currentFacts.requestedAmount !== undefined && !context.allowRequestedRevision) {
    return undefined;
  }
  if (role === "vehicleValue" && currentFacts.vehicleValue !== undefined && !context.allowVehicleRevision) {
    return undefined;
  }

  const available = mentions.filter((mention) => !excluded.includes(mention));
  const explicit = available
    .filter((mention) => mention.roleCandidate === role)
    .sort((left, right) => right.confidence - left.confidence || moneyMentionStart(left) - moneyMentionStart(right))[0];
  if (explicit) {
    return explicit;
  }

  if (available.length === 1 && (available[0].roleCandidate === "unknown" || available[0].roleCandidate === role)) {
    if (context.pendingRole && context.pendingRole !== role && available[0].roleCandidate === "unknown") {
      return undefined;
    }
    return available[0];
  }

  const unresolvedRequested = currentFacts.requestedAmount === undefined || context.allowRequestedRevision;
  const unresolvedVehicle = currentFacts.vehicleValue === undefined || context.allowVehicleRevision;
  if (available.length >= 2 && unresolvedRequested && unresolvedVehicle) {
    const sorted = [...available].sort((left, right) => right.normalizedAmount - left.normalizedAmount || moneyMentionStart(left) - moneyMentionStart(right));
    return role === "vehicleValue" ? sorted[0] : sorted[sorted.length - 1];
  }

  return available.sort((left, right) => right.confidence - left.confidence || moneyMentionStart(left) - moneyMentionStart(right))[0];
}

function moneyMentionStart(mention: MoneyMention): number {
  return mention.start ?? Number.MAX_SAFE_INTEGER;
}

function normalizeCurrency(value: string | undefined): MoneyCurrencyCode | undefined {
  if (!value) return undefined;
  const normalized = value.toLocaleLowerCase("ru-RU").replace(/\./g, "");
  if (normalized === "$" || normalized === "usd" || normalized.startsWith("доллар")) return "USD";
  if (normalized === "€" || normalized === "eur" || normalized === "евро") return "EUR";
  if (normalized === "₸" || normalized === "kzt" || normalized === "тенге") return "KZT";
  if (normalized === "₽" || normalized === "rub" || normalized.startsWith("руб")) return "RUB";
  if (normalized.startsWith("сом") || normalized === "kgs" || normalized === "kgs") return "KGS";
  return undefined;
}

function parseNormalizedAmount(rawNumber: string, unit: string): number | undefined {
  const compact = rawNumber.replace(/\u00a0/g, " ").trim();
  let numericValue: number | undefined;

  if (/^\d{1,3}(?:[ .]\d{3})+$/.test(compact) || /^\d{1,3}(?:[.,]\d{3})+$/.test(compact)) {
    numericValue = Number(compact.replace(/[ .,]/g, ""));
  } else {
    const normalized = compact.replace(/\s+/g, "").replace(",", ".");
    if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
      return undefined;
    }
    numericValue = Number(normalized);
  }

  if (!Number.isFinite(numericValue)) {
    return undefined;
  }

  const normalizedUnit = unit.toLocaleLowerCase("ru-RU");
  const multiplier = normalizedUnit.startsWith("млн") || normalizedUnit.startsWith("миллион")
    ? 1_000_000
    : normalizedUnit.startsWith("тыс") || normalizedUnit.startsWith("тыщ") || normalizedUnit === "к" || normalizedUnit === "k"
      ? 1_000
      : 1;
  return Math.round(numericValue * multiplier);
}

function looksLikeMoneyMention(input: {
  fullText: string;
  raw: string;
  amount: number;
  unit: string;
  prefixCurrency?: MoneyCurrencyCode;
  suffixCurrency?: MoneyCurrencyCode;
  contextBefore: string;
  contextAfter: string;
}): boolean {
  const context = `${input.contextBefore} ${input.contextAfter}`.toLocaleLowerCase("ru-RU");
  const explicitMarker = Boolean(input.unit || input.prefixCurrency || input.suffixCurrency);
  if (explicitMarker) {
    return true;
  }
  if (/год(?:а|у|ом)?|года|телефон|номер|время|час|минут/.test(context)) {
    return false;
  }
  const nonNumericRemainder = input.fullText
    .replace(input.raw, " ")
    .toLocaleLowerCase("ru-RU")
    .replace(/[0-9\s.,]/g, " ")
    .replace(/\bи\b/g, " ")
    .trim();
  if (input.amount >= 10_000 && nonNumericRemainder.length === 0) {
    return true;
  }
  if (input.amount >= 10_000 && (requestedCuePattern.test(context) || vehicleCuePattern.test(context))) {
    return true;
  }
  return false;
}

function inferMoneyRoleCandidate(contextBefore: string, contextAfter: string): MoneyRoleCandidate {
  const before = contextBefore.toLocaleLowerCase("ru-RU");
  const after = contextAfter.toLocaleLowerCase("ru-RU");
  const requestedScore = cueScore(before, after, requestedCuePattern);
  const vehicleScore = cueScore(before, after, vehicleCuePattern);

  if (requestedScore > vehicleScore) return "requestedAmount";
  if (vehicleScore > requestedScore) return "vehicleValue";
  return "unknown";
}

function cueScore(before: string, after: string, pattern: RegExp): number {
  let score = 0;
  if (pattern.test(before.slice(-24))) score += 2;
  pattern.lastIndex = 0;
  if (pattern.test(after.slice(0, 24))) score += 1;
  pattern.lastIndex = 0;
  return score;
}

function dedupeMentions(mentions: MoneyMention[]): MoneyMention[] {
  const seen = new Set<string>();
  return mentions.filter((mention) => {
    const key = `${mention.start}:${mention.end}:${mention.currency}:${mention.normalizedAmount}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

interface MoneyContext {
  pendingRole?: Extract<MoneyRoleCandidate, "requestedAmount" | "vehicleValue">;
  allowRequestedRevision: boolean;
  allowVehicleRevision: boolean;
}

function getMoneyContext(
  text: string,
  currentFacts: ApplicationFacts,
  pendingFacts: (keyof ApplicationFacts)[]
): MoneyContext {
  const normalized = text.toLocaleLowerCase("ru-RU");
  const pendingRole = pendingFacts.includes("requestedAmount")
    ? "requestedAmount"
    : pendingFacts.includes("vehicleValue")
      ? "vehicleValue"
      : undefined;
  const allowRequestedRevision =
    requestedCorrectionPattern.test(normalized) ||
    (currentFacts.requestedAmount !== undefined && requestedCuePattern.test(normalized) && !vehicleCuePattern.test(normalized));
  const allowVehicleRevision =
    vehicleCorrectionPattern.test(normalized) ||
    (currentFacts.vehicleValue !== undefined && vehicleCuePattern.test(normalized) && !requestedCuePattern.test(normalized));
  return { pendingRole, allowRequestedRevision, allowVehicleRevision };
}
