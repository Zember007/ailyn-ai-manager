# Deployment Runbook

Production target:

- host: `62.60.217.110`
- user: `ailyn`
- app directory: `/opt/ailyn/app`
- env file: `/opt/ailyn/.env.production`

Manual deployment:

```bash
DEPLOY_HOST=62.60.217.110 DEPLOY_USER=ailyn scripts/deploy.sh
```

The deploy path rebuilds images and force-recreates `api`, `admin`, and `nginx`
so running containers always pick up the newly built image.

Production compose also starts bundled MinIO for S3-compatible media storage.

The current deploy path does not block application startup on bucket creation.
If you need a bucket pre-created before attachment wiring is enabled, create it
manually in MinIO or via `mc`.

Production migrations must use:

```bash
docker compose --env-file /opt/ailyn/.env.production -f compose.production.yml run -T --rm api sh -lc './apps/api/node_modules/.bin/prisma migrate deploy --schema apps/api/prisma/schema.prisma' < /dev/null
```

Rule: if production uses bundled `postgres` and `redis` from `compose.production.yml`, never hand-edit internal `DATABASE_URL` or `REDIS_URL` credentials in `/opt/ailyn/.env.production`. Always regenerate the file via `ENV_FILE=/opt/ailyn/.env.production ./scripts/provision-production-env.sh`, let the deploy pipeline validate both URLs with `new URL(...)`, and only then run Prisma migrations.

Never use `prisma migrate dev`, `prisma migrate reset`, or `docker compose down -v` on production.
