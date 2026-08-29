ALTER TABLE "ManagerNotification" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "Reminder" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "ManagerNotification_idempotencyKey_key" ON "ManagerNotification"("idempotencyKey");
CREATE UNIQUE INDEX "Reminder_idempotencyKey_key" ON "Reminder"("idempotencyKey");
