# Ailyn Stage 1 Product Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Довести Stage 1 admin и test chat до понятного рабочего состояния по мастер-промпту: убрать немые сбои, включить управляемые настройки, сделать базу знаний и сценарии прозрачными, русифицировать интерфейс.

**Architecture:** Работа идет поверх уже существующих NestJS и Next.js модулей без замены текущих границ `DialogueOrchestratorService`, `AiProvider` и business rules. Основной фокус: продуктовая надежность потока `admin -> api`, наблюдаемость ошибок, локализация UI и честное отображение статусов сценариев/данных.

**Tech Stack:** TypeScript, NestJS, Next.js App Router, Prisma, Vitest

---

### Task 1: Product audit against master prompt

**Files:**
- Modify: `codex_master_prompt_ailyn_stage1.md`
- Modify: `docs/acceptance/ailyn_stage1_scenarios.md`
- Modify: `docs/superpowers/plans/2026-08-28-stage1-product-hardening.md`

- [ ] **Step 1: Зафиксировать обязательные продуктовые потоки**

Проверить наличие и фактическую работоспособность:

```text
1. Создание web test conversation
2. Отправка сообщения в существующий диалог
3. Отображение ошибок API в админке
4. Редактирование настроек
5. Работа со знаниями
6. Запуск сценариев и просмотр run details
7. Русификация интерфейса
```

- [ ] **Step 2: Отметить пробелы реализации**

Зафиксировать как минимум эти риски:

```text
- silent fallback в apps/admin/app/lib/api.ts маскирует ошибки
- страницы и компоненты смешивают русский и английский
- сценарный раннер PASS-ит часть категорий по заглушкам
- настройки и knowledge UX недостаточно объясняют состояние данных
```

### Task 2: Make admin/API flows observable and actionable

**Files:**
- Modify: `apps/admin/app/lib/api.ts`
- Modify: `apps/admin/app/conversations/new/route.ts`
- Modify: `apps/admin/app/conversations/send/route.ts`
- Modify: `apps/admin/app/scenarios/run/route.ts`
- Modify: `apps/admin/app/settings/save/route.ts`
- Modify: `apps/admin/app/knowledge/save/route.ts`

- [ ] **Step 1: Вернуть структурированный результат API вместо немого fallback**

Добавить контракт вида:

```ts
export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}
```

- [ ] **Step 2: Пробросить ошибки форм через redirect-параметры**

Использовать редиректы вида:

```ts
return Response.redirect(new URL("/conversations?error=api_unavailable", request.url), 303);
```

- [ ] **Step 3: Оставить чтение страниц устойчивым**

Для `readJson` оставить безопасный fallback, но параллельно уметь показывать пользователю, что API недоступен.

### Task 3: Localize and polish the admin UX

**Files:**
- Modify: `apps/admin/app/layout.tsx`
- Modify: `apps/admin/app/components.tsx`
- Modify: `apps/admin/app/dashboard/page.tsx`
- Modify: `apps/admin/app/conversations/page.tsx`
- Modify: `apps/admin/app/conversations/[id]/page.tsx`
- Modify: `apps/admin/app/scenarios/page.tsx`
- Modify: `apps/admin/app/audit/page.tsx`
- Modify: `apps/admin/app/settings/page.tsx`
- Modify: `apps/admin/app/knowledge/page.tsx`
- Modify: `apps/admin/app/styles.css`

- [ ] **Step 1: Перевести ключевые заголовки, кнопки и статусы на русский**

Исправить:

```text
Dashboard -> Обзор
Conversations -> Диалоги
Scenarios -> Сценарии
Settings -> Настройки
Knowledge -> База знаний
Audit -> Аудит
```

- [ ] **Step 2: Добавить пользовательские сообщения об успехе/ошибке**

Показать понятные статусы:

```text
- Диалог создан
- Сообщение отправлено
- Настройки сохранены
- База знаний обновлена
- Сценарии запущены
- API недоступен
```

- [ ] **Step 3: Улучшить переносы и плотность интерфейса**

Доработать CSS для:

```text
- длинных JSON и идентификаторов
- адаптивной формы чата
- многострочных таблиц
- читаемых блоков ошибок и подсказок
```

### Task 4: Make settings and knowledge clearer for Stage 1

**Files:**
- Modify: `apps/api/src/settings/settings.service.ts`
- Modify: `apps/admin/app/settings/page.tsx`
- Modify: `apps/api/src/knowledge/knowledge.service.ts`
- Modify: `apps/admin/app/knowledge/page.tsx`

- [ ] **Step 1: Русифицировать labels настроек и показать BLOCKED-поля честно**

Нужен список полей с понятными русскими названиями и reason для неутвержденных параметров.

- [ ] **Step 2: Показать seed knowledge и статус наполнения**

Добавить в UI признаки:

```text
- сколько активных записей
- какие записи approved / draft / blocked
- что acceptance scenarios не являются knowledge base
```

- [ ] **Step 3: Не скрывать отсутствие данных**

Если настроек или знаний нет, страница должна объяснять текущее состояние, а не выглядеть пустой.

### Task 5: Make scenario status presentation honest

**Files:**
- Modify: `apps/api/src/scenarios/scenarios.service.ts`
- Modify: `apps/admin/app/scenarios/page.tsx`
- Modify: `apps/admin/app/scenarios/runs/[id]/page.tsx`

- [ ] **Step 1: Явно отделить fully automated checks от placeholder assertions**

Не выдавать продуктовую готовность там, где runner делает только категорийную заглушку.

- [ ] **Step 2: Улучшить summary и тексты результата**

Показать:

```text
- PASS только для реально проверенного
- BLOCKED для бизнес-неподтвержденного
- требует доработки / частичная автоматизация для оставшихся сценариев
```

### Task 6: Verification

**Files:**
- Modify: `apps/admin/app/*`
- Modify: `apps/api/src/*`

- [ ] **Step 1: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 2: Run unit tests**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 3: Run scenario tests**

Run: `pnpm test:scenarios`
Expected: PASS

- [ ] **Step 4: Run build**

Run: `pnpm build`
Expected: PASS or documented blocker if local Node version differs from required engine
