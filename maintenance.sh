#!/bin/bash
set -euo pipefail  # Строгая проверка ошибок

LOG_FILE="/var/log/docker-maintenance.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Функция для записи логов с временем
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# --- Начало работы ---
log "=== НАЧАЛО ОБСЛУЖИВАНИЯ ==="
log "Запуск от пользователя: $(whoami)"
log "Командная строка: $@"

# --- Очистка Docker ---
log "Очистка Docker (system prune -af)..."
if docker system prune -af >> "$LOG_FILE" 2>&1; then
    log "Docker успешно очищен"
else
    log "ERROR: Ошибка при очистке Docker"
fi

# --- Мониторинг диска ---
DISK_USAGE=$(df -h / | tail -1 | awk '{print $5}')
DISK_SIZE=$(df -h / | tail -1 | awk '{print $2}')
DISK_AVAIL=$(df -h / | tail -1 | awk '{print $4}')

log "Статус диска: Использовано ${DISK_USAGE} из ${DISK_SIZE} (свободно ${DISK_AVAIL})"

# --- Проверка критичных порогов ---
DISK_PERCENT=$(echo "$DISK_USAGE" | sed 's/%//')
if [[ $DISK_PERCENT -gt 85 ]]; then
    log "⚠️ WARNING: Использование диска превышает 85%! Текущее: ${DISK_PERCENT}%"
elif [[ $DISK_PERCENT -gt 90 ]]; then
    log "🔴 CRITICAL: Использование диска превышает 90%! Срочно очистите!"
fi

# --- Финал ---
log "=== КОНЕЦ ОБСЛУЖИВАНИЯ ==="