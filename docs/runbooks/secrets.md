# Secrets Runbook

Repository rules:

- never commit `.env` files
- never commit deploy private keys
- never print production infrastructure secrets in reports

Production secrets live only in:

```bash
/opt/ailyn/.env.production
```

The file must be mode `600`.

Infrastructure secrets generated during bootstrap:

- `POSTGRES_PASSWORD`
- `REDIS_PASSWORD`
- `APP_SECRET`
- `S3_ACCESS_KEY`
- `S3_SECRET_KEY`

External application secrets to add later:

- `ROUTERAI_API_KEY`
- RouterAI model/base URL settings
- Wazzup credentials

If you use bundled MinIO from `compose.production.yml`, set:

- `S3_ENDPOINT=http://minio:9000`
- `S3_BUCKET=ailyn-stage1`

If you use external S3 instead of bundled MinIO, replace those values and provide the external bucket credentials in:

- `S3_ACCESS_KEY`
- `S3_SECRET_KEY`
