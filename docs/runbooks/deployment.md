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

Production compose also starts bundled MinIO for S3-compatible media storage and
creates the configured bucket on first boot.

Production migrations must use:

```bash
docker compose --env-file /opt/ailyn/.env.production -f compose.production.yml run -T --rm api sh -lc './apps/api/node_modules/.bin/prisma migrate deploy --schema apps/api/prisma/schema.prisma' < /dev/null
```

Never use `prisma migrate dev`, `prisma migrate reset`, or `docker compose down -v` on production.
