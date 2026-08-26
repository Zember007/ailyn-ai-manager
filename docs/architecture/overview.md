# Ailyn Architecture Overview

Ailyn is a pnpm monorepo with:

- `apps/api`: NestJS API with Prisma, Redis, health checks, domain modules, and integration boundaries.
- `apps/admin`: Next.js internal admin/test interface.
- `packages/business-rules`: deterministic TypeScript business rules layer. It intentionally does not depend on OpenAI.
- `packages/shared`, `packages/schemas`, `packages/config`: shared contracts, validation schemas, and runtime config.
- `infra`: Docker and Nginx infrastructure.
- `scripts`: deployment, backup, restore, and production bootstrap helpers.

Production runs on Docker Compose behind Nginx. PostgreSQL and Redis are private Docker-network services and are not published to the Internet.
