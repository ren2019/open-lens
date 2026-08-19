#!/usr/bin/env bash
# 在 Open-Lens 服务器本地生成一致、已验证、原子替换的 SQLite 文本快照。
set -euo pipefail

data_dir="${OPEN_LENS_DATA_DIR:-/var/lib/open-lens}"
export_dir="${OPEN_LENS_EXPORT_DIR:-${data_dir}/.cold-export}"
database="${data_dir}/openlens.db"

command -v sqlite3 >/dev/null || { echo "ERROR: sqlite3 is required" >&2; exit 1; }
[[ -f "$database" ]] || { echo "ERROR: database not found: $database" >&2; exit 1; }
mkdir -p "$export_dir"

lock_dir="${export_dir}/.prepare.lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "ERROR: another prepare is running (or stale lock exists): $lock_dir" >&2
  exit 1
fi

tmp_sql="$(mktemp "${export_dir}/.openlens.sql.XXXXXX")"
tmp_db="$(mktemp "${export_dir}/.restore-check.db.XXXXXX")"
tmp_meta="$(mktemp "${export_dir}/.manifest.XXXXXX")"
cleanup() {
  rm -f "$tmp_sql" "$tmp_db" "$tmp_meta"
  rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 显式读事务固定 source snapshot；`.dump` 输出逻辑备份，不复制可能正在变化的 db/wal/shm 文件。
sqlite3 "$database" '.timeout 10000' 'BEGIN;' '.dump' 'ROLLBACK;' > "$tmp_sql"
sqlite3 "$tmp_db" < "$tmp_sql"
quick_check="$(sqlite3 "$tmp_db" 'PRAGMA quick_check;')"
[[ "$quick_check" == "ok" ]] || { echo "ERROR: restored dump failed quick_check: $quick_check" >&2; exit 1; }

if command -v sha256sum >/dev/null; then
  digest="$(sha256sum "$tmp_sql" | awk '{print $1}')"
else
  digest="$(shasum -a 256 "$tmp_sql" | awk '{print $1}')"
fi

documents="$(sqlite3 "$tmp_db" 'SELECT COUNT(*) FROM docs;')"
pages="$(sqlite3 "$tmp_db" 'SELECT COUNT(*) FROM pages;')"
outfits="$(sqlite3 "$tmp_db" 'SELECT COUNT(*) FROM outfits;')"
created_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
cat > "$tmp_meta" <<EOF
created_at_utc=$created_at
sha256=$digest
quick_check=$quick_check
documents=$documents
pages=$pages
outfits=$outfits
EOF

chmod 0640 "$tmp_sql" "$tmp_meta"
mv -f "$tmp_sql" "${export_dir}/openlens.sql"
mv -f "$tmp_meta" "${export_dir}/manifest.txt"
echo "PREPARE OK created=$created_at docs=$documents pages=$pages outfits=$outfits sha256=$digest"
