#!/usr/bin/env bash
# LeadOps Portal — Database Restore Script
# Usage: bash scripts/restore.sh <backup-file> [--target-db <name>] [--confirm] [--overwrite]
# Prerequisites: pg_restore 16+, DATABASE_OWNER_URL set
# Restores to an ISOLATED database. Never overwrites the production database.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Cleanup handler for decrypted temporary files
# ---------------------------------------------------------------------------
cleanup() {
  if [ -n "${DECRYPTED_FILE:-}" ] && [ -f "${DECRYPTED_FILE:-}" ]; then
    rm -f "$DECRYPTED_FILE"
  fi
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
BACKUP_FILE=""
TARGET_DB=""
CONFIRM=false
OVERWRITE=false
DECRYPT_KEY="${BACKUP_ENCRYPTION_KEY:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-db) TARGET_DB="$2"; shift 2 ;;
    --confirm) CONFIRM=true; shift ;;
    --overwrite) OVERWRITE=true; shift ;;
    --decrypt-key) DECRYPT_KEY="$2"; shift 2 ;;
    --database-url) DATABASE_OWNER_URL="$2"; shift 2 ;;
    -*)
      if [ -z "$BACKUP_FILE" ] && [ -f "$1" ]; then
        BACKUP_FILE="$1"
        shift
      else
        echo "Unknown option: $1"; exit 1
      fi
      ;;
    *)
      if [ -z "$BACKUP_FILE" ]; then
        BACKUP_FILE="$1"
        shift
      else
        echo "Unknown argument: $1"; exit 1
      fi
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
if [ -z "$BACKUP_FILE" ]; then
  echo "ERROR: Backup file is required"
  echo "Usage: bash scripts/restore.sh <backup-file.dump> [--target-db <name>] [--confirm] [--overwrite]"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: Backup file not found: $BACKUP_FILE"
  exit 1
fi

if [ -z "${DATABASE_OWNER_URL:-}" ]; then
  echo "ERROR: DATABASE_OWNER_URL is not set"
  echo "Set it via environment or --database-url"
  exit 1
fi

# ---------------------------------------------------------------------------
# Determine target database
# ---------------------------------------------------------------------------
if [ -z "$TARGET_DB" ]; then
  TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  TARGET_DB="leadops_restore_$TIMESTAMP"
  echo "No --target-db specified. Using: $TARGET_DB"
fi

if [[ ! "$TARGET_DB" =~ ^[A-Za-z][A-Za-z0-9_]{0,62}$ ]]; then
  echo "ERROR: Target database name must match ^[A-Za-z][A-Za-z0-9_]{0,62}$"
  exit 1
fi

# ---------------------------------------------------------------------------
# Extract base connection URL and current database name
# ---------------------------------------------------------------------------
BASE_URL="$(echo "$DATABASE_OWNER_URL" | sed 's|/[^/?]*$||')"
CURRENT_DB="$(echo "$DATABASE_OWNER_URL" | sed -n 's|.*/\([^/?]*\).*|\1|p')"

# ---------------------------------------------------------------------------
# Safety: reject protected database names
# ---------------------------------------------------------------------------
if [ -n "$CURRENT_DB" ] && [ "$TARGET_DB" = "$CURRENT_DB" ]; then
  echo "ERROR: Target database '$TARGET_DB' matches the current DATABASE_OWNER_URL database"
  echo "Refusing to restore into the database referenced by DATABASE_OWNER_URL"
  exit 1
fi

case "$TARGET_DB" in
  postgres|template0|template1)
    echo "ERROR: Cannot restore to system database '$TARGET_DB'"
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Require --confirm for safety
# ---------------------------------------------------------------------------
if [ "$CONFIRM" = false ]; then
  echo "============================================"
  echo "  WARNING: Database restore operation"
  echo "============================================"
  echo "Backup file:  $(basename "$BACKUP_FILE")"
  echo "Target DB:    $TARGET_DB"
  echo "Base URL:     $BASE_URL"
  echo "============================================"
  echo "Use --confirm to proceed with the restore."
  exit 1
fi

# ---------------------------------------------------------------------------
# [1/5] Verify checksum (always against the stored backup file)
# ---------------------------------------------------------------------------
echo "[1/5] Verifying file integrity..."
CHECKSUM_FILE="${BACKUP_FILE}.sha256"
if [ -f "$CHECKSUM_FILE" ]; then
  if command -v sha256sum &>/dev/null; then
    EXPECTED="$(awk '{print $1}' "$CHECKSUM_FILE")"
    ACTUAL="$(sha256sum "$BACKUP_FILE" | awk '{print $1}')"
    if [ "$EXPECTED" = "$ACTUAL" ]; then
      echo "  SHA-256 checksum verified OK"
    else
      echo "ERROR: SHA-256 checksum verification FAILED"
      echo "  Expected: $EXPECTED"
      echo "  Actual:   $ACTUAL"
      exit 1
    fi
  elif command -v shasum &>/dev/null; then
    EXPECTED="$(awk '{print $1}' "$CHECKSUM_FILE")"
    ACTUAL="$(shasum -a 256 "$BACKUP_FILE" | awk '{print $1}')"
    if [ "$EXPECTED" = "$ACTUAL" ]; then
      echo "  SHA-256 checksum verified OK"
    else
      echo "ERROR: SHA-256 checksum verification FAILED"
      echo "  Expected: $EXPECTED"
      echo "  Actual:   $ACTUAL"
      exit 1
    fi
  else
    echo "ERROR: No SHA-256 checksum tool available"
    exit 1
  fi
else
  echo "ERROR: Required checksum file not found: $CHECKSUM_FILE"
  exit 1
fi

# ---------------------------------------------------------------------------
# [2/5] Handle encryption and verify backup format
# ---------------------------------------------------------------------------
BACKUP_TO_USE="$BACKUP_FILE"

# Detect AES-256-CBC encrypted file (starts with "Salted__")
if head -c 8 "$BACKUP_FILE" | grep -q "Salted__" 2>/dev/null; then
  echo "[2/5] Decrypting backup and verifying format..."

  if [ -z "$DECRYPT_KEY" ]; then
    echo "ERROR: Encrypted backup requires BACKUP_ENCRYPTION_KEY or --decrypt-key"
    exit 1
  fi

  DECRYPTED_FILE="${BACKUP_FILE}.decrypted"

  openssl enc -d -aes-256-cbc \
    -salt \
    -pbkdf2 \
    -iter 100000 \
    -in "$BACKUP_FILE" \
    -out "$DECRYPTED_FILE" \
    -pass "pass:$DECRYPT_KEY"

  BACKUP_TO_USE="$DECRYPTED_FILE"
  echo "  Decrypted successfully"

  # Verify the decrypted payload is a valid pg_dump custom-format archive
  pg_restore --list "$BACKUP_TO_USE" > /dev/null 2>&1 || {
    echo "ERROR: Decrypted file is not a valid custom-format PostgreSQL dump"
    exit 1
  }
  echo "  Valid custom-format dump"
else
  echo "[2/5] Verifying backup format..."
  pg_restore --list "$BACKUP_TO_USE" > /dev/null 2>&1 || {
    echo "ERROR: Backup file is not a valid custom-format PostgreSQL dump"
    exit 1
  }
  echo "  Valid custom-format dump"
fi

# ---------------------------------------------------------------------------
# [3/5] Create target database
# ---------------------------------------------------------------------------
echo "[3/5] Preparing target database: $TARGET_DB"

DB_EXISTS=$(psql "$BASE_URL/postgres" -t -c "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB';" 2>/dev/null | tr -d ' ' || true)

if [ "$DB_EXISTS" = "1" ]; then
  if [ "$OVERWRITE" = false ]; then
    echo "ERROR: Database '$TARGET_DB' already exists."
    echo "Use --overwrite to drop and recreate it."
    exit 1
  fi
  echo "  Dropping existing database '$TARGET_DB'..."
  psql "$BASE_URL/postgres" -c "DROP DATABASE \"$TARGET_DB\";"
fi

psql "$BASE_URL/postgres" -c "CREATE DATABASE \"$TARGET_DB\";"
echo "  Database '$TARGET_DB' is ready"

# ---------------------------------------------------------------------------
# [4/5] Restore
# ---------------------------------------------------------------------------
echo "[4/5] Restoring backup to $TARGET_DB..."
RESTORE_START="$(date -u +%s)"

pg_restore \
  --dbname="$BASE_URL/$TARGET_DB" \
  --verbose \
  --no-owner \
  --no-privileges \
  --clean \
  --if-exists \
  --single-transaction \
  "$BACKUP_TO_USE"

RESTORE_END="$(date -u +%s)"
RESTORE_DURATION=$((RESTORE_END - RESTORE_START))
echo "  Restore duration: ${RESTORE_DURATION}s"

# ---------------------------------------------------------------------------
# [5/5] Verify restored data
# ---------------------------------------------------------------------------
echo "[5/5] Verifying restored data..."
RESTORE_URL="$BASE_URL/$TARGET_DB"

echo "  Checking tenant tables..."
ORG_COUNT="$(psql "$RESTORE_URL" -t -c 'SELECT count(*) FROM organizations;' | tr -d ' ')"

echo "  Checking business tables..."
EVENT_COUNT="$(psql "$RESTORE_URL" -t -c 'SELECT count(*) FROM business_events;' | tr -d ' ')"

echo "  Checking approvals..."
APPROVAL_COUNT="$(psql "$RESTORE_URL" -t -c 'SELECT count(*) FROM approvals;' | tr -d ' ')"
HISTORY_COUNT="$(psql "$RESTORE_URL" -t -c 'SELECT count(*) FROM approval_history;' | tr -d ' ')"

echo "  Checking audit..."
AUDIT_COUNT="$(psql "$RESTORE_URL" -t -c 'SELECT count(*) FROM audit_logs;' | tr -d ' ')"

echo "  Checking incidents..."
INCIDENT_COUNT="$(psql "$RESTORE_URL" -t -c 'SELECT count(*) FROM incidents;' | tr -d ' ')"

echo "  Checking reports..."
REPORT_COUNT="$(psql "$RESTORE_URL" -t -c 'SELECT count(*) FROM report_snapshots;' | tr -d ' ')"

echo "  Checking migrations..."
MIGRATION_COUNT="$(psql "$RESTORE_URL" -t -c "SELECT count(*) FROM schema_migrations;" | tr -d ' ')"

# ---------------------------------------------------------------------------
# Summary
# (trap handles cleanup of decrypted temporary files on EXIT/INT/TERM)
# ---------------------------------------------------------------------------
echo "============================================"
echo "  Restore Complete"
echo "============================================"
echo "Target DB:    $TARGET_DB"
echo "Duration:     ${RESTORE_DURATION}s"
echo "============================================"
echo "Verified counts:"
echo "  organizations:       $ORG_COUNT"
echo "  business_events:     $EVENT_COUNT"
echo "  approvals:           $APPROVAL_COUNT"
echo "  approval_history:    $HISTORY_COUNT"
echo "  audit_logs:          $AUDIT_COUNT"
echo "  incidents:           $INCIDENT_COUNT"
echo "  report_snapshots:    $REPORT_COUNT"
echo "  schema_migrations:   $MIGRATION_COUNT"
echo "============================================"
