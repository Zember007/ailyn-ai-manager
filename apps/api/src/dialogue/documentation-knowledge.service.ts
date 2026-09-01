import { Injectable } from "@nestjs/common";
import { generatedDocumentationChunks } from "./documentation-chunks.generated.js";

export interface DocumentationAnswer {
  key: string;
  text: string;
}

interface DocumentationChunk extends DocumentationAnswer {
  keywords: readonly string[];
}

// Curated, versioned chunks from the approved "АЙЛИН 6.2" operating document.
// They are deliberately bounded runtime knowledge, rather than the complete
// document being supplied to a model prompt. Add a chunk when the approved
// document gains a new client-facing answer.
const chunks: DocumentationChunk[] = [
  {
    key: "company_purpose",
    keywords: ["компания", "занимается", "делаете", "услуги", "автоломбард", "займ", "залог"],
    text: "Автоломбард «Молодой» оформляет новые займы под залог автомобиля."
  },
  {
    key: "parking_program_explained",
    keywords: ["постановка", "стоянка", "парковка", "охраняемая", "изъятие", "автомобиль"],
    text: "Программа со стоянкой означает, что на время займа автомобиль размещается на охраняемой парковке компании. Ставка составляет 2,4% в месяц, дополнительно оплачивается парковка 130 сом в сутки; предварительная сумма — до 2 000 000 сом."
  },
  {
    key: "documents_for_application",
    keywords: ["документы", "паспорт", "id", "техпаспорт", "свидетельство", "принести"],
    text: "Для оформления понадобятся ID (паспорт), свидетельство о регистрации автомобиля и, если Вы состоите в браке, нотариальное согласие супруга или супруги."
  },
  {
    key: "application_process",
    keywords: ["как", "оформление", "проходит", "осмотр", "оценка", "деньги", "время"],
    text: "Сначала проводятся осмотр автомобиля и проверка документов. Осмотр обычно занимает около 5 минут; после осмотра и подписания договора займ выдаётся наличными. Вся процедура обычно занимает около 1 часа."
  },
  {
    key: "personal_presence",
    keywords: ["доверенность", "лично", "собственник", "присутствие", "приехать"],
    text: "Собственник автомобиля должен лично присутствовать при осмотре автомобиля и выдаче займа."
  },
  {
    key: "office_visit",
    keywords: ["адрес", "офис", "где", "приехать", "работаете", "график"],
    text: "Офис находится на бульваре Молодой Гвардии, 22, в Бишкеке. Мы работаем с понедельника по пятницу с 11:00 до 19:00; для оформления лучше приехать до 18:00."
  }
];

@Injectable()
export class DocumentationKnowledgeService {
  resolve(question: string): DocumentationAnswer | undefined {
    const tokens = meaningfulTokens(question);
    if (tokens.length === 0) return undefined;

    const curated = chunks.map((chunk) => ({ chunk, score: scoreChunk(chunk, tokens) })).sort((left, right) => right.score - left.score)[0];
    const generated = generatedDocumentationChunks
      .map((chunk) => ({ chunk, score: scoreChunk(chunk, tokens) }))
      .sort((left, right) => right.score - left.score)[0];
    const best = curated && curated.score >= 2 ? curated : generated;
    // One exact high-signal term (for example "стоянка") is enough; generic
    // wording needs two independent matches to avoid inventing an answer.
    if (!best || best.score < (best === generated ? 4 : 2)) return undefined;
    return { key: `documentation_${best.chunk.key}`, text: best.chunk.text };
  }
}

function meaningfulTokens(value: string): string[] {
  const stop = new Set(["а", "и", "в", "на", "с", "по", "не", "что", "как", "какая", "какой", "какие", "где", "когда", "сколько", "почему", "это", "вы", "вообще", "понял", "поняла", "мне", "у", "ли", "чем"]);
  return [...new Set((value.toLocaleLowerCase("ru-RU").match(/[\p{L}\p{N}]{3,}/gu) ?? [])
    .filter((token) => !stop.has(token)))];
}

function scoreChunk(chunk: DocumentationChunk, tokens: string[]): number {
  return tokens.reduce((score, token) => {
    const matched = chunk.keywords.some((keyword) => keyword.startsWith(token) || token.startsWith(keyword));
    return score + (matched ? 2 : 0);
  }, 0);
}
