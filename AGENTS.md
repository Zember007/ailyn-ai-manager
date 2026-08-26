# Ailyn Agent Guide

## Architecture

Ailyn is a pnpm monorepo with a NestJS API, Next.js admin UI, shared packages, Prisma/PostgreSQL, Redis, Docker Compose, and Nginx.

## Project Structure

- `apps/api`: backend API and Prisma schema.
- `apps/admin`: internal admin interface.
- `packages/business-rules`: deterministic financial/business logic.
- `packages/shared`: shared TypeScript contracts.
- `packages/schemas`: validation schemas.
- `packages/config`: runtime configuration helpers.
- `infra`: Docker and Nginx configuration.
- `scripts`: deploy, backup, restore, and provisioning helpers.
- `docs`: architecture and runbooks.

## Development Commands

- `pnpm install`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:scenarios`
- `pnpm build`

## Deployment Commands

- Manual deploy: `scripts/deploy.sh`
- Production migration: `pnpm --filter @ailyn/api prisma:migrate:deploy`
- Production compose: `docker compose --env-file /opt/ailyn/.env.production -f compose.production.yml up -d`

## Security Rules

- NEVER commit secrets.
- NEVER commit `.env` files other than `.env.example`.
- NEVER commit deploy private keys.
- NEVER print production infrastructure secrets in final reports.
- PostgreSQL and Redis must not be exposed to the Internet.

## Git Rules

- Use `main`.
- NEVER force push `main`.
- Run tests before commits and deployments.
- Keep commits meaningful and scoped by phase.

## Database Rules

- ALWAYS run `prisma migrate deploy` in production.
- NEVER run `prisma migrate reset` on production.
- NEVER run `prisma migrate dev` on production.
- Preserve client fact history; do not overwrite facts without retaining previous values/history.

## Production Safety Rules

- NEVER run `docker compose down -v` on production.
- Do not disable root SSH access during bootstrap.
- Use `root` only for initial VPS bootstrap.
- Use `ailyn` for normal deployment.
- Keep `/opt/ailyn/.env.production` outside Git and mode `600`.

## Business Rules

- NEVER make an LLM responsible for deterministic financial rules.
- Loan eligibility, limits, refusal reasons, programs, and financial terms must be TypeScript business rules.
- If the business specification is missing, return `not_configured` or `needs_review` instead of inventing logic.
