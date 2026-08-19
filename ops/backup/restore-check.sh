#!/usr/bin/env bash
# 从一份 NAS 快照恢复到全新目录，并验证 DB 与所有 DB 引用文件。
set -euo pipefail

snapshot="${1:-}"
target="${2:-}"
[[ -n "$snapshot" && -n "$target" ]] || { echo "Usage: $0 SNAPSHOT_DIR NEW_TARGET_DIR" >&2; exit 2; }
[[ -f "${snapshot}/openlens.sql" ]] || { echo "ERROR: missing ${snapshot}/openlens.sql" >&2; exit 1; }
[[ -f "${snapshot}/manifest.txt" ]] || { echo "ERROR: missing ${snapshot}/manifest.txt" >&2; exit 1; }
[[ -d "${snapshot}/data" ]] || { echo "ERROR: missing ${snapshot}/data" >&2; exit 1; }
[[ ! -e "$target" ]] || { echo "ERROR: target already exists; refusing to overwrite: $target" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "ERROR: sqlite3 is required" >&2; exit 1; }
command -v rsync >/dev/null || { echo "ERROR: rsync is required" >&2; exit 1; }

expected_digest="$(awk -F= '$1 == "sha256" { print $2 }' "${snapshot}/manifest.txt")"
if command -v sha256sum >/dev/null; then
  actual_digest="$(sha256sum "${snapshot}/openlens.sql" | awk '{print $1}')"
else
  actual_digest="$(shasum -a 256 "${snapshot}/openlens.sql" | awk '{print $1}')"
fi
[[ -n "$expected_digest" && "$actual_digest" == "$expected_digest" ]] \
  || { echo "ERROR: dump digest mismatch expected=$expected_digest actual=$actual_digest" >&2; exit 1; }

mkdir -p "$target/data"
rsync -a "${snapshot}/data/" "${target}/data/"
sqlite3 "${target}/openlens.db" < "${snapshot}/openlens.sql"
quick_check="$(sqlite3 "${target}/openlens.db" 'PRAGMA quick_check;')"
[[ "$quick_check" == "ok" ]] || { echo "ERROR: restored database quick_check=$quick_check" >&2; exit 1; }

missing=0
while IFS= read -r relative_path; do
  [[ -z "$relative_path" ]] && continue
  if [[ ! -f "${target}/data/${relative_path}" ]]; then
    echo "MISSING: $relative_path" >&2
    missing=$((missing + 1))
  fi
done < <(sqlite3 -noheader "${target}/openlens.db" \
  "SELECT original_path FROM pages UNION ALL SELECT scan_path FROM pages UNION ALL SELECT path FROM outfits;")
[[ "$missing" -eq 0 ]] || { echo "ERROR: $missing referenced file(s) missing" >&2; exit 1; }

documents="$(sqlite3 "${target}/openlens.db" 'SELECT COUNT(*) FROM docs;')"
pages="$(sqlite3 "${target}/openlens.db" 'SELECT COUNT(*) FROM pages;')"
outfits="$(sqlite3 "${target}/openlens.db" 'SELECT COUNT(*) FROM outfits;')"
echo "RESTORE OK quick_check=$quick_check sha256=$actual_digest docs=$documents pages=$pages outfits=$outfits missing_files=$missing"
