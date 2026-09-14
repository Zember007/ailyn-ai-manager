UPDATE "Application"
SET "publicId" = REPLACE("publicId", '+', '-')
WHERE "publicId" LIKE '%+%';
