-- Replace stale setup placeholders with the approved office contact details.
UPDATE "Setting"
SET "value" = '"Б. Молодой Гвардии, 22, Бишкек"'::jsonb,
    "updatedBy" = 'migration'
WHERE "key" = 'address'
  AND (
    jsonb_typeof("value") <> 'string'
    OR BTRIM("value" #>> '{}') = ''
    OR LOWER("value" #>> '{}') LIKE '%подтвердить%'
    OR LOWER("value" #>> '{}') LIKE '%настройк%'
  );

UPDATE "Setting"
SET "value" = '"https://go.2gis.com/Y34m4"'::jsonb,
    "updatedBy" = 'migration'
WHERE "key" = 'twoGisUrl'
  AND (jsonb_typeof("value") <> 'string' OR BTRIM("value" #>> '{}') !~ '^https://');

UPDATE "Setting"
SET "value" = '"https://maps.app.goo.gl/9xiWLVvdyRgn3Sx4A"'::jsonb,
    "updatedBy" = 'migration'
WHERE "key" = 'googleMapsUrl'
  AND (jsonb_typeof("value") <> 'string' OR BTRIM("value" #>> '{}') !~ '^https://');
