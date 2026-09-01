# AILYN Local Backend E2E Report

- Date: `2026-08-31`
- Time context used for visit scenarios: `Monday, 2026-08-31`
- Scenario source: `AILYN_DIALOG_TEST_SCENARIOS.md`
- Raw live-run artifacts:
  - [Generated markdown](/Users/georgiiborisov/Documents/Projects/ailyn/docs/reports/ailyn-dialog-scenarios-1788181237770.md)
  - [Generated json](/Users/georgiiborisov/Documents/Projects/ailyn/docs/reports/ailyn-dialog-scenarios-1788181237770.json)
- Runner used: [scripts/run-dialog-test-scenarios.mjs](/Users/georgiiborisov/Documents/Projects/ailyn/scripts/run-dialog-test-scenarios.mjs)

## Environment

- `git` branch: `main`
- Local `main` matched `origin/main` at commit `55827f7fd3698a02b5c7ce20e00d2b11d9e1d9ad`
- `docker compose up -d --build` completed successfully
- Healthy containers after startup:
  - `ailyn-local-api-1`
  - `ailyn-local-admin-1`
  - `ailyn-local-postgres-1`
  - `ailyn-local-redis-1`
  - `ailyn-local-minio-1`
- API health: `GET /api/health -> ok`

## Verification

- `pnpm test:scenarios` -> `19/19 passed`
- `pnpm test` -> `82/82 passed`
- `pnpm typecheck` -> passed
- `pnpm build` -> passed

## Important Technical Notes

- Local shell runs `pnpm` under Node `v20.19.4`, while the repo requires Node `>=22 <23`. Checks still passed, but this is an environment mismatch.
- During Docker build, `admin` emitted Next.js warnings about deprecated `middleware` convention and Edge Runtime usage of `process.cwd`.
- In API logs, the first-message RouterAI extraction attempted a remote structured call and then fell back locally with warning: `RouterAI extraction fallback activated: RouterAI extraction response does not match structured schema`.

## Scenario Summary

- Total scenarios from `AILYN_DIALOG_TEST_SCENARIOS.md`: `54`
- Passed: `19`
- Failed: `35`
- Runner crashes: `0`

## Passed Scenarios

- `TC-001` Новый клиент пишет «Здравствуйте»
- `TC-002` Первый контакт сразу с вопросом
- `TC-003` Клиент сразу дал стартовые данные
- `TC-007` Клиент вместо ответа задаёт вопрос
- `TC-009` Несколько сообщений подряд
- `TC-011` Бишкек, без изъятия, сумма допустима
- `TC-012` Бишкек, без изъятия, сумма выше лимита
- `TC-013` Стоянка, расчёт от стоимости
- `TC-015` Другой регион, без изъятия
- `TC-021` Мотоцикл или другой неподдерживаемый транспорт
- `TC-024` Клиент сразу прислал ID
- `TC-026` Получены ID и техпаспорт
- `TC-029` Документ у другого человека
- `TC-030` Только фотографии автомобиля
- `TC-036` Поручитель есть
- `TC-037` Поручителя нет
- `TC-044` Клиент уже едет
- `TC-050` Достоверного ответа нет
- `TC-054` Смешанный RU/KG

## Main Failures

- `TC-004`, `TC-005`: при неполных данных по авто система не задаёт все ожидаемые уточняющие вопросы.
- `TC-006`: будущий год распознаётся, но ответ склеивается с дополнительным onboarding-текстом.
- `TC-008`: изменение суммы не подтвердилось как корректное обновление актуального state в рамках scripted check.
- `TC-010`: мультивопрос обрабатывается частично; ответ не покрывает весь ожидаемый набор вопросов.
- `TC-014`: кейс с суммой ниже минимума не дал ожидаемый отказ по порогу `50 000`.
- `TC-016`: для другого региона и авто дешевле `1 000 000` система ушла в сбор документов вместо предложения стоянки.
- `TC-017` - `TC-020`: блок отказов по региону `10`, иностранной регистрации, иностранному гражданству и кредитному авто покрыт неполно или не тем текстом.
- `TC-022`, `TC-023`: ownership-flow не собирает ожидаемые уточнения про собственника и личное присутствие.
- `TC-025`, `TC-027`, `TC-028`, `TC-031`: есть провалы в edge-cases по документам и классификации изображений.
- `TC-032` - `TC-035`: ветка семейного положения и развода в живом диалоге не соответствует ожиданиям.
- `TC-038` - `TC-043`, `TC-045`: основной блок по визитам и календарной логике сейчас не проходит.
- `TC-046`, `TC-047`: маршрутизация обращений по действующему договору/GPS не отрабатывает по ожидаемому сценарию.
- `TC-048`, `TC-049`: knowledge/FAQ ответы неполные; местами есть правильная мысль, но затем система снова запускает onboarding.
- `TC-051`, `TC-052`: голосовые сообщения как e2e-функция не подтверждены.
- `TC-053`: автоматический переход на кыргызский язык не подтверждён.

## Partial Or Close Cases

- `TC-020`: по сути отказ есть, но формулировка отличается от ожидаемой.
- `TC-049`: правило про доверенность отрабатывает по смыслу, но ответ затем дополняется лишним стартом сценария.
- `TC-006`: основная коррекция будущего года присутствует, но сообщение перегружено лишним продолжением.

## What Needs Improvement First

- Исправить перезапуск onboarding после специальных веток: отказы, existing-contract, family, visit, knowledge.
- Довести deterministic routing для ownership, family-status и visit scheduling до состояния, когда они не теряются без полного набора базовых фактов.
- Усилить document pipeline для частичных, плохих и неизвестных вложений.
- Добавить или исправить voice/STT boundary для Stage 1, если эти сценарии должны считаться поддержанными.
- Проверить локальный fast-path и RouterAI structured extraction, чтобы первый контакт не зависел от невалидного внешнего structured ответа.
- Синхронизировать локальную среду с требуемым Node `22`, чтобы не полагаться на проверки под неподдерживаемой версией.

## Overall Assessment

Локальный backend и инфраструктура через Docker поднимаются успешно, базовые тесты репозитория проходят, но живой e2e-прогон по пользовательскому файлу показывает, что Stage 1 пока покрывает только часть диалогового контракта. Сильнее всего проседают ветки с ownership/family/visit/existing-contract, а также сценарии, где ответ должен не просто быть корректным по смыслу, а ещё и не перезапускать общий сценарий оформления.
