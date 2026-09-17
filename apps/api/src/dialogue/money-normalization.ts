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
  /(?:(\$|€|₸|₽|usd|dollars?|bucks?|eur(?:o)?s?|kzt|kgs?\.?|rub(?:les?)?|дол+ар(?:ов|а|ы)?|дол(?!\p{L})|бакс\p{L}*|евр\p{L}*|тенг\p{L}*|сом\p{L}*|руб\p{L}*)\s*)?(\d{1,3}(?:[ \u00a0.,]\d{3})+|\d+(?:[.,]\d+)?)(?:\s*)(млн|слн|миллион(?:а|ов)?|лям(?:а|ов)?|тыс(?:яч[аи]?)?|тыщ|[kк])?(?:\s*)(\$|€|₸|₽|usd|dollars?|bucks?|eur(?:o)?s?|kzt|kgs?\.?|rub(?:les?)?|дол+ар(?:ов|а|ы)?|дол(?!\p{L})|бакс\p{L}*|евр\p{L}*|тенг\p{L}*|сом\p{L}*|руб\p{L}*)?/giu;
// A request such as "1 млн дадите?" is a requested loan, never an implied
// vehicle value merely because the message also names a car and its year.
const requestedCuePattern = /(нуж\p{L}*|надо|сумм|займ|получить|оформить|хочу|хотел(?:ось)?|надобно|требуется|потреб(?:уется|овалось|ую)|дайте|выдайте|дадите)/iu;
// `стои` is a common dropped-final-letter typo in chat messages. Keep the
// boundary narrow so it still denotes the vehicle-price cue rather than an
// arbitrary substring.
const vehicleCuePattern = /(?:стоит|стои(?=[\s,.!?]|$)|сто[ий]мост|цена|оцен|машина|авто|автомобил|рыночн)/i;
const requestedCorrectionPattern = /(?:уже|теперь|нет|не\s+так|точнее|лучше|надо\s+больше|нужно\s+больше|хочу\s+больше)[^.!?]{0,40}(?:нужн|надо|сумм|займ|получить|хочу)?/i;
const vehicleCorrectionPattern = /(?:уже|теперь|нет|не\s+так|точнее|ошиб(?:ся|лась)|перепутал(?:ся|ась)?|сто(?:ит|[ий]мост)|цен[ауы])[^.!?]{0,40}(?:сто(?:ит|[ий]мост)|цен[ауы]|оцен|доллар|евро|тенге|руб)/i;

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
  // `chooseMoneyMention` can select an ordinary parsed mention instead of a
  // synthetic shorthand fallback. Apply the same, sentence-bounded currency
  // inheritance to that selected value before it reaches conversion.
  if (requested && !requested.currency) requested.currency = inheritedClauseCurrency(input.text ?? "", mentions, requested);
  if (vehicle && !vehicle.currency) vehicle.currency = inheritedClauseCurrency(input.text ?? "", mentions, vehicle);
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

function inheritedClauseCurrency(text: string, mentions: MoneyMention[], mention: MoneyMention): MoneyCurrencyCode | null {
  const start = mention.start ?? 0;
  if (!/(?:тыс|тыщ|\d\s*[кk](?=\s|$))/iu.test(mention.sourceText)) return null;
  const clauseStart = Math.max(text.lastIndexOf(".", start - 1), text.lastIndexOf(";", start - 1)) + 1;
  const prior = mentions.filter((candidate) => (candidate.start ?? -1) >= clauseStart && (candidate.end ?? 0) <= start && candidate.currency);
  const currencies = new Set(prior.map((candidate) => candidate.currency));
  return currencies.size === 1 ? prior.at(-1)?.currency ?? null : null;
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
    const currency = suffixCurrency ?? prefixCurrency ?? null;
    const baseAmount = parseNormalizedAmount(numberPart, unit);
    // «Миллион с половиной» is a single explicit amount, not a vague
    // approximation. Keep this narrow: the fractional form must immediately
    // follow an amount with a unit, so dates and unrelated "половина" text
    // cannot become money.
    const halfUnitAmount = /(?:^|\s)с\s+половин(?:ой|ы)(?:$|[\s,.!?])/iu.test(contextAfter)
      ? parseNormalizedAmount("0.5", unit)
      : undefined;
    const amount = baseAmount === undefined
      ? undefined
      : baseAmount + (halfUnitAmount ?? 0);

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

  // A client can shorten the second value in one clause: "стоит 20 тыс
  // долларов, надо 10". Inherit currency and multiplier only from the
  // immediately preceding explicit amount in that same clause; never across
  // sentences/messages or from a bare number without a role cue.
  for (const match of source.matchAll(/(?:надо|нужно|хочу|требуется|дайте)\s+(\d{1,3})(?![\d\s]*(?:тыс|тыщ|млн|к\b))/giu)) {
    const rawNumber = match[1];
    if (!rawNumber || match.index === undefined) continue;
    const start = match.index + match[0].lastIndexOf(rawNumber);
    if (mentions.some((mention) => mention.start === start)) continue;
    const clauseStart = Math.max(source.lastIndexOf(".", start - 1), source.lastIndexOf(";", start - 1)) + 1;
    const prior = mentions.filter((mention) => (mention.start ?? -1) >= clauseStart && (mention.end ?? 0) <= start && mention.currency);
    const currencies = new Set(prior.map((mention) => mention.currency));
    const inherited = prior.at(-1);
    if (!inherited || currencies.size !== 1 || !/(?:тыс|тыщ|\d\s*[кk](?=\s|$))/iu.test(inherited.sourceText)) continue;
    const amount = Number(rawNumber) * 1_000;
    mentions.push({ sourceText: rawNumber, amount, normalizedAmount: amount, currency: inherited.currency, roleCandidate: "requestedAmount", confidence: 0.9, start, end: start + rawNumber.length });
  }

  // The same shorthand can occur in reverse order: "нужно 5к долларов,
  // машина стоит 20". Here the second, vehicle-price role inherits only the
  // unambiguous currency and multiplier from that same sentence.
  for (const match of source.matchAll(/(?:стоит|стоимость|цена)\s+(\d{1,3})(?![\d\s]*(?:тыс|тыщ|млн|к\b))/giu)) {
    const rawNumber = match[1];
    if (!rawNumber || match.index === undefined) continue;
    const start = match.index + match[0].lastIndexOf(rawNumber);
    if (mentions.some((mention) => mention.start === start)) continue;
    const clauseStart = Math.max(source.lastIndexOf(".", start - 1), source.lastIndexOf(";", start - 1)) + 1;
    const prior = mentions.filter((mention) => (mention.start ?? -1) >= clauseStart && (mention.end ?? 0) <= start && mention.currency);
    const currencies = new Set(prior.map((mention) => mention.currency));
    const inherited = prior.at(-1);
    if (!inherited || currencies.size !== 1 || !/(?:тыс|тыщ|\d\s*[кk](?=\s|$))/iu.test(inherited.sourceText)) continue;
    const amount = Number(rawNumber) * 1_000;
    mentions.push({ sourceText: rawNumber, amount, normalizedAmount: amount, currency: inherited.currency, roleCandidate: "vehicleValue", confidence: 0.9, start, end: start + rawNumber.length });
  }

  // If the short second value contains its own multiplier but omits only the
  // currency ("стоит 30 тыс евро, надо 10 тыс"), the first-pass matcher has
  // already created it and the loops above intentionally skip duplicates.
  // Inherit the one explicit currency within that same clause instead.
  for (const mention of mentions) {
    if (mention.currency || (mention.roleCandidate !== "requestedAmount" && mention.roleCandidate !== "vehicleValue")) continue;
    if (!/(?:тыс|тыщ|\d\s*[кk](?=\s|$))/iu.test(mention.sourceText)) continue;
    const start = mention.start ?? 0;
    const clauseStart = Math.max(source.lastIndexOf(".", start - 1), source.lastIndexOf(";", start - 1)) + 1;
    const prior = mentions.filter((candidate) => (candidate.start ?? -1) >= clauseStart && (candidate.end ?? 0) <= start && candidate.currency);
    const currencies = new Set(prior.map((candidate) => candidate.currency));
    if (currencies.size === 1) mention.currency = prior.at(-1)?.currency ?? null;
  }

  return dedupeMentions(mentions);
}

export function formatMoney(value: number): string {
  return new Intl.NumberFormat("ru-RU").format(value).replace(/\u00a0/g, " ");
}

/** Public and persisted som amounts are normally rounded down to 10,000. */
export function roundSomAmount(value: number): number {
  if (!Number.isFinite(value)) return value;
  // Preserve a below-minimum amount exactly until the client confirms or
  // corrects it. Rounding 15,000 down to 10,000 changes the value being
  // clarified and makes a currency correction refer to the wrong amount.
  if (value > 0 && value < 50_000) return value;
  return Math.floor(value / 10_000) * 10_000;
}

export function formatSomMoney(value: number): string {
  return formatMoney(roundSomAmount(value));
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

  // Never copy an explicitly classified amount into the other lead-card
  // field. For example, "нужно 6 тысяч долларов" is only the requested loan
  // amount; it is not evidence of the vehicle's value.
  if (available.length === 1 && available[0].roleCandidate !== "unknown") {
    return undefined;
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
  if (normalized === "$" || /^(?:usd|dollars?|bucks?|дол+ар\p{L}*|дол|бакс\p{L}*)$/u.test(normalized)) return "USD";
  if (normalized === "€" || /^(?:eur(?:o)?s?|евр\p{L}*)$/u.test(normalized)) return "EUR";
  if (normalized === "₸" || /^(?:kzt|тенг\p{L}*)$/u.test(normalized)) return "KZT";
  if (normalized === "₽" || /^(?:rub(?:les?)?|руб\p{L}*)$/u.test(normalized)) return "RUB";
  if (/^сом\p{L}*$/u.test(normalized) || normalized === "kgs") return "KGS";
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
  const multiplier = normalizedUnit.startsWith("млн") || normalizedUnit.startsWith("слн") || normalizedUnit.startsWith("миллион") || normalizedUnit.startsWith("лям")
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
