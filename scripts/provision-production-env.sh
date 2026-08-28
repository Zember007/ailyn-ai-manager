#!/usr/bin/env bash
set -Eeuo pipefail

ENV_FILE="${ENV_FILE:-/opt/ailyn/.env.production}"

managed_keys=(
  NODE_ENV
  APP_VERSION
  APP_SECRET
  API_PORT
  ADMIN_PORT
  POSTGRES_DB
  POSTGRES_USER
  POSTGRES_PASSWORD
  REDIS_PASSWORD
  DATABASE_URL
  REDIS_URL
  S3_ENDPOINT
  S3_BUCKET
  S3_ACCESS_KEY
  S3_SECRET_KEY
  AI_PROVIDER
  ROUTERAI_API_KEY
  ROUTERAI_TEXT_MODEL
  ROUTERAI_VISION_MODEL
  ROUTERAI_EVAL_MODEL
  ROUTERAI_TIMEOUT_MS
  ROUTERAI_MAX_RETRIES
  WHATSAPP_PROVIDER
  WAZZUP_API_KEY
  WAZZUP_BASE_URL
  WAZZUP_CHANNEL_ID
  WAZZUP_WEBHOOK_SECRET
  WAZZUP_PHONE_NUMBER
)

is_managed_key() {
  local candidate="$1"
  local key

  for key in "${managed_keys[@]}"; do
    if [[ "${key}" == "${candidate}" ]]; then
      return 0
    fi
  done

  return 1
}

array_contains() {
  local candidate="$1"
  shift
  local item

  for item in "$@"; do
    if [[ "${item}" == "${candidate}" ]]; then
      return 0
    fi
  done

  return 1
}

get_existing_value() {
  local key="$1"

  if [[ ! -f "${ENV_FILE}" ]]; then
    return 0
  fi

  grep "^${key}=" "${ENV_FILE}" | tail -n 1 | cut -d= -f2- || true
}

is_internal_database_url() {
  local url="$1"
  [[ "${url}" =~ ^postgres(ql)?://[^@]+@postgres:5432/ ]]
}

is_internal_redis_url() {
  local url="$1"
  [[ "${url}" =~ ^redis://:.*@redis:6379(/.*)?$ ]]
}

percent_encode() {
  local value="${1-}"
  local encoded=""
  local char
  local hex
  local i

  for ((i = 0; i < ${#value}; i++)); do
    char="${value:i:1}"
    case "${char}" in
      [a-zA-Z0-9.~_-])
        encoded+="${char}"
        ;;
      *)
        printf -v hex '%02X' "'${char}"
        encoded+="%${hex}"
        ;;
    esac
  done

  printf '%s' "${encoded}"
}

build_internal_database_url() {
  printf 'postgresql://%s:%s@postgres:5432/%s?schema=public' \
    "$(percent_encode "${postgres_user}")" \
    "$(percent_encode "${postgres_password}")" \
    "$(percent_encode "${postgres_db}")"
}

build_internal_redis_url() {
  printf 'redis://:%s@redis:6379' "$(percent_encode "${redis_password}")"
}

pick_value() {
  local key="$1"
  local fallback="${2:-}"
  local env_value="${!key-}"
  local file_value

  if [[ -n "${env_value}" ]]; then
    printf '%s' "${env_value}"
    return 0
  fi

  file_value="$(get_existing_value "${key}")"
  if [[ -n "${file_value}" ]]; then
    printf '%s' "${file_value}"
    return 0
  fi

  printf '%s' "${fallback}"
}

postgres_db="$(pick_value POSTGRES_DB ailyn)"
postgres_user="$(pick_value POSTGRES_USER ailyn)"
postgres_password="$(pick_value POSTGRES_PASSWORD "$(openssl rand -hex 32)")"
redis_password="$(pick_value REDIS_PASSWORD "$(openssl rand -hex 32)")"
app_secret="$(pick_value APP_SECRET "$(openssl rand -hex 48)")"
s3_access_key="$(pick_value S3_ACCESS_KEY ailyn-s3)"
s3_secret_key="$(pick_value S3_SECRET_KEY "$(openssl rand -hex 32)")"
existing_database_url="$(get_existing_value DATABASE_URL)"
existing_redis_url="$(get_existing_value REDIS_URL)"

if [[ -n "${DATABASE_URL-}" ]]; then
  database_url="${DATABASE_URL}"
elif [[ -n "${existing_database_url}" ]] && ! is_internal_database_url "${existing_database_url}"; then
  database_url="${existing_database_url}"
else
  database_url="$(build_internal_database_url)"
fi

if [[ -n "${REDIS_URL-}" ]]; then
  redis_url="${REDIS_URL}"
elif [[ -n "${existing_redis_url}" ]] && ! is_internal_redis_url "${existing_redis_url}"; then
  redis_url="${existing_redis_url}"
else
  redis_url="$(build_internal_redis_url)"
fi

extras=()
if [[ -f "${ENV_FILE}" ]]; then
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    [[ "${line}" != *=* ]] && continue

    key="${line%%=*}"
    if is_managed_key "${key}"; then
      continue
    fi

    if [[ "${#extras[*]}" -eq 0 ]] || ! array_contains "${key}" "${extras[@]}"; then
      extras+=("${key}")
    fi
  done < "${ENV_FILE}"
fi

tmpfile="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"

write_key() {
  local key="$1"
  local value="$2"
  printf '%s=%s\n' "${key}" "${value}" >> "${tmpfile}"
}

write_key "NODE_ENV" "$(pick_value NODE_ENV production)"
write_key "APP_VERSION" "$(pick_value APP_VERSION 0.1.0)"
write_key "APP_SECRET" "${app_secret}"
write_key "API_PORT" "$(pick_value API_PORT 3001)"
write_key "ADMIN_PORT" "$(pick_value ADMIN_PORT 3000)"
write_key "POSTGRES_DB" "${postgres_db}"
write_key "POSTGRES_USER" "${postgres_user}"
write_key "POSTGRES_PASSWORD" "${postgres_password}"
write_key "REDIS_PASSWORD" "${redis_password}"
write_key "DATABASE_URL" "${database_url}"
write_key "REDIS_URL" "${redis_url}"
write_key "S3_ENDPOINT" "$(pick_value S3_ENDPOINT http://minio:9000)"
write_key "S3_BUCKET" "$(pick_value S3_BUCKET ailyn-stage1)"
write_key "S3_ACCESS_KEY" "${s3_access_key}"
write_key "S3_SECRET_KEY" "${s3_secret_key}"
write_key "AI_PROVIDER" "$(pick_value AI_PROVIDER routerai)"
write_key "ROUTERAI_API_KEY" "$(pick_value ROUTERAI_API_KEY)"
write_key "ROUTERAI_TEXT_MODEL" "$(pick_value ROUTERAI_TEXT_MODEL)"
write_key "ROUTERAI_VISION_MODEL" "$(pick_value ROUTERAI_VISION_MODEL)"
write_key "ROUTERAI_EVAL_MODEL" "$(pick_value ROUTERAI_EVAL_MODEL)"
write_key "ROUTERAI_TIMEOUT_MS" "$(pick_value ROUTERAI_TIMEOUT_MS 30000)"
write_key "ROUTERAI_MAX_RETRIES" "$(pick_value ROUTERAI_MAX_RETRIES 2)"
write_key "WHATSAPP_PROVIDER" "$(pick_value WHATSAPP_PROVIDER wazzup)"
write_key "WAZZUP_API_KEY" "$(pick_value WAZZUP_API_KEY)"
write_key "WAZZUP_BASE_URL" "$(pick_value WAZZUP_BASE_URL)"
write_key "WAZZUP_CHANNEL_ID" "$(pick_value WAZZUP_CHANNEL_ID)"
write_key "WAZZUP_WEBHOOK_SECRET" "$(pick_value WAZZUP_WEBHOOK_SECRET)"
write_key "WAZZUP_PHONE_NUMBER" "$(pick_value WAZZUP_PHONE_NUMBER)"

if [[ "${#extras[@]}" -gt 0 ]]; then
  for key in "${extras[@]}"; do
    write_key "${key}" "$(get_existing_value "${key}")"
  done
fi

install -m 600 "${tmpfile}" "${ENV_FILE}"
rm -f "${tmpfile}"
echo "Provisioned ${ENV_FILE}"
