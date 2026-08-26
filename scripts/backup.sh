#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/ailyn/backups}"
APP_DIR="${APP_DIR:-/opt/ailyn/app}"
COMPOSE_FILE="${COMPOSE_FILE:-compose.production.yml}"
ENV_FILE="${ENV_FILE:-/opt/ailyn/.env.production}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="${BACKUP_DIR}/ailyn-postgres-${timestamp}.sql.gz"

mkdir -p "${BACKUP_DIR}"
cd "${APP_DIR}"

docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T postgres \
  sh -c 'pg_dump -U "${POSTGRES_USER:-ailyn}" "${POSTGRES_DB:-ailyn}"' | gzip > "${backup_file}"

test -s "${backup_file}"
find "${BACKUP_DIR}" -name "ailyn-postgres-*.sql.gz" -mtime +"${RETENTION_DAYS}" -delete
echo "Backup created: ${backup_file}"
