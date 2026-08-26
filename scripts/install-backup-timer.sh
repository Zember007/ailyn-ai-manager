#!/usr/bin/env bash
set -Eeuo pipefail

cat >/etc/systemd/system/ailyn-postgres-backup.service <<'EOF'
[Unit]
Description=Ailyn PostgreSQL backup
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
User=ailyn
Group=ailyn
ExecStart=/opt/ailyn/app/scripts/backup.sh
EOF

cat >/etc/systemd/system/ailyn-postgres-backup.timer <<'EOF'
[Unit]
Description=Run Ailyn PostgreSQL backup daily

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now ailyn-postgres-backup.timer
systemctl list-timers ailyn-postgres-backup.timer --no-pager
