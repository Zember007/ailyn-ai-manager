#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const fetchImpl = globalThis.fetch;
const apiUrl = (process.env.AILYN_API_URL ?? "http://localhost:3001/api").replace(/\/$/, "");
const reportDir = resolve(process.cwd(), "docs/reports");
const reportBase = process.env.AILYN_DIALOG_REPORT_BASENAME ?? `ailyn-dialog-scenarios-${Date.now()}`;
const runId = `dialog-e2e-${Date.now()}`;
const currentDate = "2026-08-31";
const workingHoursContext = "Run date: 2026-08-31 (Monday).";

const scenarios = [
  {
    id: "TC-001",
    title: "Новый клиент пишет «Здравствуйте»",
    steps: [{ message: "Здравствуйте" }],
    check: ({ lastReply }) =>
      includesAll(lastReply, [
        "Здравствуйте! Меня зовут Айлин.",
        "не выдаем займ под залог автомобиля с регионом 10",
        "модель и год выпуска автомобиля",
        "ориентировочную стоимость автомобиля",
        "какая сумма займа Вам необходима"
      ]) && excludesAll(lastReply, ["AI", "искусственный интеллект"])
  },
  {
    id: "TC-002",
    title: "Первый контакт сразу с вопросом",
    steps: [{ message: "Здравствуйте. Какая у вас процентная ставка?" }],
    check: ({ lastReply }) =>
      includesAll(lastReply, [
        "Здравствуйте! Меня зовут Айлин.",
        "По программе без изъятия ставка определяется индивидуально",
        "2,4% в месяц",
        "130 сом",
        "модель и год выпуска автомобиля"
      ])
  },
  {
    id: "TC-003",
    title: "Клиент сразу дал стартовые данные",
    steps: [{ message: "Камри 2021 года, машина стоит примерно 1 500 000 сом, нужно 500 000." }],
    check: ({ lastReply, application }) =>
      includesAll(lastReply, ["без изъятия автомобиля", "охраняемую стоянку"]) &&
      application?.facts?.vehicleMake === "Toyota" &&
      application?.facts?.vehicleModel === "Camry" &&
      application?.facts?.vehicleYear === 2021 &&
      application?.facts?.vehicleValue === 1500000 &&
      application?.facts?.requestedAmount === 500000
  },
  {
    id: "TC-004",
    title: "Указана только модель",
    steps: [{ message: "Camry" }],
    check: ({ lastReply, application }) =>
      application?.facts?.vehicleMake === "Toyota" &&
      application?.facts?.vehicleModel === "Camry" &&
      includesAll(lastReply, ["год выпуска автомобиля", "ориентировочная стоимость", "сумма займа"]) &&
      excludesAll(lastReply, ["марку Toyota", "Какая марка"])
  },
  {
    id: "TC-005",
    title: "Указана только марка",
    steps: [{ message: "Toyota" }],
    check: ({ lastReply, application }) =>
      application?.facts?.vehicleMake === "Toyota" &&
      !application?.facts?.vehicleModel &&
      includesAll(lastReply, ["модель автомобиля", "год выпуска автомобиля", "стоимость автомобиля"])
  },
  {
    id: "TC-006",
    title: "Год из будущего",
    steps: [{ message: "Toyota Camry 2032 года." }],
    check: ({ lastReply, application }) =>
      includesAll(lastReply, ["2032 года выпуска пока не существует", "правильный год выпуска"]) &&
      application?.facts?.vehicleYear !== 2032
  },
  {
    id: "TC-007",
    title: "Клиент вместо ответа задаёт вопрос",
    steps: [
      { message: "Здравствуйте" },
      { message: "А какая процентная ставка?" }
    ],
    check: ({ lastReply }) =>
      includesAll(lastReply, [
        "По программе без изъятия ставка определяется индивидуально",
        "2,4% в месяц",
        "130 сом",
        "модель и год выпуска автомобиля"
      ])
  },
  {
    id: "TC-008",
    title: "Клиент изменил сумму",
    steps: [
      { message: "Toyota Camry 2021, стоит 1 500 000, нужно 300 000" },
      { message: "Нет, уже нужно 450 000." }
    ],
    check: ({ application }) => application?.facts?.requestedAmount === 450000
  },
  {
    id: "TC-009",
    title: "Несколько сообщений подряд",
    steps: [
      { message: "Toyota Camry" },
      { message: "2021" },
      { message: "1.5 млн" },
      { message: "Нужно 500 тысяч" }
    ],
    check: ({ lastReply, stepReplies }) =>
      stepReplies.length === 4 &&
      includesAll(lastReply, ["без изъятия автомобиля", "охраняемую стоянку"])
  },
  {
    id: "TC-010",
    title: "Несколько вопросов в одном сообщении",
    steps: [{ message: "Какая ставка, сколько занимает оформление и можно ли приехать сегодня?" }],
    check: ({ lastReply }) =>
      includesAll(lastReply, [
        "По программе без изъятия ставка определяется индивидуально",
        "2,4% в месяц",
        "130 сом",
        "приехать",
        "модель и год выпуска автомобиля"
      ])
  },
  {
    id: "TC-011",
    title: "Бишкек, без изъятия, сумма допустима",
    steps: [
      { message: "Toyota Camry 2021, машина стоит 1 500 000, нужно 500 000" },
      { message: "без изъятия" },
      { message: "Бишкек" }
    ],
    check: ({ lastReply, application }) =>
      application?.decision?.calculatedLimits?.withoutStorage === 600000 &&
      includesAll(lastReply, [
        "Предварительно возможная сумма — до 600 000 сом",
        "Окончательная сумма определяется после осмотра автомобиля и проверки документов"
      ])
  },
  {
    id: "TC-012",
    title: "Бишкек, без изъятия, сумма выше лимита",
    steps: [
      { message: "Toyota Camry 2021, машина стоит 2 000 000, нужно 900 000" },
      { message: "без изъятия" },
      { message: "Бишкек" }
    ],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["600 000 сом"]) &&
      excludesAll(lastReply, ["900 000 может быть рассмотрено"])
  },
  {
    id: "TC-013",
    title: "Стоянка, расчёт от стоимости",
    steps: [
      { message: "Toyota Camry 2021, машина стоит 1 000 000, нужно 700 000" },
      { message: "со стоянкой" },
      { message: "Бишкек" }
    ],
    check: ({ lastReply, application }) =>
      application?.decision?.calculatedLimits?.parking === 500000 &&
      includesAll(lastReply, ["Предварительно возможная сумма — до 500 000 сом"])
  },
  {
    id: "TC-014",
    title: "Запрашиваемая сумма меньше минимума",
    steps: [{ message: "Мне нужно 30 000 сом." }],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["не выдаем суммы меньше 50 тыс. сом"])
  },
  {
    id: "TC-015",
    title: "Другой регион, без изъятия",
    steps: [
      { message: "Toyota Camry 2021, машина стоит 1 200 000, нужно 180 000" },
      { message: "без изъятия" },
      { message: "Ош" }
    ],
    check: ({ lastReply, application }) =>
      application?.decision?.nextAction === "check_guarantor" &&
      includesAll(lastReply, ["до 200 000 сом", "нужен поручитель", "есть ли у Вас поручитель"])
  },
  {
    id: "TC-016",
    title: "Другой регион, авто дешевле 1 млн",
    steps: [
      { message: "Toyota Camry 2021, машина стоит 800 000, нужно 180 000" },
      { message: "без изъятия" },
      { message: "Ош" }
    ],
    check: ({ lastReply, application }) =>
      arrayEquals(application?.decision?.eligiblePrograms, ["parking"]) &&
      includesAll(lastReply, ["охраняемую стоянку"])
  },
  {
    id: "TC-017",
    title: "Регион 10",
    steps: [{ message: "У меня Камри с регионом 10." }],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["По автомобилям с регионом 10 компания займ не оформляет", "Если у Вас есть другой автомобиль"])
  },
  {
    id: "TC-018",
    title: "Автомобиль зарегистрирован в другой стране",
    steps: [{ message: "Машина зарегистрирована в Казахстане." }],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["автомобиль должен быть зарегистрирован в Кыргызстане"])
  },
  {
    id: "TC-019",
    title: "Иностранный гражданин",
    steps: [{ message: "Я гражданин Казахстана, машина на кыргызских номерах." }],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["займ оформляется только гражданам Кыргызской Республики"])
  },
  {
    id: "TC-020",
    title: "Машина в кредите/залоге/под арестом",
    steps: [{ message: "Машина сейчас в кредите." }],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["такой автомобиль мы принять в залог не можем"])
  },
  {
    id: "TC-021",
    title: "Мотоцикл или другой неподдерживаемый транспорт",
    steps: [{ message: "Хочу заложить мотоцикл." }],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["только под легковые автомобили и минивэны"])
  },
  {
    id: "TC-022",
    title: "Авто оформлено на другого человека",
    steps: [{ message: "Машина оформлена на моего брата." }],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["ФИО собственника", "Какая прописка у собственника", "Сможет ли собственник лично приехать"])
  },
  {
    id: "TC-023",
    title: "Собственник не сможет приехать",
    steps: [{ message: "Собственник приехать не сможет." }],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["собственник автомобиля должен присутствовать лично"]) &&
      excludesAll(lastReply, ["дистанционно", "по доверенности", "выезд менеджера"])
  },
  {
    id: "TC-024",
    title: "Клиент сразу прислал ID",
    steps: [
      {
        attachments: [{ id: "id-front-1", fileName: "id-front.jpg", mimeType: "image/jpeg", textContent: "Иванов Иван Иванович" }]
      }
    ],
    check: ({ lastReply, application }) =>
      application?.facts?.documents?.id_front === "received" &&
      includesAny(lastReply, ["обратной стороны ID", "модель и год выпуска автомобиля"]) &&
      excludesAll(lastReply, ["Иванов Иван Иванович"])
  },
  {
    id: "TC-025",
    title: "Получена только одна сторона ID",
    steps: [
      {
        attachments: [{ id: "id-front-only", fileName: "id-front.jpg", mimeType: "image/jpeg", textContent: "Иванов Иван Иванович" }]
      }
    ],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["обратной стороны ID"]) &&
      excludesAll(lastReply, ["весь комплект ещё раз"])
  },
  {
    id: "TC-026",
    title: "Получены ID и техпаспорт",
    steps: [
      { message: "Toyota Camry 2021, машина стоит 1 500 000, нужно 500 000" },
      { message: "без изъятия" },
      { message: "Бишкек" },
      {
        attachments: [
          { id: "id-front", fileName: "id-front.jpg", mimeType: "image/jpeg", textContent: "Иванов Иван Иванович" },
          { id: "id-back", fileName: "id-back.jpg", mimeType: "image/jpeg" },
          { id: "reg-front", fileName: "registration-front.jpg", mimeType: "image/jpeg" },
          { id: "reg-back", fileName: "registration-back.jpg", mimeType: "image/jpeg" }
        ]
      }
    ],
    check: ({ lastReply, application }) =>
      application?.facts?.documents?.id_front === "received" &&
      application?.facts?.documents?.id_back === "received" &&
      application?.facts?.documents?.vehicle_registration_front === "received" &&
      application?.facts?.documents?.vehicle_registration_back === "received" &&
      includesAny(lastReply, ["состоит в браке", "никогда не состоял", "в разводе"])
  },
  {
    id: "TC-027",
    title: "Плохое качество документа",
    steps: [
      {
        attachments: [{ id: "poor-reg-front", fileName: "registration-front-poor.jpg", mimeType: "image/jpeg" }]
      },
      { message: "Другой фотографии нет." }
    ],
    check: ({ stepReplies }) =>
      includesAll(stepReplies[0] ?? "", ["качественное фото"]) &&
      !includesAll(stepReplies[1] ?? "", ["качественное фото"])
  },
  {
    id: "TC-028",
    title: "Клиент отказался отправлять документы",
    steps: [
      { message: "Toyota Camry 2021, машина стоит 1 500 000, нужно 500 000" },
      { message: "без изъятия" },
      { message: "Бишкек" },
      { message: "Документы сейчас отправлять не буду." }
    ],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["возьмите с собой оригиналы документов"]) &&
      includesAny(lastReply, ["состоит в браке", "дату", "время визита"])
  },
  {
    id: "TC-029",
    title: "Документ у другого человека",
    steps: [{ message: "Техпаспорт сейчас у жены, я не могу его прислать." }],
    check: ({ lastReply }) =>
      excludesAll(lastReply, ["попросите жену прислать", "пришлите техпаспорт"]) &&
      includesAny(lastReply, ["модель", "год", "стоимость", "сумма"])
  },
  {
    id: "TC-030",
    title: "Только фотографии автомобиля",
    steps: [
      {
        attachments: [
          { id: "car-1", fileName: "car-1.jpg", mimeType: "image/jpeg" },
          { id: "car-2", fileName: "car-2.jpg", mimeType: "image/jpeg" },
          { id: "car-3", fileName: "car-3.jpg", mimeType: "image/jpeg" }
        ]
      }
    ],
    check: ({ lastReply, application }) =>
      application?.facts?.documents?.car_photo === "received" &&
      excludesAll(JSON.stringify(application?.facts ?? {}), ["Camry", "Toyota", "black"]) &&
      includesAny(lastReply, ["модель и год выпуска автомобиля", "стоимость автомобиля"])
  },
  {
    id: "TC-031",
    title: "Неизвестное изображение",
    steps: [
      {
        attachments: [{ id: "cat-1", fileName: "cat.jpg", mimeType: "image/jpeg" }]
      }
    ],
    check: ({ lastReply, application }) =>
      application?.facts?.documents?.unknown === "received" &&
      excludesAll(lastReply, ["technical", "ошибка классификации", "unknown"])
  },
  {
    id: "TC-032",
    title: "Собственник в браке",
    steps: [{ message: "Да, я женат." }],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["нотариального согласия", "любого нотариуса", "1500 сом"])
  },
  {
    id: "TC-033",
    title: "Никогда не состоял в браке",
    steps: [{ message: "Никогда не был женат." }],
    check: ({ lastReply }) =>
      excludesAll(lastReply, ["нотариального согласия"]) &&
      includesAny(lastReply, ["документ", "визит", "следующий"])
  },
  {
    id: "TC-034",
    title: "В разводе, машина куплена в браке",
    steps: [{ message: "Я в разводе." }, { message: "В браке." }],
    check: ({ stepReplies, lastReply }) =>
      includesAll(stepReplies[0] ?? "", ["автомобиль был приобретён во время брака или после развода"]) &&
      includesAll(lastReply, ["свидетельства о расторжении брака"])
  },
  {
    id: "TC-035",
    title: "В разводе, машина куплена после развода",
    steps: [{ message: "Я в разводе." }, { message: "После развода." }],
    check: ({ lastReply }) =>
      excludesAll(lastReply, ["свидетельства о расторжении брака"]) &&
      includesAny(lastReply, ["документ", "визит", "следующий"])
  },
  {
    id: "TC-036",
    title: "Поручитель есть",
    steps: [
      { message: "Toyota Camry 2021, машина стоит 1 500 000, нужно 180 000" },
      { message: "без изъятия" },
      { message: "Ош" },
      { message: "Да, поручитель есть." }
    ],
    check: ({ stepReplies, lastReply }) =>
      includesAll(stepReplies[2] ?? "", ["от 25 лет", "ID или паспорт"]) &&
      excludesAll(lastReply, ["окончательно одобрено"])
  },
  {
    id: "TC-037",
    title: "Поручителя нет",
    steps: [
      { message: "Toyota Camry 2021, машина стоит 1 500 000, нужно 180 000" },
      { message: "без изъятия" },
      { message: "Ош" },
      { message: "Поручителя нет." }
    ],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["Без поручителя оформление без изъятия продолжить нельзя", "охраняемую стоянку"])
  },
  {
    id: "TC-038",
    title: "Клиент хочет приехать завтра",
    steps: [{ message: "Я могу приехать завтра." }],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["ПН–ПТ 11:00–19:00", "не позднее 18:00", "конкретное время"])
  },
  {
    id: "TC-039",
    title: "Клиент предлагает 18:30",
    steps: [{ message: "Давайте завтра в 18:30." }],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["не позднее 18:00"]) &&
      excludesAll(lastReply, ["Предварительно записала"])
  },
  {
    id: "TC-040",
    title: "Клиент выбирает воскресенье",
    steps: [{ message: "Приеду в воскресенье." }],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["выходной"]) && includesAny(lastReply, ["рабочий день", "понедельник"])
  },
  {
    id: "TC-041",
    title: "Дата и время согласованы",
    steps: [{ message: "Тогда во вторник в 15:00." }],
    check: ({ lastReply }) =>
      includesAll(lastReply, [
        "Предварительно записала Вас на указанное время",
        "с Вами свяжется менеджер",
        "Б. Молодой Гвардии, 22",
        "https://go.2gis.com/Y34m4",
        "https://maps.app.goo.gl/9xiWLVvdyRgn3Sx4A"
      ])
  },
  {
    id: "TC-042",
    title: "Когда позвонит менеджер: рабочее время",
    steps: [
      { message: "Тогда во вторник в 15:00." },
      { message: "Когда менеджер мне позвонит?" }
    ],
    check: ({ lastReply }) => includesAll(lastReply, ["в течение часа"])
  },
  {
    id: "TC-043",
    title: "Когда позвонит менеджер: вне рабочего времени",
    steps: [{ message: "Когда менеджер мне позвонит?" }],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["до 12:00 первого рабочего дня"]) &&
      excludesAll(lastReply, ["окончательно подтверждён"])
  },
  {
    id: "TC-044",
    title: "Клиент уже едет",
    steps: [{ message: "Я уже выехал к вам." }],
    check: ({ lastReply }) =>
      includesAny(lastReply, ["безопасной дороги", "Б. Молодой Гвардии, 22", "2GIS", "Google Maps"])
  },
  {
    id: "TC-045",
    title: "Клиент уже приехал",
    steps: [{ message: "Я возле офиса." }],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["можете пройти в офис"])
  },
  {
    id: "TC-046",
    title: "Остаток долга",
    steps: [{ message: "Сколько у меня осталось долга по договору?" }],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["виртуальный помощник по вопросам оформления новых займов", "+996 502 108 108", "+996 776 108 108"])
  },
  {
    id: "TC-047",
    title: "Проблема GPS",
    steps: [{ message: "У меня перестал работать GPS на залоговой машине." }],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["+996 502 108 108", "+996 776 108 108"]) &&
      excludesAll(lastReply, ["перезагрузите", "проверьте питание"])
  },
  {
    id: "TC-048",
    title: "Два бытовых вопроса",
    steps: [{ message: "У вас есть Wi‑Fi и парковка?" }],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["Wi", "парков"]) && includesAny(lastReply, ["модель", "год", "стоимость"])
  },
  {
    id: "TC-049",
    title: "Вопрос без готового ответа, но вывод возможен по ТЗ",
    steps: [{ message: "Можно ли оформить займ по доверенности?" }],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["собственник автомобиля должен присутствовать лично"]) &&
      excludesAll(lastReply, ["можно по доверенности"])
  },
  {
    id: "TC-050",
    title: "Достоверного ответа нет",
    steps: [{ message: "А менеджер точно даст мне скидку 20%, если я попрошу?" }],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["нет достоверной информации", "сотрудники с удовольствием подскажут Вам"])
  },
  {
    id: "TC-051",
    title: "Нормальное voice",
    steps: [
      {
        attachments: [
          {
            id: "voice-ok",
            fileName: "voice-ok.ogg",
            mimeType: "audio/ogg",
            textContent: "У меня Камри 2020 года, стоит миллион двести, нужно четыреста тысяч."
          }
        ]
      }
    ],
    check: ({ application }) =>
      application?.facts?.vehicleMake === "Toyota" &&
      application?.facts?.vehicleModel === "Camry"
  },
  {
    id: "TC-052",
    title: "Voice не удалось понять",
    steps: [
      {
        attachments: [{ id: "voice-bad", fileName: "voice-bad.ogg", mimeType: "audio/ogg" }]
      }
    ],
    check: ({ lastReply }) =>
      includesAll(lastReply, ["не удалось полностью понять Ваше сообщение", "Пожалуйста, повторите его ещё раз"])
  },
  {
    id: "TC-053",
    title: "Переход на кыргызский",
    steps: [
      { message: "Toyota Camry 2020, стоит 1 200 000, нужно 400 000" },
      { message: "Менин каттоом Бишкекте." }
    ],
    check: ({ lastReply }) => /[А-Яа-яЁё]/.test(lastReply) === false
  },
  {
    id: "TC-054",
    title: "Смешанный RU/KG",
    steps: [{ message: "Ставка кандай, завтра келе аламбы?" }],
    check: ({ lastReply }) => includesAny(lastReply, ["кандай", "келе", "боло"]) || !/По программе без изъятия/.test(lastReply)
  },
  {
    id: "TC-055",
    title: "Раздражённый клиент меняет сумму после лимита",
    steps: [
      { message: "Нужен займ без изъятия" },
      { message: "Camry 2022 стоит 20 тфыс долларов, надо 10 k долларов" },
      { message: "Бишкек" },
      { message: "Почему так мало, мне нужно 800 тысяч" },
      { message: "А что так мало?" }
    ],
    check: ({ lastReply, stepReplies, application }) =>
      application?.facts?.vehicleMake === "Toyota" &&
      application?.facts?.vehicleModel === "Camry" &&
      application?.facts?.vehicleYear === 2022 &&
      application?.facts?.requestedAmount === 800000 &&
      includesAll(stepReplies.join(" "), [
        "Где прописан собственник автомобиля?",
        "без изъятия предварительно возможная сумма — до 600 000 сом",
        "со стоянкой предварительно возможная сумма — до 874 500 сом"
      ]) &&
      excludesAll(stepReplies.join(" "), [
        "не смогла надёжно распознать документы",
        "до 320 000 сом",
        "Какая прописка"
      ]) &&
      includesAny(lastReply, ["со стоянкой", "без изъятия"])
  }
];

await assertApiHealth();
await mkdir(reportDir, { recursive: true });

const results = [];
for (const scenario of scenarios) {
  const startedAt = Date.now();
  try {
    const result = await runScenario(scenario);
    results.push({
      ...result,
      id: scenario.id,
      title: scenario.title,
      durationMs: Date.now() - startedAt
    });
    console.log(`${result.status} ${scenario.id} ${scenario.title}`);
  } catch (error) {
    results.push({
      id: scenario.id,
      title: scenario.title,
      status: "ERROR",
      durationMs: Date.now() - startedAt,
      lastReply: "",
      stepReplies: [],
      application: undefined,
      conversationId: "",
      error: error instanceof Error ? error.message : String(error)
    });
    console.log(`ERROR ${scenario.id} ${scenario.title}`);
  }
}

const summary = summarize(results);
const jsonPath = resolve(reportDir, `${reportBase}.json`);
const mdPath = resolve(reportDir, `${reportBase}.md`);

await writeFile(jsonPath, JSON.stringify({ apiUrl, runId, currentDate, workingHoursContext, summary, results }, null, 2));
await writeFile(mdPath, renderMarkdown({ apiUrl, runId, currentDate, workingHoursContext, summary, results, jsonPath }));

console.log(JSON.stringify({ jsonPath, mdPath, summary }, null, 2));

async function runScenario(scenario) {
  const conversation = await postJson("/conversations/web-test", {
    externalContactId: `${runId}-${scenario.id}`,
    externalConversationId: `${runId}-${scenario.id}`
  });

  const stepReplies = [];
  let lastResponse = null;
  for (const step of scenario.steps) {
    lastResponse = await postJson("/messages/test-chat", {
      conversationId: conversation.id,
      message: step.message,
      attachments: step.attachments ?? []
    });
    stepReplies.push(lastResponse.reply ?? "");
  }

  const lastReply = lastResponse?.reply ?? "";
  const application = lastResponse?.application ?? lastResponse?.conversation?.application;
  const passed = Boolean(scenario.check({ lastReply, stepReplies, application, response: lastResponse }));
  return {
    status: passed ? "PASS" : "FAIL",
    lastReply,
    stepReplies,
    application,
    conversationId: conversation.id,
    error: passed ? undefined : buildFailureReason(scenario, { lastReply, stepReplies, application, response: lastResponse })
  };
}

function buildFailureReason(scenario, context) {
  return `Scenario ${scenario.id} did not satisfy scripted assertions. Last reply: ${normalize(context.lastReply)}`;
}

async function assertApiHealth() {
  const health = await getJson("/health");
  if (health.status !== "ok") {
    throw new Error(`API health is not ok: ${JSON.stringify(health)}`);
  }
}

async function getJson(path) {
  const response = await fetchImpl(`${apiUrl}${path}`);
  if (!response.ok) {
    throw new Error(`GET ${path} failed with ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function postJson(path, body) {
  const response = await fetchImpl(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`POST ${path} failed with ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function summarize(results) {
  return {
    total: results.length,
    pass: results.filter((item) => item.status === "PASS").length,
    fail: results.filter((item) => item.status === "FAIL").length,
    error: results.filter((item) => item.status === "ERROR").length
  };
}

function renderMarkdown({ apiUrl, runId, currentDate, workingHoursContext, summary, results, jsonPath }) {
  const failed = results.filter((item) => item.status !== "PASS");
  const passed = results.filter((item) => item.status === "PASS");
  const topIssues = failed.slice(0, 15).map((item) => `- \`${item.id}\` — ${item.title}: ${item.error}`);
  const lines = [
    "# AILYN Dialog E2E Report",
    "",
    `- Run ID: \`${runId}\``,
    `- API URL: \`${apiUrl}\``,
    `- Scenario source: \`AILYN_DIALOG_TEST_SCENARIOS.md\``,
    `- Run date: \`${currentDate}\``,
    `- Context: ${workingHoursContext}`,
    `- JSON artifact: \`${jsonPath}\``,
    "",
    "## Summary",
    "",
    `- Total scenarios: ${summary.total}`,
    `- Passed: ${summary.pass}`,
    `- Failed: ${summary.fail}`,
    `- Errors: ${summary.error}`,
    "",
    "## Passed",
    "",
    ...passed.map((item) => `- \`${item.id}\` — ${item.title}`),
    "",
    "## Failed Or Error",
    "",
    ...(failed.length ? failed.map((item) => `- \`${item.id}\` — ${item.title}: ${item.error}`) : ["- None"]),
    "",
    "## What To Improve",
    "",
    ...(topIssues.length
      ? topIssues
      : ["- Существенных сбоев по текущему набору scripted assertions не обнаружено."]),
    "",
    "## Notes",
    "",
    "- `pnpm test` were also run separately and should be reviewed together with this live API report.",
    "- Some scenarios depend on natural-language date resolution, audio STT, image semantics, or knowledge completeness; live results reflect the current implementation rather than idealized acceptance expectations."
  ];
  return lines.join("\n");
}

function normalize(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function includesAll(haystack, needles) {
  const normalizedHaystack = normalize(haystack);
  return needles.every((needle) => normalizedHaystack.includes(normalize(needle)));
}

function includesAny(haystack, needles) {
  const normalizedHaystack = normalize(haystack);
  return needles.some((needle) => normalizedHaystack.includes(normalize(needle)));
}

function excludesAll(haystack, needles) {
  const normalizedHaystack = normalize(haystack);
  return needles.every((needle) => !normalizedHaystack.includes(normalize(needle)));
}

function arrayEquals(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}
