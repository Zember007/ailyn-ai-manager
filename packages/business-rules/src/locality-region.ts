import { SOATE_LOCALITY_CATEGORIES } from "./kyrgyzstan-localities.generated.js";

/** The only residence categories used in loan-limit calculations. */
export type LoanResidenceCategory = "BISHKEK_CHUY" | "OTHER_KG";

export type LocalityRegionResolution = {
  category: LoanResidenceCategory;
  /** Human-readable administrative region for the lead card. */
  residenceRegion: "Бишкек" | "Чуйская область" | "Другой регион Кыргызстана";
  locality: string;
  match: "exact" | "transliteration" | "typo";
};

type MatchIndex = Map<string, Set<LoanResidenceCategory>>;

const cyrillicToLatin: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "sh", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  ң: "ng", ө: "o", ү: "u", қ: "k", ғ: "g", ҳ: "h"
};

function normalize(value: string): string {
  return value
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/\b(?:г(?:ород)?|с(?:ело)?|пгт|аил|айыл)\.?\s*/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function transliterate(value: string): string {
  return [...normalize(value)].map((character) => cyrillicToLatin[character] ?? character).join("");
}

function add(index: MatchIndex, value: string, category: LoanResidenceCategory): void {
  const key = normalize(value);
  if (!key) return;
  const categories = index.get(key) ?? new Set<LoanResidenceCategory>();
  categories.add(category);
  index.set(key, categories);
}

const exactIndex: MatchIndex = new Map();
const transliteratedIndex: MatchIndex = new Map();
for (const [name, category] of SOATE_LOCALITY_CATEGORIES) {
  add(exactIndex, name, category);
  add(transliteratedIndex, transliterate(name), category);
}

/** Misspellings observed in client chats. Keep this list small and auditable. */
const explicitAliases: Array<[string, LoanResidenceCategory]> = [
  ["такмок", "BISHKEK_CHUY"],
  ["такмоке", "BISHKEK_CHUY"],
  ["токмоке", "BISHKEK_CHUY"],
  ["беловодское", "BISHKEK_CHUY"],
  ["лебединовка", "BISHKEK_CHUY"],
  ["жалал абад", "OTHER_KG"],
  ["джалал абад", "OTHER_KG"],
  ["исфана", "OTHER_KG"],
  ["гульчо", "OTHER_KG"]
];
for (const [alias, category] of explicitAliases) {
  add(exactIndex, alias, category);
  add(transliteratedIndex, transliterate(alias), category);
}

const regionalWords: Array<[RegExp, LocalityRegionResolution]> = [
  [/(?:^|\s)(?:бишкек|bishkek)(?:$|\s)/u, { category: "BISHKEK_CHUY", residenceRegion: "Бишкек", locality: "Бишкек", match: "exact" }],
  [/(?:^|\s)(?:чу[йи](?:ская)?|chuy(?:skaya)?|chui(?:skaya)?)(?:$|\s)/u, { category: "BISHKEK_CHUY", residenceRegion: "Чуйская область", locality: "Чуйская область", match: "exact" }],
  [/(?:^|\s)(?:ошская|баткенская|нарынская|таласская|иссык кульская|жалал абадская|джалал абадская)(?:$|\s)/u, { category: "OTHER_KG", residenceRegion: "Другой регион Кыргызстана", locality: "Другой регион Кыргызстана", match: "exact" }]
];

export function resolveKyrgyzstanLocality(value: string | undefined): LocalityRegionResolution | undefined {
  if (!value) return undefined;
  const normalized = normalize(value);
  if (!normalized) return undefined;
  for (const [pattern, result] of regionalWords) if (pattern.test(normalized)) return result;

  const exact = resolveFromIndex(exactIndex, normalized);
  if (exact) return makeResolution(value, exact, "exact");

  const latin = transliterate(value);
  const transliterated = resolveFromIndex(transliteratedIndex, latin);
  if (transliterated) return makeResolution(value, transliterated, "transliteration");

  // Limit fuzzy matching to a single locality-sized client answer. This avoids
  // guessing a region from an arbitrary sentence while accepting "такмоке".
  if (normalized.split(" ").length > 2 || normalized.length < 5) return undefined;
  const candidates = [...exactIndex.entries()]
    .filter(([key]) => Math.abs(key.length - normalized.length) <= 2)
    .map(([key, categories]) => ({ key, categories, distance: levenshtein(normalized, key) }))
    .filter((candidate) => candidate.distance <= (normalized.length >= 6 ? 2 : 1))
    .sort((left, right) => left.distance - right.distance || right.key.length - left.key.length);
  if (!candidates.length || (candidates[1] && candidates[0].distance === candidates[1].distance)) return undefined;
  const category = oneCategory(candidates[0].categories);
  return category ? makeResolution(value, category, "typo") : undefined;
}

function resolveFromIndex(index: MatchIndex, value: string): LoanResidenceCategory | undefined {
  const direct = oneCategory(index.get(value));
  if (direct) return direct;
  const matches = [...index.entries()]
    .filter(([key]) => value === key || value.startsWith(`${key} `) || value.endsWith(` ${key}`) || value.includes(` ${key} `))
    .sort(([left], [right]) => right.length - left.length);
  return matches.length ? oneCategory(matches[0][1]) : undefined;
}

function oneCategory(categories: Set<LoanResidenceCategory> | undefined): LoanResidenceCategory | undefined {
  return categories?.size === 1 ? [...categories][0] : undefined;
}

function makeResolution(input: string, category: LoanResidenceCategory, match: LocalityRegionResolution["match"]): LocalityRegionResolution {
  const locality = normalize(input);
  const isBishkek = /(^|\s)(?:бишкек|bishkek)(?:\s|$)/u.test(locality);
  return {
    category,
    residenceRegion: category === "OTHER_KG" ? "Другой регион Кыргызстана" : isBishkek ? "Бишкек" : "Чуйская область",
    locality,
    match
  };
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(previous[column] + 1, previous[column - 1] + 1, diagonal + Number(left[row - 1] !== right[column - 1]));
      diagonal = above;
    }
  }
  return previous[right.length];
}
