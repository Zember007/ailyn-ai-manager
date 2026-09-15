/**
 * A short anaphoric turn has no topic of its own: its meaning is supplied by
 * the immediately preceding assistant answer. Keep this deliberately bounded
 * so an independent question such as «какая ставка?» continues through normal
 * knowledge routing instead of being attached to an unrelated prior answer.
 */
export function isContextualKnowledgeFollowUpText(text: string): boolean {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 160) return false;

  return /^(?:(?:а|и|ну|так)\s+)?(?:что\s+(?:мне\s+)?делать(?:\s+(?:дальше|теперь))?(?:\s*,?\s*если\s+(?:нет|не\s+получится|нельзя))?|что\s+(?:тогда|теперь)(?:\s+делать)?|как\s+(?:мне\s+)?(?:быть|поступить)|как\s+это\s+связан\p{L}*|как\s+тогда\s+оформить|если\s+(?:нет|не\s+получится|нельзя)|почему|зачем|без\s+этого|(?:и\s+)?что\s+теперь|такого\s+нет|другого\s+нет|нет\s+такого)[?!.,\s]*$/iu.test(normalized);
}
