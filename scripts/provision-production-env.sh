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
OPENAI_API_KEY=
TELEGRAM_BOT_TOKEN=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
S3_ENDPOINT=
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=
EOF

chmod 600 "${ENV_FILE}"
echo "Created ${ENV_FILE}"
