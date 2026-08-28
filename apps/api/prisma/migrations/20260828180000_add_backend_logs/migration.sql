CREATE TABLE IF NOT EXISTS "BackendLog" (
  "id" TEXT NOT NULL,
  "level" TEXT NOT NULL,
  "context" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "requestId" TEXT,
  "method" TEXT,
  "path" TEXT,
  "conversationId" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "stack" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BackendLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BackendLog_createdAt_idx" ON "BackendLog"("createdAt");
CREATE INDEX IF NOT EXISTS "BackendLog_level_createdAt_idx" ON "BackendLog"("level", "createdAt");
CREATE INDEX IF NOT EXISTS "BackendLog_conversationId_createdAt_idx" ON "BackendLog"("conversationId", "createdAt");
