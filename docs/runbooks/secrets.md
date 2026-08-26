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

External application secrets to add later:

- `OPENAI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- WhatsApp credentials
- S3 credentials if external media storage is selected
