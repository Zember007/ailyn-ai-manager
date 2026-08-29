DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ScenarioRunStatus') THEN
    CREATE TYPE "ScenarioRunStatus" AS ENUM ('PASS', 'FAIL', 'BLOCKED');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MessageChannel') THEN
    ALTER TYPE "MessageChannel" ADD VALUE IF NOT EXISTS 'web_test';
    ALTER TYPE "MessageChannel" ADD VALUE IF NOT EXISTS 'wazzup';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ApplicationState') THEN
    ALTER TYPE "ApplicationState" ADD VALUE IF NOT EXISTS 'NEW';
    ALTER TYPE "ApplicationState" ADD VALUE IF NOT EXISTS 'COLLECTING_VEHICLE';
    ALTER TYPE "ApplicationState" ADD VALUE IF NOT EXISTS 'COLLECTING_VALUE';
    ALTER TYPE "ApplicationState" ADD VALUE IF NOT EXISTS 'COLLECTING_AMOUNT';
    ALTER TYPE "ApplicationState" ADD VALUE IF NOT EXISTS 'COLLECTING_RESIDENCE';
    ALTER TYPE "ApplicationState" ADD VALUE IF NOT EXISTS 'ELIGIBILITY_CHECK';
    ALTER TYPE "ApplicationState" ADD VALUE IF NOT EXISTS 'COLLECTING_DOCUMENTS';
    ALTER TYPE "ApplicationState" ADD VALUE IF NOT EXISTS 'COLLECTING_FAMILY_STATUS';
    ALTER TYPE "ApplicationState" ADD VALUE IF NOT EXISTS 'CHECKING_GUARANTOR';
    ALTER TYPE "ApplicationState" ADD VALUE IF NOT EXISTS 'SCHEDULING_VISIT';
    ALTER TYPE "ApplicationState" ADD VALUE IF NOT EXISTS 'TARGET_REACHED_DOCUMENTS';
    ALTER TYPE "ApplicationState" ADD VALUE IF NOT EXISTS 'TARGET_REACHED_VISIT';
    ALTER TYPE "ApplicationState" ADD VALUE IF NOT EXISTS 'REFUSED';
    ALTER TYPE "ApplicationState" ADD VALUE IF NOT EXISTS 'PAUSED';
    ALTER TYPE "ApplicationState" ADD VALUE IF NOT EXISTS 'EXISTING_CONTRACT_REDIRECT';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "FactHistory" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "previousValue" JSONB,
  "newValue" JSONB NOT NULL,
  "source" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FactHistory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Setting" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "blocked" BOOLEAN NOT NULL DEFAULT false,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ScenarioRun" (
  "id" TEXT NOT NULL,
  "status" "ScenarioRunStatus" NOT NULL,
  "summary" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScenarioRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ScenarioResult" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "scenarioId" TEXT NOT NULL,
  "status" "ScenarioRunStatus" NOT NULL,
  "expected" TEXT NOT NULL,
  "actual" TEXT NOT NULL,
  "assertions" JSONB NOT NULL DEFAULT '[]',
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScenarioResult_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "KnowledgeItem"
  ADD COLUMN IF NOT EXISTS "key" TEXT,
  ADD COLUMN IF NOT EXISTS "category" TEXT,
  ADD COLUMN IF NOT EXISTS "aliases" JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "answerRu" TEXT,
  ADD COLUMN IF NOT EXISTS "answerKg" TEXT,
  ADD COLUMN IF NOT EXISTS "conditions" JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "priority" INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS "version" INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "active" BOOLEAN DEFAULT true;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'KnowledgeItem'
      AND column_name = 'title'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'KnowledgeItem'
      AND column_name = 'body'
  ) THEN
    EXECUTE $migration$
      UPDATE "KnowledgeItem"
      SET
        "key" = COALESCE("key", lower(regexp_replace(COALESCE("title", id), '[^a-zA-Z0-9]+', '_', 'g'))),
        "category" = COALESCE("category", 'general'),
        "aliases" = COALESCE("aliases", '[]'::jsonb),
        "answerRu" = COALESCE("answerRu", "body", ''),
        "conditions" = COALESCE("conditions", '{}'::jsonb),
        "priority" = COALESCE("priority", 0),
        "status" = COALESCE("status", 'draft'),
        "version" = COALESCE("version", 1),
        "active" = COALESCE("active", true)
      WHERE
        "key" IS NULL
        OR "category" IS NULL
        OR "aliases" IS NULL
        OR "answerRu" IS NULL
        OR "conditions" IS NULL
        OR "priority" IS NULL
        OR "status" IS NULL
        OR "version" IS NULL
        OR "active" IS NULL
    $migration$;
  ELSE
    UPDATE "KnowledgeItem"
    SET
      "key" = COALESCE("key", lower(regexp_replace(id, '[^a-zA-Z0-9]+', '_', 'g'))),
      "category" = COALESCE("category", 'general'),
      "aliases" = COALESCE("aliases", '[]'::jsonb),
      "answerRu" = COALESCE("answerRu", ''),
      "conditions" = COALESCE("conditions", '{}'::jsonb),
      "priority" = COALESCE("priority", 0),
      "status" = COALESCE("status", 'draft'),
      "version" = COALESCE("version", 1),
      "active" = COALESCE("active", true)
    WHERE
      "key" IS NULL
      OR "category" IS NULL
      OR "aliases" IS NULL
      OR "answerRu" IS NULL
      OR "conditions" IS NULL
      OR "priority" IS NULL
      OR "status" IS NULL
      OR "version" IS NULL
      OR "active" IS NULL;
  END IF;
END $$;

ALTER TABLE "KnowledgeItem"
  ALTER COLUMN "key" SET NOT NULL,
  ALTER COLUMN "category" SET NOT NULL,
  ALTER COLUMN "aliases" SET NOT NULL,
  ALTER COLUMN "answerRu" SET NOT NULL,
  ALTER COLUMN "conditions" SET NOT NULL,
  ALTER COLUMN "priority" SET NOT NULL,
  ALTER COLUMN "status" SET NOT NULL,
  ALTER COLUMN "version" SET NOT NULL,
  ALTER COLUMN "active" SET NOT NULL;

ALTER TABLE "KnowledgeItem"
  ADD COLUMN IF NOT EXISTS "metadata" JSONB NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX IF NOT EXISTS "Setting_key_key" ON "Setting"("key");
CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeItem_key_key" ON "KnowledgeItem"("key");
CREATE INDEX IF NOT EXISTS "FactHistory_applicationId_key_idx" ON "FactHistory"("applicationId", "key");
CREATE INDEX IF NOT EXISTS "ScenarioResult_runId_idx" ON "ScenarioResult"("runId");
CREATE INDEX IF NOT EXISTS "ScenarioResult_scenarioId_status_idx" ON "ScenarioResult"("scenarioId", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'FactHistory_applicationId_fkey'
      AND table_name = 'FactHistory'
  ) THEN
    ALTER TABLE "FactHistory"
      ADD CONSTRAINT "FactHistory_applicationId_fkey"
      FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'ScenarioResult_runId_fkey'
      AND table_name = 'ScenarioResult'
  ) THEN
    ALTER TABLE "ScenarioResult"
      ADD CONSTRAINT "ScenarioResult_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "ScenarioRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
