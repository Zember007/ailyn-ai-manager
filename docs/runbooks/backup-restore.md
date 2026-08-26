# Backup And Restore Runbook

Daily PostgreSQL backups are created by `ailyn-postgres-backup.timer`.

Manual backup on production:

```bash
/opt/ailyn/app/scripts/backup.sh
```

Backups are stored in `/opt/ailyn/backups` and retained for 7 days by default.

Restore is never automatic. To restore manually:

```bash
CONFIRM_RESTORE=restore-production-db /opt/ailyn/app/scripts/restore.sh /opt/ailyn/backups/<backup-file>.sql.gz
```

Run restore only after confirming the target database and backup file.
