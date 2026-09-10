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

/**
 * The index keeps the SOATE spelling alongside its business category.  A set
 * of categories alone is not enough: after accepting a typo we must persist
 * the canonical locality, not the client's misspelling.
 */
type IndexedLocality = { canonical: string; category: LoanResidenceCategory };
type MatchIndex = Map<string, Map<string, Set<LoanResidenceCategory>>>;

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
    // Client replies commonly begin with a preposition: «в Чолпон-Ате».
    // It is not part of a locality name and must not disable typo matching.
    .replace(/^(?:в|из|на)\s+/u, "")
    .replace(/\s+/gu, " ");
}

function transliterate(value: string): string {
  return [...normalize(value)].map((character) => cyrillicToLatin[character] ?? character).join("");
}

function add(index: MatchIndex, value: string, canonical: string, category: LoanResidenceCategory): void {
  const key = normalize(value);
  if (!key) return;
  const localities = index.get(key) ?? new Map<string, Set<LoanResidenceCategory>>();
  const categories = localities.get(canonical) ?? new Set<LoanResidenceCategory>();
  categories.add(category);
  localities.set(canonical, categories);
  index.set(key, localities);
}

const exactIndex: MatchIndex = new Map();
const transliteratedIndex: MatchIndex = new Map();
for (const [name, category] of SOATE_LOCALITY_CATEGORIES) {
  add(exactIndex, name, name, category);
  add(transliteratedIndex, transliterate(name), name, category);
}

/**
 * Canonical administrative entities supplementing the locality-level SOATE
 * extract: oblasts, districts, city districts and renamed places. These are
 * valid registration answers in their own right. Spelling variants do not
 * live here: the AI normalizer owns that task.
 */
const supplementaryAdministrativeLocalities: Array<[name: string, category: LoanResidenceCategory]> = [
  // Бишкек and Чуйская область
  ["Чуйская область", "BISHKEK_CHUY"], ["Аламудунский район", "BISHKEK_CHUY"],
  ["Жайылский район", "BISHKEK_CHUY"], ["Кеминский район", "BISHKEK_CHUY"],
  ["Московский район", "BISHKEK_CHUY"], ["Панфиловский район", "BISHKEK_CHUY"],
  ["Сокулукский район", "BISHKEK_CHUY"], ["Чуйский район", "BISHKEK_CHUY"],
  ["Ысык-Атинский район", "BISHKEK_CHUY"], ["Иссык-Атинский район", "BISHKEK_CHUY"],
  ["Ленинский район Бишкек", "BISHKEK_CHUY"], ["Октябрьский район Бишкек", "BISHKEK_CHUY"],
  ["Первомайский район Бишкек", "BISHKEK_CHUY"], ["Свердловский район Бишкек", "BISHKEK_CHUY"],

  // Иссык-Кульская область
  ["Иссык-Кульская область", "OTHER_KG"], ["Ысык-Кульская область", "OTHER_KG"],
  ["Ак-Суйский район", "OTHER_KG"], ["Джети-Огузский район", "OTHER_KG"],
  ["Жети-Огузский район", "OTHER_KG"], ["Иссык-Кульский район", "OTHER_KG"],
  ["Тонский район", "OTHER_KG"], ["Тюпский район", "OTHER_KG"],

  // Джалал-Абадская область
  ["Джалал-Абадская область", "OTHER_KG"], ["Жалал-Абадская область", "OTHER_KG"],
  ["Аксыйский район", "OTHER_KG"], ["Ала-Букинский район", "OTHER_KG"],
  ["Базар-Коргонский район", "OTHER_KG"], ["Чаткальский район", "OTHER_KG"],
  ["Ноокенский район", "OTHER_KG"], ["Сузакский район", "OTHER_KG"],
  ["Тогуз-Тороуский район", "OTHER_KG"], ["Токтогульский район", "OTHER_KG"],

  // Нарынская область
  ["Нарынская область", "OTHER_KG"], ["Ак-Талинский район", "OTHER_KG"],
  ["Ат-Башинский район", "OTHER_KG"], ["Жумгальский район", "OTHER_KG"],
  ["Кочкорский район", "OTHER_KG"], ["Нарынский район", "OTHER_KG"],

  // Ошская область
  ["Ошская область", "OTHER_KG"], ["Алайский район", "OTHER_KG"],
  ["Араванский район", "OTHER_KG"], ["Кара-Кульджинский район", "OTHER_KG"],
  ["Кара-Суйский район", "OTHER_KG"], ["Ноокатский район", "OTHER_KG"],
  ["Узгенский район", "OTHER_KG"], ["Чон-Алайский район", "OTHER_KG"],

  // Баткенская область
  ["Баткенская область", "OTHER_KG"], ["Баткенский район", "OTHER_KG"],
  ["Кадамжайский район", "OTHER_KG"], ["Лейлекский район", "OTHER_KG"],

  // Таласская область
  ["Таласская область", "OTHER_KG"], ["Бакай-Атинский район", "OTHER_KG"],
  ["Кара-Бууринский район", "OTHER_KG"], ["Манасский район", "OTHER_KG"],
  ["Таласский район", "OTHER_KG"],

  // Canonical locations absent from or renamed after a SOATE source extract.
  ["Беловодское", "BISHKEK_CHUY"], ["Лебединовка", "BISHKEK_CHUY"],
  ["Бостери", "OTHER_KG"],
  ["Раззаков", "OTHER_KG"]
];
for (const [name, category] of supplementaryAdministrativeLocalities) {
  add(exactIndex, name, name, category);
  add(transliteratedIndex, transliterate(name), name, category);
}

// «Бир Булак» is a frequent spoken/spelled variant of the SOATE locality
// «Бер-Булак». Keep the official name in the card while accepting the forms
// clients use in an explicit registration correction, including the common
// prepositional ending «в Бир Булаке».
for (const alias of ["Бир-Булак", "Бир-Булаке"]) {
  add(exactIndex, alias, "Бер-Булак", "BISHKEK_CHUY");
  add(transliteratedIndex, transliterate(alias), "Бер-Булак", "BISHKEK_CHUY");
}

// The client-facing spelling «Кашка-Суу» is used in existing applications
// and dialogue examples. Accept its spaced form too, without depending on a
// prose-model spelling repair before the residence stage can close.
for (const alias of ["Кашка-Суу", "Кашка Суу"]) {
  add(exactIndex, alias, "Кашка-Суу", "OTHER_KG");
  add(transliteratedIndex, transliterate(alias), "Кашка-Суу", "OTHER_KG");
}

const regionalWords: Array<[RegExp, LocalityRegionResolution]> = [
  [/(?:^|\s)(?:бишкек(?:е|а)?|bishkek)(?:$|\s)/u, { category: "BISHKEK_CHUY", residenceRegion: "Бишкек", locality: "Бишкек", match: "exact" }],
  [/(?:^|\s)(?:чу[йи](?:ская)?|chuy(?:skaya)?|chui(?:skaya)?)(?:$|\s)/u, { category: "BISHKEK_CHUY", residenceRegion: "Чуйская область", locality: "Чуйская область", match: "exact" }],
  [/(?:^|\s)ошская(?:\s+область)?(?:$|\s)/u, { category: "OTHER_KG", residenceRegion: "Другой регион Кыргызстана", locality: "Ошская область", match: "exact" }],
  [/(?:^|\s)баткенская(?:\s+область)?(?:$|\s)/u, { category: "OTHER_KG", residenceRegion: "Другой регион Кыргызстана", locality: "Баткенская область", match: "exact" }],
  [/(?:^|\s)нарынская(?:\s+область)?(?:$|\s)/u, { category: "OTHER_KG", residenceRegion: "Другой регион Кыргызстана", locality: "Нарынская область", match: "exact" }],
  [/(?:^|\s)таласская(?:\s+область)?(?:$|\s)/u, { category: "OTHER_KG", residenceRegion: "Другой регион Кыргызстана", locality: "Таласская область", match: "exact" }],
  [/(?:^|\s)(?:иссык|ысык) куль(?:ская)?(?:\s+область)?(?:$|\s)/u, { category: "OTHER_KG", residenceRegion: "Другой регион Кыргызстана", locality: "Иссык-Кульская область", match: "exact" }],
  [/(?:^|\s)(?:жалал|джалал) абад(?:ская)?(?:\s+область)?(?:$|\s)/u, { category: "OTHER_KG", residenceRegion: "Другой регион Кыргызстана", locality: "Джалал-Абадская область", match: "exact" }]
];

export function resolveKyrgyzstanLocality(value: string | undefined): LocalityRegionResolution | undefined {
  if (!value) return undefined;
  const normalized = normalize(value);
  if (!normalized) return undefined;

  const exact = resolveFromIndex(exactIndex, normalized);
  if (exact) return makeResolution(exact, "exact");

  const latin = transliterate(value);
  const transliterated = resolveFromIndex(transliteratedIndex, latin);
  if (transliterated) return makeResolution(transliterated, "transliteration");

  // A specific administrative locality wins over a broad region word, e.g.
  // «Свердловский район Бишкек» must not collapse to just «Бишкек».
  for (const [pattern, result] of regionalWords) if (pattern.test(normalized)) return result;

  // Limit fuzzy matching to a single locality-sized client answer. This avoids
  // guessing a region from an arbitrary sentence while accepting "такмоке".
  if (normalized.split(" ").length > 2 || normalized.length < 5) return undefined;
  const candidates = [...exactIndex.entries()]
    .filter(([key]) => Math.abs(key.length - normalized.length) <= 2)
    .map(([key, localities]) => ({ key, localities, distance: levenshtein(normalized, key) }))
    .filter((candidate) => candidate.distance <= (normalized.length >= 6 ? 2 : 1))
    .sort((left, right) => left.distance - right.distance || right.key.length - left.key.length);
  if (!candidates.length || (candidates[1] && candidates[0].distance === candidates[1].distance)) return undefined;
  const locality = oneLocality(candidates[0].localities);
  return locality ? makeResolution(locality, "typo") : undefined;
}

/** Returns the server-confirmed SOATE spelling for an accepted locality. */
export function normalizeKyrgyzstanLocality(value: string | undefined): string | undefined {
  return resolveKyrgyzstanLocality(value)?.locality;
}

function resolveFromIndex(index: MatchIndex, value: string): IndexedLocality | undefined {
  const direct = oneLocality(index.get(value));
  if (direct) return direct;
  const matches = [...index.entries()]
    .filter(([key]) => value === key || value.startsWith(`${key} `) || value.endsWith(` ${key}`) || value.includes(` ${key} `))
    .sort(([left], [right]) => right.length - left.length);
  return matches.length ? oneLocality(matches[0][1]) : undefined;
}

function oneLocality(localities: Map<string, Set<LoanResidenceCategory>> | undefined): IndexedLocality | undefined {
  if (!localities) return undefined;
  const candidates = [...localities.entries()]
    .flatMap(([canonical, categories]) => [...categories].map((category) => ({ canonical, category })));
  if (new Set(candidates.map((candidate) => candidate.category)).size !== 1) return undefined;
  // Duplicate names within the same category remain safe for eligibility;
  // use the first official SOATE spelling as the canonical display value.
  return candidates[0];
}

function makeResolution(locality: IndexedLocality, match: LocalityRegionResolution["match"]): LocalityRegionResolution {
  const isBishkek = /(^|\s)(?:бишкек|bishkek)(?:\s|$)/u.test(normalize(locality.canonical));
  return {
    category: locality.category,
    residenceRegion: locality.category === "OTHER_KG" ? "Другой регион Кыргызстана" : isBishkek ? "Бишкек" : "Чуйская область",
    locality: locality.canonical,
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
