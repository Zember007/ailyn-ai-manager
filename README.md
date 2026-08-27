# Ailyn

Ailyn is a Stage 1 production-ready pnpm monorepo for an AI-assisted manager application.

## Architecture

- `apps/api`: NestJS API, Prisma ORM, Redis/BullMQ-ready infrastructure, health endpoint.
- `apps/admin`: Next.js internal admin/test interface.
- `packages/business-rules`: deterministic TypeScript business rules layer. LLMs do not decide loan terms, limits, refusals, or eligibility.
- `infra`: Docker, Nginx, and production compose configuration.

## Local Setup

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres redis minio
pnpm --filter @ailyn/api prisma:migrate:deploy
pnpm dev
```

## Commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:scenarios
pnpm build
```

## Docker

Local:

```bash
docker compose -f compose.yml up -d --build
```

Production:

```bash
docker compose --env-file /opt/ailyn/.env.production -f compose.production.yml up -d --build
```

PostgreSQL and Redis are internal services only. Do not publish ports `5432` or `6379`.
Local S3-compatible storage is available through MinIO:

- API endpoint: `http://localhost:9000`
- MinIO console: `http://localhost:9001`
- Bucket creation is currently manual if you need a pre-created bucket before wiring file uploads.

## Migrations

Production uses:

```bash
pnpm --filter @ailyn/api prisma:migrate:deploy
```

Never use `prisma migrate reset` on production.

## Deployment

Manual deployment:

```bash
scripts/deploy.sh
```

CI validates lint, typecheck, tests, scenario tests, and build. CD runs after successful CI on `main`, rsyncs source to `/opt/ailyn/app`, builds Docker images on the VPS, applies Prisma migrations, starts services, and checks `/api/health`.

## Production

Initial production URL:

- `http://62.60.217.110`
- `http://62.60.217.110/api/health`

HTTPS is intentionally not configured for the bare IP. The Nginx config is ready for a later domain-based server block and certificate.

## Backups

Daily PostgreSQL backups are stored in `/opt/ailyn/backups` and retained for 7 days.

Manual backup:

```bash
/opt/ailyn/app/scripts/backup.sh
```

Restore requires explicit confirmation; see `docs/runbooks/backup-restore.md`.
