import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../database/prisma.service.js";

export interface KnowledgeItemDto {
  id: string;
  key: string;
  category: string;
  aliases: string[];
  answerRu: string;
  answerKg?: string;
  conditions?: Record<string, unknown>;
  priority: number;
  status: "approved" | "blocked" | "draft";
  version: number;
  active: boolean;
}

const seeds: Omit<KnowledgeItemDto, "id">[] = [
  {
    key: "documents_required",
    category: "documents",
    aliases: ["какие документы", "что из документов", "что нужно взять"],
    answerRu: "Для оформления понадобятся:\n- ID (паспорт);\n- свидетельство о регистрации автомобиля;\n- нотариальное согласие супруга, если Вы состоите в браке. Нотариус находится в нашем здании, примерная стоимость оформления согласия — 1500 сом.",
    priority: 100,
    status: "approved",
    version: 2,
    active: true
  },
  {
    key: "existing_contract_redirect",
    category: "existing_contract",
    aliases: ["действующий договор", "оплата", "задолженность"],
    answerRu: "Я Айлин — виртуальный помощник по вопросам оформления новых займов. Если у Вас уже оформлен займ, пожалуйста, позвоните по телефону +996 502 108 108 или напишите в WhatsApp +996 776 108 108. Наши специалисты проверят информацию по Вашему договору и помогут решить Ваш вопрос.",
    priority: 100,
    status: "approved",
    version: 2,
    active: true
  },
  {
    key: "company_activity",
    category: "company",
    aliases: ["чем вы занимаетесь", "чем вы вообще занимаетесь", "чем вообще занимаетесь", "чем занимается компания", "что вы делаете", "какие услуги оказываете"],
    answerRu: "Мы оформляем новые займы под залог автомобиля.",
    priority: 100,
    status: "approved",
    version: 1,
    active: true
  },
  {
    key: "office_location",
    category: "office",
    aliases: ["адрес", "где вы", "где находится офис", "где ваш офис", "офис", "как доехать"],
    answerRu: "Наш офис находится на бульваре Молодой Гвардии, 22, в Бишкеке. Мы работаем с понедельника по пятницу с 11:00 до 19:00. Вы можете приехать в любое удобное время в рамках рабочего графика.\nhttps://go.2gis.com/Y34m4\nhttps://maps.app.goo.gl/9xiWLVvdyRgn3Sx4A",
    priority: 100,
    status: "approved",
    version: 1,
    active: true
  },
  {
    key: "without_seizure_rate",
    category: "loan_terms",
    aliases: ["ставка без изъятия", "процент без изъятия", "без изъятия процент"],
    answerRu: "По программе без изъятия автомобиль остаётся у Вас. Ставка определяется индивидуально после осмотра автомобиля и проверки документов.",
    priority: 90,
    status: "approved",
    version: 3,
    active: true
  },
  {
    key: "personal_presence",
    category: "loan_terms",
    aliases: ["лично приезжать", "по доверенности", "нужно присутствие собственника"],
    answerRu: "Нет, собственник автомобиля должен лично присутствовать при осмотре автомобиля и выдаче займа.",
    priority: 90,
    status: "approved",
    version: 1,
    active: true
  },
  {
    key: "unknown_fallback",
    category: "fallback",
    aliases: [],
    answerRu: "К сожалению, у меня нет достоверной информации по этому вопросу. Вы можете связаться с менеджером или приехать в офис — сотрудники с удовольствием подскажут Вам.",
    priority: 1,
    status: "approved",
    version: 2,
    active: true
  },
  {
    key: "parking_rate",
    category: "loan_terms",
    aliases: ["ставка по стоянке", "процент по стоянке", "стоянка процент", "парковка ставка", "что такое постановка на стоянку", "что значит постановка автомобиля", "как работает стоянка", "что такое охраняемая стоянка", "что вообще такое с постановкой автомобиля на охраняемую стоянку", "с постановкой автомобиля на охраняемую стоянку"],
    answerRu: "Программа со стоянкой означает, что на время займа автомобиль размещается на охраняемой парковке компании. Ставка составляет 2,4% в месяц, дополнительно оплачивается парковка 130 сом в сутки.",
    priority: 100, status: "approved", version: 3, active: true
  },
  {
    key: "loan_program_comparison",
    category: "loan_terms",
    aliases: ["чем отличается займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку", "чем отличается займ без", "чем отличается без изъятия", "без изъятия автомобиля или с постановкой", "без изъятия или с постановкой автомобиля", "разница программ займа", "сравнить программы займа", "а без изъятия"],
    answerRu: "По программе без изъятия автомобиль остаётся у Вас, а ставка определяется индивидуально после осмотра и проверки документов. По программе со стоянкой автомобиль размещается на охраняемой парковке компании; ставка составляет 2,4% в месяц, дополнительно оплачивается парковка 130 сом в сутки.",
    priority: 120,
    status: "approved",
    version: 2,
    active: true
  },
  {
    key: "interest_rates_overview",
    category: "loan_terms",
    aliases: ["какие ставки", "какой процент", "какие проценты", "условия по процентам", "процентная ставка", "какая процентная ставка", "какая у вас процентная ставка"],
    answerRu: "По программе без изъятия ставка определяется индивидуально после осмотра автомобиля. По программе со стоянкой ставка составляет 2,4% в месяц, дополнительно оплачивается парковка 130 сом в сутки.",
    priority: 80, status: "approved", version: 2, active: true
  },
  {
    key: "remote_application",
    category: "process",
    aliases: ["дистанционно", "онлайн оформление", "без приезда"],
    answerRu: "Нет, собственник автомобиля должен лично присутствовать при осмотре автомобиля и выдаче займа.",
    priority: 100, status: "approved", version: 1, active: true
  },
  {
    key: "processing_duration",
    category: "process",
    aliases: ["сколько занимает оформление", "как долго оформлять", "время оформления"],
    answerRu: "Обычно оформление занимает 1 час. Присланные Вами документы помогут нам сократить время выдачи денег.",
    priority: 90, status: "approved", version: 1, active: true
  },
  {
    key: "money_disbursement_time",
    category: "process",
    aliases: ["когда выдаются деньги", "когда получу деньги"],
    answerRu: "Сразу после осмотра автомобиля и подписания договора займа. Как правило, вся процедура занимает около 1 часа.",
    priority: 90, status: "approved", version: 1, active: true
  },
  {
    key: "cash_only",
    category: "finance",
    aliases: ["на карту", "безнал", "наличными", "способ выдачи"],
    answerRu: "Займ выдаётся только наличными в кыргызских сомах. На банковскую карту займ не выдаётся.",
    priority: 90, status: "approved", version: 1, active: true
  },
  {
    key: "early_repayment",
    category: "finance",
    aliases: ["досрочно погасить", "досрочное погашение"],
    answerRu: "Да, можно. Подробный расчет суммы к погашению мы сделаем на дату закрытия займа. При этом если с момента займа прошло меньше месяца, то оплатить % придется за месяц. При закрытии займа начиная с 31 дня оплата процентов рассчитывается день в день.",
    priority: 90, status: "approved", version: 1, active: true
  },
  {
    key: "partial_repayment",
    category: "finance",
    aliases: ["частично погасить", "частичное погашение"],
    answerRu: "Да, возможно частично гасить займ. В таком случае Вам не придется платить лишние проценты.",
    priority: 90, status: "approved", version: 1, active: true
  },
  {
    key: "loan_term",
    category: "finance",
    aliases: ["срок займа", "на какой срок", "продлить договор", "продление займа"],
    answerRu: "Срок займа — 30 дней, после чего нужно оплатить проценты за пользование займом. Далее займ можно продлевать, ежемесячно оплачивая проценты.",
    priority: 90, status: "approved", version: 1, active: true
  },
  {
    key: "gps_requirement",
    category: "loan_terms",
    aliases: ["gps", "трекер", "маячок"],
    answerRu: "Это зависит от суммы займа и состояния автомобиля. Точно ответить сможем после осмотра автомобиля.",
    priority: 80, status: "approved", version: 1, active: true
  },
  {
    key: "second_key",
    category: "documents",
    aliases: ["второй ключ", "запасной ключ"],
    answerRu: "Нет, он нам не нужен.",
    priority: 90, status: "approved", version: 1, active: true
  },
  {
    key: "same_day_application",
    category: "process",
    aliases: ["оформить сегодня", "получить сегодня", "можно ли приехать сегодня", "приехать сегодня", "можно приехать сегодня"],
    answerRu: "Если офис работает и документы в порядке, оформление возможно в день обращения. Мы работаем до 19:00. Вам надо подъехать до 18:00, чтобы успеть всё оформить.",
    priority: 90, status: "approved", version: 2, active: true
  },
  {
    key: "vehicle_inspection",
    category: "process",
    aliases: ["как проходит осмотр", "нужна сто", "сколько длится оценка", "оценка платная"],
    answerRu: "Проводятся внешний осмотр автомобиля и проверка документов. СТО не требуется, осмотр обычно занимает около 5 минут. Окончательная оценка проводится при визите в офис.",
    priority: 80, status: "approved", version: 1, active: true
  },
  {
    key: "registration_original_required",
    category: "documents",
    aliases: ["без техпаспорта", "без свидетельства о регистрации", "нет техпаспорта"],
    answerRu: "К сожалению, мы не сможем Вам выдать займ без оригинала свидетельства о регистрации.",
    priority: 100, status: "approved", version: 1, active: true
  },
  {
    key: "tunduk_identity",
    category: "documents",
    aliases: ["нет паспорта", "нет id", "түндүк", "tunduk"],
    answerRu: "Вы можете использовать приложение Tunduk для идентификации личности.",
    priority: 90, status: "approved", version: 1, active: true
  },
  {
    key: "credit_history",
    category: "eligibility",
    aliases: ["кредитная история", "плохая кредитная история"],
    answerRu: "Кредитная история не влияет на рассмотрение заявки.",
    priority: 90, status: "approved", version: 1, active: true
  },
  {
    key: "income_documents",
    category: "eligibility",
    aliases: ["справка о доходах", "официальная работа", "безработный"],
    answerRu: "Официальная работа и справка о доходах для оформления не требуются.",
    priority: 90, status: "approved", version: 1, active: true
  },
  {
    key: "temporary_residence",
    category: "eligibility",
    aliases: ["временная прописка", "временная регистрация"],
    answerRu: "Да, оформление по временной прописке возможно.",
    priority: 90, status: "approved", version: 1, active: true
  },
  {
    key: "documents_in_advance",
    category: "documents",
    aliases: ["документы заранее", "отправить фото документов", "привезти документы заранее"],
    answerRu: "Да, можно предварительно привезти или отправить фотографии документов в WhatsApp.",
    priority: 90, status: "approved", version: 1, active: true
  },
  {
    key: "vehicle_cleanliness",
    category: "process",
    aliases: ["мыть авто", "машина грязная", "грязный автомобиль"],
    answerRu: "Желательно, чтобы автомобиль был чистым — так его проще оценить. Но это не обязательно.",
    priority: 80, status: "approved", version: 1, active: true
  },
  {
    key: "document_privacy",
    category: "documents",
    aliases: ["конфиденциальность документов", "безопасно отправлять документы", "куда пойдут документы"],
    answerRu: "Да. Полученные документы используются только для рассмотрения заявки и оформления займа.",
    priority: 90, status: "approved", version: 1, active: true
  },
  {
    key: "parking_details",
    category: "office",
    aliases: ["где стоянка", "посмотреть парковку", "охраняемая стоянка"],
    answerRu: "Вопрос осмотра парковки решается непосредственно с менеджером при Вашем визите в офис. Во время оформления займа менеджер подробно расскажет об условиях хранения автомобиля и ответит на все Ваши вопросы.",
    priority: 80, status: "approved", version: 1, active: true
  },
  {
    key: "walk_in_visit",
    category: "visit",
    aliases: ["без записи", "можно приехать просто так"],
    answerRu: "Да, но для сокращения ожидания лучше заранее сообщить время приезда.",
    priority: 80, status: "approved", version: 1, active: true
  },
  {
    key: "notary",
    category: "documents",
    aliases: ["нотариус", "нотариальное согласие где"],
    answerRu: "Нотариус находится в нашем здании и работает в рабочие дни с 11:00 до 18:00. Примерная стоимость нотариального согласия — 1500 сом.",
    priority: 90, status: "approved", version: 1, active: true
  },
  {
    key: "spouse_consent_purpose",
    category: "documents",
    aliases: ["spouse_consent_purpose", "зачем нотариальное согласие", "для чего нотариальное согласие"],
    answerRu: "Нотариальное согласие требуется только если собственник автомобиля состоит в браке. Оно подтверждает, что супруг или супруга не возражает против оформления займа под залог автомобиля.",
    priority: 95, status: "approved", version: 1, active: true
  },
  {
    key: "foreign_currency_disbursement",
    category: "finance",
    aliases: ["займ в долларах", "выдаёте доллары", "в иностранной валюте"],
    answerRu: "Нет. Займы выдаются только в кыргызских сомах наличными.",
    priority: 100, status: "approved", version: 1, active: true
  },
  {
    key: "office_coffee", category: "office", aliases: ["есть ли кофе", "есть кофе", "чай и кофе"],
    answerRu: "Да, для наших клиентов есть чай и кофе.", priority: 80, status: "approved", version: 1, active: true
  },
  {
    key: "office_restroom", category: "office", aliases: ["есть ли туалет", "есть туалет"],
    answerRu: "Да, туалет для посетителей есть.", priority: 80, status: "approved", version: 1, active: true
  },
  {
    key: "office_parking", category: "office", aliases: ["есть ли парковка", "парковка рядом", "где припарковаться"],
    answerRu: "Да, рядом с офисом есть место для парковки автомобилей.", priority: 80, status: "approved", version: 1, active: true
  },
  {
    key: "office_visitors", category: "office", aliases: ["с ребёнком", "с ребенком", "с собакой", "вдвоём", "вдвоем"],
    answerRu: "Да, конечно. С собакой можно, если это не создаёт неудобств другим посетителям.", priority: 80, status: "approved", version: 1, active: true
  },
  {
    key: "office_wifi_charging", category: "office", aliases: ["есть wi-fi", "есть wifi", "зарядить телефон", "зарядка телефона"],
    answerRu: "Да, для посетителей доступен Wi-Fi; при необходимости поможем зарядить телефон.", priority: 80, status: "approved", version: 1, active: true
  },
  {
    key: "office_waiting_water", category: "office", aliases: ["есть место подождать", "зона ожидания", "можно воды", "есть кулер", "подождать в помещении"],
    answerRu: "Да, у нас есть зона ожидания, вода и кулер для посетителей.", priority: 80, status: "approved", version: 1, active: true
  },
  {
    key: "cash_payment", category: "finance", aliases: ["можно оплатить картой", "оплата картой"],
    answerRu: "Нет, мы выдаем займ наличными и принимаем оплату также наличными в офисе компании.", priority: 90, status: "approved", version: 1, active: true
  },
  {
    key: "nearby_services", category: "office", aliases: ["банкомат рядом", "есть обмен валют", "обмен валют рядом", "нотариус рядом"],
    answerRu: "Нотариус находится в нашем здании. Ближайший банкомат — в 5–6 минутах ходьбы, обмен валют — примерно в 5–10 минутах пешком.", priority: 80, status: "approved", version: 1, active: true
  },
  {
    key: "visit_flexibility", category: "visit", aliases: ["если опоздаю", "можно приехать вечером", "можно приехать в выходной", "можно приехать раньше", "можно приехать позже", "есть ли очередь"],
    answerRu: "Сообщите нам, если время изменится. В выходные мы не работаем; в рабочие дни можно приехать с 11:00 до 18:00. Точную очередь заранее гарантировать нельзя, но можно согласовать удобное время.", priority: 80, status: "approved", version: 1, active: true
  }
];

@Injectable()
export class KnowledgeService {
  constructor(private readonly prisma: PrismaService) {}

  private legacySchemaPromise?: Promise<LegacyKnowledgeSchema>;

  async list(): Promise<KnowledgeItemDto[]> {
    await this.ensureSeeds();
    const items = await this.prisma.knowledgeItem.findMany({ orderBy: [{ priority: "desc" }, { key: "asc" }] });
    return items.map((item) => ({
      id: item.id,
      key: item.key,
      category: item.category,
      aliases: Array.isArray(item.aliases) ? item.aliases.map(String) : [],
      answerRu: item.answerRu,
      answerKg: item.answerKg ?? undefined,
      conditions: asRecord(item.conditions),
      priority: item.priority,
      status: item.status as KnowledgeItemDto["status"],
      version: item.version,
      active: item.active
    }));
  }

  async upsert(item: Omit<KnowledgeItemDto, "id" | "version"> & { id?: string; version?: number }): Promise<KnowledgeItemDto> {
    const current = item.id
      ? await this.prisma.knowledgeItem.findUnique({ where: { id: item.id } })
      : await this.prisma.knowledgeItem.findUnique({ where: { key: item.key } });
    const saved = current
      ? await this.prisma.knowledgeItem.update({
        where: { key: current.key },
        data: {
          category: item.category,
          aliases: item.aliases,
          answerRu: item.answerRu,
          answerKg: item.answerKg,
          conditions: toJson(item.conditions ?? {}),
          priority: item.priority,
          status: item.status,
          version: { increment: 1 },
          active: item.active
        }
      })
      : await this.createKnowledgeItem({
        key: item.key,
        category: item.category,
        aliases: item.aliases,
        answerRu: item.answerRu,
        answerKg: item.answerKg,
        conditions: item.conditions,
        priority: item.priority,
        status: item.status,
        version: 1,
        active: item.active
      });
    return {
      id: saved.id,
      key: saved.key,
      category: saved.category,
      aliases: Array.isArray(saved.aliases) ? saved.aliases.map(String) : [],
      answerRu: saved.answerRu,
      answerKg: saved.answerKg ?? undefined,
      conditions: asRecord(saved.conditions),
      priority: saved.priority,
      status: saved.status as KnowledgeItemDto["status"],
      version: saved.version,
      active: saved.active
    };
  }

  async resolveAll(question: string, language: "ru" | "kg"): Promise<KnowledgeItemDto[]> {
    await this.ensureSeeds();
    const items = await this.list();
    const approved = items.filter((item) => item.active && item.status === "approved");
    const segments = splitQuestion(question);
    const matched = deduplicateItems(
      segments.flatMap((segment) => {
        const candidates = approved
          .map((item) => ({ item, score: aliasScore(item, segment) }))
          .filter((candidate) => candidate.score > 0)
          .sort((a, b) => b.score - a.score || b.item.priority - a.item.priority);
        const bestByCategory = new Map<string, KnowledgeItemDto>();
        for (const candidate of candidates) {
          if (!bestByCategory.has(candidate.item.category)) {
            bestByCategory.set(candidate.item.category, candidate.item);
          }
        }
        return [...bestByCategory.values()];
      })
    );
    if (language === "kg") {
      // SPEC_GAP_C9: no machine-generated replacement for an approved fixed answer.
      return matched;
    }
    return matched;
  }

  async fallback(): Promise<KnowledgeItemDto> {
    await this.ensureSeeds();
    const item = (await this.list()).find((entry) => entry.key === "unknown_fallback");
    if (!item) throw new Error("knowledge fallback seed is missing");
    return item;
  }

  private async ensureSeeds(): Promise<void> {
    for (const seed of seeds) {
      const existing = await this.prisma.knowledgeItem.findUnique({ where: { key: seed.key } });
      if (!existing) {
        await this.createKnowledgeItem({
          key: seed.key,
          category: seed.category,
          aliases: seed.aliases,
          answerRu: seed.answerRu,
          answerKg: seed.answerKg,
          conditions: seed.conditions,
          priority: seed.priority,
          status: seed.status,
          version: seed.version,
          active: seed.active
        });
      } else if (existing.version < seed.version) {
        await this.prisma.knowledgeItem.update({
          where: { key: seed.key },
          data: {
            category: seed.category,
            aliases: seed.aliases,
            answerRu: seed.answerRu,
            answerKg: seed.answerKg,
            conditions: toJson(seed.conditions ?? {}),
            priority: seed.priority,
            status: seed.status,
            version: seed.version,
            active: seed.active
          }
        });
      }
    }
  }

  private async createKnowledgeItem(item: Omit<KnowledgeItemDto, "id">) {
    const schema = await this.getLegacyKnowledgeSchema();
    if (!schema.requiresTitle && !schema.hasBody) {
      return this.prisma.knowledgeItem.create({
        data: {
          key: item.key,
          category: item.category,
          aliases: item.aliases,
          answerRu: item.answerRu,
          answerKg: item.answerKg,
          conditions: toJson(item.conditions ?? {}),
          priority: item.priority,
          status: item.status,
          version: item.version,
          active: item.active
        }
      });
    }

    const now = new Date();
    const id = randomUUID();
    const fields = [
      `"id"`,
      `"key"`,
      `"category"`,
      `"aliases"`,
      `"answerRu"`,
      `"answerKg"`,
      `"conditions"`,
      `"priority"`,
      `"status"`,
      `"version"`,
      `"active"`,
      `"metadata"`,
      `"createdAt"`,
      `"updatedAt"`
    ];
    const values: unknown[] = [
      id,
      item.key,
      item.category,
      toJsonText(item.aliases),
      item.answerRu,
      item.answerKg ?? null,
      toJsonText(item.conditions ?? {}),
      item.priority,
      item.status,
      item.version,
      item.active,
      toJsonText({}),
      now,
      now
    ];

    if (schema.requiresTitle) {
      fields.push(`"title"`);
      values.push(item.key);
    }
    if (schema.hasBody) {
      fields.push(`"body"`);
      values.push(item.answerRu);
    }

    const placeholders = values.map((_, index) => {
      const placeholder = `$${index + 1}`;
      const field = fields[index];
      if (field === `"aliases"` || field === `"conditions"` || field === `"metadata"`) {
        return `${placeholder}::jsonb`;
      }
      return placeholder;
    }).join(", ");
    const rows = await this.prisma.$queryRawUnsafe<Array<KnowledgeItemRow>>(
      `INSERT INTO "KnowledgeItem" (${fields.join(", ")}) VALUES (${placeholders}) RETURNING "id", "key", "category", "aliases", "answerRu", "answerKg", "conditions", "priority", "status", "version", "active"`,
      ...values
    );
    return rows[0];
  }

  private async getLegacyKnowledgeSchema(): Promise<LegacyKnowledgeSchema> {
    this.legacySchemaPromise ??= this.loadLegacyKnowledgeSchema();
    return this.legacySchemaPromise;
  }

  private async loadLegacyKnowledgeSchema(): Promise<LegacyKnowledgeSchema> {
    if (!("$queryRawUnsafe" in this.prisma) || typeof this.prisma.$queryRawUnsafe !== "function") {
      return { requiresTitle: false, hasBody: false };
    }

    const rows = await this.prisma.$queryRawUnsafe<Array<{ column_name: string; is_nullable: "YES" | "NO" }>>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'KnowledgeItem'
         AND column_name IN ('title', 'body')`
    );

    const title = rows.find((row) => row.column_name === "title");
    return {
      requiresTitle: title?.is_nullable === "NO",
      hasBody: rows.some((row) => row.column_name === "body")
    };
  }
}

interface LegacyKnowledgeSchema {
  requiresTitle: boolean;
  hasBody: boolean;
}

interface KnowledgeItemRow {
  id: string;
  key: string;
  category: string;
  aliases: unknown;
  answerRu: string;
  answerKg: string | null;
  conditions: unknown;
  priority: number;
  status: string;
  version: number;
  active: boolean;
}

function splitQuestion(question: string): string[] {
  return question
    .toLocaleLowerCase("ru-RU")
    .split(/(?:[?!;,]+|\s+и\s+(?=(?:какие?|где|сколько|можно|нуж|есть|работ)))/i)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function aliasScore(item: KnowledgeItemDto, segment: string): number {
  const aliases = item.aliases.map((alias) => alias.toLocaleLowerCase("ru-RU"));
  if (item.key === "office_location" && /(?:где|адрес|как доехать).*(?:офис|находит)|(?:офис|адрес).*(?:где|как)/i.test(segment)) {
    aliases.push("офис адрес");
  }
  return aliases.reduce((best, alias) => segment.includes(alias) ? Math.max(best, alias.length) : best, 0);
}

function deduplicateItems(items: KnowledgeItemDto[]): KnowledgeItemDto[] {
  return items.filter((item, index) => items.findIndex((candidate) => candidate.key === item.key) === index);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function toJsonText(value: unknown): string {
  return JSON.stringify(value ?? {});
}
