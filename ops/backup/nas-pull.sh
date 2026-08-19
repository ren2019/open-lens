#!/usr/bin/env bash
# 在 NAS cron 上运行：服务器生成 dump → NAS rsync pull → 本地恢复校验 → 原子发布快照。
set -euo pipefail

remote="${OPEN_LENS_REMOTE:?set OPEN_LENS_REMOTE (for example openlens-backup@server)}"
remote_data_dir="${OPEN_LENS_REMOTE_DATA_DIR:-/var/lib/open-lens}"
backup_root="${OPEN_LENS_BACKUP_ROOT:?set OPEN_LENS_BACKUP_ROOT to a NAS directory}"
prepare_command="${OPEN_LENS_PREPARE_COMMAND:-sudo /opt/open-lens/ops/backup/server-prepare.sh}"
ssh_port="${OPEN_LENS_SSH_PORT:-}"
retention="${OPEN_LENS_RETENTION:-30}"
watermark="${OPEN_LENS_DISK_WATERMARK:-80}"

[[ "$retention" =~ ^[0-9]+$ && "$retention" -ge 1 ]] || { echo "ERROR: retention must be >= 1" >&2; exit 2; }
[[ "$watermark" =~ ^[0-9]+$ && "$watermark" -ge 1 && "$watermark" -le 100 ]] \
  || { echo "ERROR: watermark must be 1..100" >&2; exit 2; }
for dependency in ssh rsync sqlite3; do
  command -v "$dependency" >/dev/null || { echo "ERROR: $dependency is required" >&2; exit 1; }
done

ssh_args=()
rsync_rsh="ssh"
if [[ -n "$ssh_port" ]]; then
  ssh_args=(-p "$ssh_port")
  rsync_rsh="ssh -p $ssh_port"
fi

snapshots="${backup_root%/}/snapshots"
timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
partial="${backup_root%/}/.partial-${timestamp}"
final="${snapshots}/${timestamp}"
mkdir -p "$snapshots"
[[ ! -e "$partial" && ! -e "$final" ]] || { echo "ERROR: snapshot path already exists: $timestamp" >&2; exit 1; }
lock_dir="${backup_root%/}/.pull.lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "ERROR: another NAS pull is running (or stale lock exists): $lock_dir" >&2
  exit 1
fi
cleanup() {
  rm -rf "$partial"
  rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
mkdir -p "$partial/data"

# NAS 持有访问服务器的 SSH 私钥；服务器不保存 NAS/OSS 的任何凭据。
ssh "${ssh_args[@]}" "$remote" "$prepare_command"
RSYNC_RSH="$rsync_rsh" rsync -a --delete \
  --exclude '/openlens.db' --exclude '/openlens.db-wal' --exclude '/openlens.db-shm' --exclude '/.cold-export/' \
  "${remote}:${remote_data_dir%/}/" "$partial/data/"
RSYNC_RSH="$rsync_rsh" rsync -a \
  "${remote}:${remote_data_dir%/}/.cold-export/openlens.sql" "$partial/openlens.sql"
RSYNC_RSH="$rsync_rsh" rsync -a \
  "${remote}:${remote_data_dir%/}/.cold-export/manifest.txt" "$partial/manifest.txt"

verification="${partial}/.verification"
"$(dirname "$0")/restore-check.sh" "$partial" "$verification"
rm -rf "$verification"
mv "$partial" "$final"
ln -sfn "snapshots/${timestamp}" "${backup_root%/}/latest"
rmdir "$lock_dir"
trap - EXIT INT TERM

# 仅按明确保留策略删第 31 份及更老的完整快照；磁盘水位告警不会触发额外清理。
snapshot_dirs=("$snapshots"/20??????T??????Z)
if [[ -e "${snapshot_dirs[0]}" && "${#snapshot_dirs[@]}" -gt "$retention" ]]; then
  remove_count=$((${#snapshot_dirs[@]} - retention))
  for ((index = 0; index < remove_count; index++)); do
    rm -rf "${snapshot_dirs[$index]}"
  done
fi

used_percent="$(df -P "$backup_root" | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')"
if [[ "$used_percent" -ge "$watermark" ]]; then
  message="Open-Lens backup disk usage ${used_percent}% >= ${watermark}% at ${backup_root}; no automatic cleanup was performed"
  echo "ALERT: $message" >&2
  if [[ -n "${OPEN_LENS_ALERT_COMMAND:-}" ]]; then
    "$OPEN_LENS_ALERT_COMMAND" "$message"
  fi
fi

echo "BACKUP OK snapshot=$final retained=$(find "$snapshots" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ') disk=${used_percent}%"
