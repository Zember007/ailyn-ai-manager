#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/restore.sh /opt/ailyn/backups/ailyn-postgres-YYYYMMDDTHHMMSSZ.sql.gz" >&2
  exit 2
fi

BACKUP_FILE="$1"
APP_DIR="${APP_DIR:-/opt/ailyn/app}"
COMPOSE_FILE="${COMPOSE_FILE:-compose.production.yml}"
ENV_FILE="${ENV_FILE:-/opt/ailyn/.env.production}"

test -s "${BACKUP_FILE}"
cd "${APP_DIR}"

echo "This will restore PostgreSQL from ${BACKUP_FILE}."
echo "Set CONFIRM_RESTORE=restore-production-db to continue."
if [[ "${CONFIRM_RESTORE:-}" != "restore-production-db" ]]; then
  exit 1
fi

gzip -dc "${BACKUP_FILE}" | docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T postgres \
  sh -c 'psql -U "${POSTGRES_USER:-ailyn}" "${POSTGRES_DB:-ailyn}"'
