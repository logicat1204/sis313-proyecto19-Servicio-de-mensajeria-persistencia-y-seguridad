#!/bin/bash
# ============================================================
#  chat_backup.sh — Backup automático en VM-DB2 (réplica)
#  Proyecto 19: Servicio de Mensajería — SIS313
#  Cron: */15 * * * * /opt/backup_scripts/chat_backup.sh
# ============================================================
set -euo pipefail

DB_NAME="chat_db"
BACKUP_DIR="/var/backups/chat_messages"
MAX_BACKUPS=100
FECHA=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/${DB_NAME}-${FECHA}.sql.gz"
LOG_FILE="/var/log/chat_backup.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

if ! systemctl is-active --quiet mariadb; then
    log "ERROR: MariaDB no está activo. Abortando backup."; exit 1
fi

log "Iniciando backup de $DB_NAME en réplica..."
mkdir -p "$BACKUP_DIR"

# Pausar replicación momentáneamente para backup consistente
mysql --defaults-file=/etc/.chat_backup.cnf -e "STOP SLAVE SQL_THREAD;"

mysqldump --defaults-file=/etc/.chat_backup.cnf \
          --databases "$DB_NAME" \
          --single-transaction \
          --routines --triggers --events \
          | gzip -9 > "$BACKUP_FILE"

STATUS=$?

# Reanudar replicación
mysql --defaults-file=/etc/.chat_backup.cnf -e "START SLAVE SQL_THREAD;"

if [ $STATUS -eq 0 ] && gzip -t "$BACKUP_FILE" 2>/dev/null; then
    SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
    log "Backup creado: $BACKUP_FILE ($SIZE) — Integridad: OK"
else
    log "ERROR: Backup fallido o corrupto."; rm -f "$BACKUP_FILE"; exit 1
fi

# Rotación: mantener solo los últimos MAX_BACKUPS
TOTAL=$(ls -1 "$BACKUP_DIR"/*.sql.gz 2>/dev/null | wc -l)
if [ "$TOTAL" -gt "$MAX_BACKUPS" ]; then
    ELIMINAR=$((TOTAL - MAX_BACKUPS))
    ls -1t "$BACKUP_DIR"/*.sql.gz | tail -"$ELIMINAR" | xargs rm -f
    log "Rotación: $ELIMINAR backup(s) eliminados."
fi

log "Backup finalizado."
