#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-62.60.217.110}"
DEPLOY_USER="${DEPLOY_USER:-ailyn}"
DEPLOY_PORT="${DEPLOY_PORT:-22}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/ailyn/app}"
SSH_KEY="${SSH_KEY:-/Users/georgiiborisov/.ssh/ailyn_vps}"
HEALTH_URL="${HEALTH_URL:-http://62.60.217.110/api/health}"

ssh_target="${DEPLOY_USER}@${DEPLOY_HOST}"
ssh_cmd=(ssh -i "${SSH_KEY}" -p "${DEPLOY_PORT}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "${ssh_target}")

echo "Running local preflight..."
pnpm lint
pnpm typecheck
pnpm test
pnpm test:scenarios
pnpm build

echo "Syncing source to ${ssh_target}:${DEPLOY_PATH}..."
rsync -az --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude ".env" \
  --exclude ".env.*" \
  --exclude "backups" \
  --exclude "data" \
  -e "ssh -i ${SSH_KEY} -p ${DEPLOY_PORT} -o StrictHostKeyChecking=accept-new" \
  ./ "${ssh_target}:${DEPLOY_PATH}/"

echo "Deploying on VPS..."
"${ssh_cmd[@]}" "set -Eeuo pipefail
  cd '${DEPLOY_PATH}'
  ENV_FILE=/opt/ailyn/.env.production ./scripts/provision-production-env.sh
  docker compose --env-file /opt/ailyn/.env.production -f compose.production.yml build
  docker compose --env-file /opt/ailyn/.env.production -f compose.production.yml run -T --rm api sh -lc 'node -e \"new URL(process.env.DATABASE_URL); new URL(process.env.REDIS_URL)\"' < /dev/null
  docker compose --env-file /opt/ailyn/.env.production -f compose.production.yml run -T --rm api sh -lc './apps/api/node_modules/.bin/prisma migrate deploy --schema apps/api/prisma/schema.prisma' < /dev/null
  docker compose --env-file /opt/ailyn/.env.production -f compose.production.yml up -d --remove-orphans --force-recreate minio api admin nginx
  docker compose --env-file /opt/ailyn/.env.production -f compose.production.yml ps
"

echo "Waiting for health endpoint..."
for attempt in {1..30}; do
  if response="$(curl -fsS "${HEALTH_URL}")" && [[ "${response}" == *'"stage":"stage-1"'* ]]; then
    printf '%s\n' "${response}"
    echo
    exit 0
  fi
  sleep 5
done

echo "Healthcheck failed. Safe container status and recent logs:"
"${ssh_cmd[@]}" "cd '${DEPLOY_PATH}' && docker compose --env-file /opt/ailyn/.env.production -f compose.production.yml ps && docker compose --env-file /opt/ailyn/.env.production -f compose.production.yml logs --tail=120 api nginx"
exit 1
