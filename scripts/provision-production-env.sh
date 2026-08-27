#!/usr/bin/env bash
set -Eeuo pipefail

ENV_FILE="${ENV_FILE:-/opt/ailyn/.env.production}"

ensure_key() {
  local key="$1"
  local value="$2"

  if grep -q "^${key}=" "${ENV_FILE}"; then
    return 0
  fi

  printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
}

get_existing_value() {
  local key="$1"

  if [[ ! -f "${ENV_FILE}" ]]; then
    return 0
  fi

  grep "^${key}=" "${ENV_FILE}" | head -n 1 | cut -d= -f2- || true
}

postgres_db="${POSTGRES_DB:-$(get_existing_value POSTGRES_DB)}"
postgres_user="${POSTGRES_USER:-$(get_existing_value POSTGRES_USER)}"
postgres_password="${POSTGRES_PASSWORD:-$(get_existing_value POSTGRES_PASSWORD)}"
redis_password="${REDIS_PASSWORD:-$(get_existing_value REDIS_PASSWORD)}"
app_secret="${APP_SECRET:-$(get_existing_value APP_SECRET)}"
s3_access_key="${S3_ACCESS_KEY:-$(get_existing_value S3_ACCESS_KEY)}"
s3_secret_key="${S3_SECRET_KEY:-$(get_existing_value S3_SECRET_KEY)}"

postgres_db="${postgres_db:-ailyn}"
postgres_user="${postgres_user:-ailyn}"
postgres_password="${postgres_password:-$(openssl rand -hex 32)}"
redis_password="${redis_password:-$(openssl rand -hex 32)}"
app_secret="${app_secret:-$(openssl rand -hex 48)}"
s3_access_key="${s3_access_key:-ailyn-s3}"
s3_secret_key="${s3_secret_key:-$(openssl rand -hex 32)}"
database_url="postgresql://${postgres_user}:${postgres_password}@postgres:5432/${postgres_db}?schema=public"
redis_url="redis://:${redis_password}@redis:6379"

if [[ -f "${ENV_FILE}" ]]; then
  ensure_key "NODE_ENV" "production"
  ensure_key "APP_VERSION" "0.1.0"
  ensure_key "APP_SECRET" "${app_secret}"
  ensure_key "API_PORT" "3001"
  ensure_key "ADMIN_PORT" "3000"
  ensure_key "POSTGRES_DB" "${postgres_db}"
  ensure_key "POSTGRES_USER" "${postgres_user}"
  ensure_key "POSTGRES_PASSWORD" "${postgres_password}"
  ensure_key "REDIS_PASSWORD" "${redis_password}"
  ensure_key "DATABASE_URL" "${database_url}"
  ensure_key "REDIS_URL" "${redis_url}"
  ensure_key "S3_ENDPOINT" "http://minio:9000"
  ensure_key "S3_BUCKET" "ailyn-stage1"
  ensure_key "S3_ACCESS_KEY" "${s3_access_key}"
  ensure_key "S3_SECRET_KEY" "${s3_secret_key}"
  ensure_key "AI_PROVIDER" "routerai"
  ensure_key "ROUTERAI_API_KEY" ""
  ensure_key "ROUTERAI_TEXT_MODEL" ""
  ensure_key "ROUTERAI_VISION_MODEL" ""
  ensure_key "ROUTERAI_EVAL_MODEL" ""
  ensure_key "ROUTERAI_TIMEOUT_MS" "30000"
  ensure_key "ROUTERAI_MAX_RETRIES" "2"
  ensure_key "WHATSAPP_PROVIDER" "wazzup"
  ensure_key "WAZZUP_API_KEY" ""
  ensure_key "WAZZUP_BASE_URL" ""
  ensure_key "WAZZUP_CHANNEL_ID" ""
  ensure_key "WAZZUP_WEBHOOK_SECRET" ""
  ensure_key "WAZZUP_PHONE_NUMBER" ""
  chmod 600 "${ENV_FILE}"
  echo "${ENV_FILE} already exists; missing keys were appended."
  exit 0
fi

cat > "${ENV_FILE}" <<EOF
NODE_ENV=production
APP_VERSION=0.1.0
APP_SECRET=${app_secret}
API_PORT=3001
ADMIN_PORT=3000
POSTGRES_DB=ailyn
POSTGRES_USER=ailyn
POSTGRES_PASSWORD=${postgres_password}
REDIS_PASSWORD=${redis_password}
DATABASE_URL=${database_url}
REDIS_URL=${redis_url}
S3_ENDPOINT=http://minio:9000
S3_BUCKET=ailyn-stage1
S3_ACCESS_KEY=${s3_access_key}
S3_SECRET_KEY=${s3_secret_key}
AI_PROVIDER=routerai
ROUTERAI_API_KEY=
ROUTERAI_TEXT_MODEL=
ROUTERAI_VISION_MODEL=
ROUTERAI_EVAL_MODEL=
ROUTERAI_TIMEOUT_MS=30000
ROUTERAI_MAX_RETRIES=2
WHATSAPP_PROVIDER=wazzup
WAZZUP_API_KEY=
WAZZUP_BASE_URL=
WAZZUP_CHANNEL_ID=
WAZZUP_WEBHOOK_SECRET=
WAZZUP_PHONE_NUMBER=
EOF

chmod 600 "${ENV_FILE}"
echo "Created ${ENV_FILE}"
