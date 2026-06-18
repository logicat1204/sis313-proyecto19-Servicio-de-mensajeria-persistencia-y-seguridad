#!/bin/bash
# ============================================================
#  chat_restore.sh — Restauración con verificación de integridad
#  Proyecto 19: Servicio de Mensajería — SIS313
# ============================================================
set -euo pipefail

DB_NAME="chat_db"
BACKUP_DIR="/var/backups/chat_messages"
LOG_FILE="/var/log/chat_backup.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] RESTORE: $*" | tee -a "$LOG_FILE"; }

echo "=== RESTAURACIÓN DE CONVERSACIÓN - PROYECTO 19 ==="
echo "Backups disponibles:"
ls -lht "$BACKUP_DIR"/*.sql.gz 2>/dev/null | head -20 || { echo "No hay backups."; exit 1; }

echo ""
echo "Enter para usar el más reciente o ingresa nombre del archivo:"
read -r SELECTED

if [ -z "$SELECTED" ]; then
    BACKUP_FILE=$(ls -1t "$BACKUP_DIR"/*.sql.gz | head -1)
else
    BACKUP_FILE="$BACKUP_DIR/$SELECTED"
fi

[ ! -f "$BACKUP_FILE" ] && { log "ERROR: $BACKUP_FILE no existe."; exit 1; }

log "Verificando integridad..."
gzip -t "$BACKUP_FILE" 2>/dev/null || { log "ERROR: Backup corrupto."; exit 1; }
log "Integridad: OK"

echo ""
echo "⚠️  Esto eliminará los datos actuales de '$DB_NAME'."
read -p "Escriba 'RESTAURAR' para continuar: " CONFIRM
[ "$CONFIRM" != "RESTAURAR" ] && { echo "Cancelado."; exit 0; }

log "Restaurando desde $BACKUP_FILE..."
START_TIME=$(date +%s)
mysql --defaults-file=/etc/.chat_backup.cnf -e "DROP DATABASE IF EXISTS $DB_NAME;"
zcat "$BACKUP_FILE" | mysql --defaults-file=/etc/.chat_backup.cnf
END_TIME=$(date +%s)
RTO=$((END_TIME - START_TIME))

MENSAJES=$(mysql --defaults-file=/etc/.chat_backup.cnf -N -e "SELECT COUNT(*) FROM ${DB_NAME}.messages;" 2>/dev/null || echo "0")
log "Restauración completada en ${RTO}s. Mensajes recuperados: $MENSAJES"
echo "✅ RTO: ${RTO}s | Mensajes: $MENSAJES"
