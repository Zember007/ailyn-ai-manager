ALTER TABLE "Application" ADD COLUMN "dialogueSummary" TEXT;
ALTER TABLE "Application" ADD COLUMN "dialogueSummaryRequestedAt" TIMESTAMP(3);
ALTER TABLE "Application" ADD COLUMN "dialogueSummaryGeneratedAt" TIMESTAMP(3);
