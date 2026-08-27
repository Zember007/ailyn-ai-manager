#!/usr/bin/env bash
set -Eeuo pipefail

ENV_FILE="${ENV_FILE:-/opt/ailyn/.env.production}"

if [[ -f "${ENV_FILE}" ]]; then
  chmod 600 "${ENV_FILE}"
  echo "${ENV_FILE} already exists; leaving it unchanged."
  exit 0
fi

postgres_password="$(openssl rand -hex 32)"
redis_password="$(openssl rand -hex 32)"
app_secret="$(openssl rand -hex 48)"
s3_access_key="ailyn-s3"
s3_secret_key="$(openssl rand -hex 32)"

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
DATABASE_URL=postgresql://ailyn:${postgres_password}@postgres:5432/ailyn?schema=public
REDIS_URL=redis://:${redis_password}@redis:6379
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
