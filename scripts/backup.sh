#!/usr/bin/env bash
# LeadOps Portal — Database Backup Script
# Usage: bash scripts/backup.sh [--no-encrypt] [--output-dir <path>]
# Prerequisites: pg_dump 16+, DATABASE_OWNER_URL set, BACKUP_ENCRYPTION_KEY if encrypting
# Output: timestamped custom-format dump with checksum (optionally encrypted)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
ENCRYPT="${ENCRYPT:-true}"
ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-}"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-encrypt) ENCRYPT="false"; shift ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --retention-days) RETENTION_DAYS="$2"; shift 2 ;;
    --database-url) DATABASE_OWNER_URL="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
if [ -z "${DATABASE_OWNER_URL:-}" ]; then
  echo "ERROR: DATABASE_OWNER_URL is not set"
  echo "Set it via environment or --database-url"
  exit 1
fi

if [ "$DATABASE_OWNER_URL" = "postgresql://leadops:leadops_dev@localhost:5432/leadops" ]; then
  echo "WARNING: Using default development database URL"
fi

if [ "$ENCRYPT" = "true" ] && [ -z "$ENCRYPTION_KEY" ]; then
  echo "ERROR: ENCRYPT=true but BACKUP_ENCRYPTION_KEY is not set"
  echo "Set BACKUP_ENCRYPTION_KEY in the environment or use --no-encrypt"
  exit 1
fi

if [ "$ENCRYPT" = "true" ] && ! command -v openssl &>/dev/null; then
  echo "ERROR: openssl not found. Cannot encrypt."
  exit 1
fi

if ! command -v sha256sum &>/dev/null && ! command -v shasum &>/dev/null; then
  echo "ERROR: A SHA-256 checksum tool (sha256sum or shasum) is required"
  exit 1
fi

# ---------------------------------------------------------------------------
# Create output directory
# ---------------------------------------------------------------------------
mkdir -p "$OUTPUT_DIR"

# ---------------------------------------------------------------------------
# Generate backup filename
# ---------------------------------------------------------------------------
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="$OUTPUT_DIR/leadops-backup-$TIMESTAMP.dump"
CHECKSUM_FILE="$BACKUP_FILE.sha256"

echo "============================================"
echo "  LeadOps Portal — Database Backup"
echo "============================================"
echo "Timestamp:    $TIMESTAMP"
echo "Output:       $BACKUP_FILE"
echo "Retention:    $RETENTION_DAYS days"
echo "Encrypt:      $ENCRYPT"
echo "============================================"

# ---------------------------------------------------------------------------
# [1/4] Execute pg_dump (custom format)
# ---------------------------------------------------------------------------
echo "[1/4] Running pg_dump..."
pg_dump \
  --format=custom \
  --verbose \
  --no-owner \
  --no-privileges \
  --compress=9 \
  --file="$BACKUP_FILE" \
  "$DATABASE_OWNER_URL"

BACKUP_SIZE="$(du -h "$BACKUP_FILE" | cut -f1)"
echo "  Backup size: $BACKUP_SIZE"

# ---------------------------------------------------------------------------
# [2/4] Encrypt (optional)
# ---------------------------------------------------------------------------
if [ "$ENCRYPT" = "true" ]; then
  echo "[2/4] Encrypting backup..."
  ENCRYPTED_FILE="$BACKUP_FILE.enc"

  openssl enc -aes-256-cbc \
    -salt \
    -pbkdf2 \
    -iter 100000 \
    -in "$BACKUP_FILE" \
    -out "$ENCRYPTED_FILE" \
    -pass "pass:$ENCRYPTION_KEY"

  rm "$BACKUP_FILE"
  mv "$ENCRYPTED_FILE" "$BACKUP_FILE"
  echo "  Encrypted with AES-256-CBC"
else
  echo "[2/4] Skipping encryption"
fi

# ---------------------------------------------------------------------------
# [3/4] Generate checksum on the final stored file
# ---------------------------------------------------------------------------
echo "[3/4] Computing SHA-256 checksum..."
if command -v sha256sum &>/dev/null; then
  sha256sum "$BACKUP_FILE" > "$CHECKSUM_FILE"
elif command -v shasum &>/dev/null; then
  shasum -a 256 "$BACKUP_FILE" > "$CHECKSUM_FILE"
else
  echo "ERROR: No SHA-256 checksum tool available"
  exit 1
fi

# ---------------------------------------------------------------------------
# [4/4] Cleanup old backups
# ---------------------------------------------------------------------------
echo "[4/4] Cleaning up backups older than $RETENTION_DAYS days..."
DELETED_COUNT=0
if [ -d "$OUTPUT_DIR" ]; then
  while IFS= read -r -d '' old_file; do
    echo "  Removing: $(basename "$old_file")"
    rm "$old_file"
    DELETED_COUNT=$((DELETED_COUNT + 1))
  done < <(find "$OUTPUT_DIR" -name "leadops-backup-*" -type f -mtime +"$RETENTION_DAYS" -print0 2>/dev/null || true)
fi
echo "  Removed $DELETED_COUNT old backups"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "============================================"
echo "  Backup Complete"
echo "============================================"
echo "File:         $(basename "$BACKUP_FILE")"
echo "Size:         $BACKUP_SIZE"
echo "Checksum:     $(cat "$CHECKSUM_FILE" 2>/dev/null || echo 'N/A')"
echo "Location:     $OUTPUT_DIR"
echo "============================================"
