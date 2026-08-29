# AI Pipeline v6.2 — локальная проверка первого контакта

Источник требований: [`AILYN_AI_PIPELINE_CODEX_PROMPT.md`](../../AILYN_AI_PIPELINE_CODEX_PROMPT.md), разделы 3.1–3.3 и 30.

## Среда

- Локальные PostgreSQL и Redis из `compose.yml` были запущены и healthy.
- Новая migration `20260829143000_ai_pipeline_events` применена через `prisma migrate deploy`.
- API был собран и временно запущен на `http://localhost:3101`.
- RouterAI не был настроен в локальной среде, поэтому сценарий использовал допустимый `local-stage1-fallback` и детерминированный `ResponsePlan`.

## Web Test сценарий

Запрос:

```http
POST /api/messages/test-chat
Content-Type: application/json

{
  "message": "Здравствуйте",
  "externalContactId": "e2e-first-contact-v62",
  "externalConversationId": "e2e-first-contact-v62"
}
```

Фактический ответ:

```text
Здравствуйте! Меня зовут Айлин. Я менеджер по оформлению новых займов автоломбарда «Молодой». Информируем Вас, что мы не выдаем займ под залог автомобиля с регионом 10.

Подскажите, пожалуйста:
- модель и год выпуска автомобиля;
- ориентировочную стоимость автомобиля;
- какая сумма займа Вам необходима?
```

Проверенные результаты:

- `validation.passed = true`, ошибок validator нет.
- Входящее и исходящее сообщения сохранены в conversation `e36b7ccb-25b3-4399-8082-471e839f450f`.
- Заявка сохранена в состоянии `COLLECTING_VEHICLE`; язык определён как `ru`.
- Использован `routerAiModel = local-stage1-fallback`, `promptVersion = stage1-local-v1`.

## Автоматические проверки

```text
pnpm test          # 34 passed
pnpm test:scenarios # 5 passed
pnpm typecheck     # passed
pnpm --filter @ailyn/api build # passed
```

Отдельный unit-test `ResponsePlanService first contact` фиксирует полный approved текст и проверяет, что уже сообщённые в первом сообщении данные не запрашиваются повторно.
