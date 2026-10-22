#!/bin/sh
# Penyelamat database via Google Drive (2026-10-22): hosting ini penyimpanannya
# sementara — tiap deploy/restart, file database lokal hilang. Maka:
#  - saat boot: bila file lokal tidak ada, tarik foto terakhir dari Drive.
#  - selama jalan: foto database diunggah ke Drive tiap DB_BACKUP_INTERVAL detik.
#  - saat dimatikan (deploy): foto terakhir diunggah sebelum keluar.
# Aktif hanya bila DB_BACKUP_REMOTE terisi (contoh: gdrive:hestiaflow-db/hestiaflow.db)
# dan rclone terkonfigurasi lewat env RCLONE_CONFIG_*. Tanpa itu, perilaku lama.
set -u
DB="${DATABASE_PATH:-/app/data/hestiaflow.db}"
mkdir -p "$(dirname "$DB")"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REMOTE="${DB_BACKUP_REMOTE:-}"
INTERVAL="${DB_BACKUP_INTERVAL:-300}"

snapshot() {
  node "$SCRIPT_DIR/db-snapshot.mjs" "$DB" "$DB.snap" >/dev/null 2>&1 \
    && rclone copyto "$DB.snap" "$REMOTE" --quiet 2>/dev/null \
    && echo "[penyelamat-db] foto terunggah ke Drive" || echo "[penyelamat-db] foto GAGAL (dicoba lagi nanti)"
  rm -f "$DB.snap"
}

if [ -n "$REMOTE" ] && command -v rclone >/dev/null 2>&1; then
  if [ ! -f "$DB" ]; then
    if rclone copyto "$REMOTE" "$DB" --quiet 2>/dev/null; then
      echo "[penyelamat-db] database dipulihkan dari Drive"
    else
      echo "[penyelamat-db] belum ada foto di Drive — mulai dari database baru"
    fi
  fi
  ( while sleep "$INTERVAL"; do snapshot; done ) &
  LOOP=$!
  cleanup() {
    kill "$NODE" 2>/dev/null; wait "$NODE" 2>/dev/null
    snapshot
    kill "$LOOP" 2>/dev/null
    exit 0
  }
  trap cleanup TERM INT
  echo "[penyelamat-db] aktif — foto tiap ${INTERVAL}s ke $REMOTE"
  node server.js &
  NODE=$!
  wait "$NODE"
  CODE=$?
  kill "$LOOP" 2>/dev/null
  exit "$CODE"
fi
exec node server.js
