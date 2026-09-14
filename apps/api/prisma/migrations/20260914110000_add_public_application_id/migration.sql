ALTER TABLE "Application" ADD COLUMN "publicId" TEXT;

WITH ranked_applications AS (
  SELECT
    "id",
    TO_CHAR("createdAt", 'DD-MM-YY') || '+' || ROW_NUMBER() OVER (
      PARTITION BY "createdAt"::date
      ORDER BY "createdAt", "id"
    ) AS "publicId"
  FROM "Application"
)
UPDATE "Application"
SET "publicId" = ranked_applications."publicId"
FROM ranked_applications
WHERE "Application"."id" = ranked_applications."id";

CREATE UNIQUE INDEX "Application_publicId_key" ON "Application"("publicId");
