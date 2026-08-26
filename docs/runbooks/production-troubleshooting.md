# Production Troubleshooting

Check service status:

```bash
cd /opt/ailyn/app
docker compose --env-file /opt/ailyn/.env.production -f compose.production.yml ps
```

Check safe recent logs:

```bash
docker compose --env-file /opt/ailyn/.env.production -f compose.production.yml logs --tail=120 api nginx
```

Health endpoint:

```bash
curl -fsS http://62.60.217.110/api/health
```

PostgreSQL and Redis ports must not be published. Verify with:

```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```
