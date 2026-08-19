# Open-Lens 冷备 runbook

目标是 **NAS pull**：SSH 私钥、NAS 路径和可选 OSS 凭据只在 NAS；Open-Lens 服务器只保存 NAS 公钥，无法反向访问备份。

## 1. 服务器准备

安装 `sqlite3`、`rsync`，将本目录部署到 `/opt/open-lens/ops/backup/`。创建专用 `openlens-backup` 用户，只授予数据目录读取权和 `.cold-export` 写入权；在其 `authorized_keys` 放 NAS 公钥。若数据目录不是 `/var/lib/open-lens`，用服务器本地 wrapper 设置 `OPEN_LENS_DATA_DIR` 后调用 `server-prepare.sh`，不要把真实主机、路径或密钥提交到仓库。

`server-prepare.sh` 会：

1. 对 live SQLite 执行 `.dump`，不复制 `openlens.db*`；
2. 在临时 DB 中恢复 dump 并要求 `PRAGMA quick_check = ok`；
3. 原子替换 `.cold-export/openlens.sql` 与清单。

## 2. NAS cron

在 NAS 的私有环境文件中配置：

```sh
export OPEN_LENS_REMOTE='openlens-backup@your-server'
export OPEN_LENS_REMOTE_DATA_DIR='/var/lib/open-lens'
export OPEN_LENS_BACKUP_ROOT='/volume1/cold-backup/open-lens'
# 可选：OPEN_LENS_SSH_PORT、OPEN_LENS_PREPARE_COMMAND、OPEN_LENS_ALERT_COMMAND
```

先手工执行一次 `ops/backup/nas-pull.sh`，确认 `latest` 指向新快照；再把同一命令放到 NAS 每日 cron。脚本只有在远程 dump、rsync、dump SHA-256、临时恢复、quick_check 和引用文件检查全部通过后才原子发布快照；本地锁阻止重叠 pull。保留最新 30 份；第 31 份及更老快照按明确策略删除。

磁盘使用率达到 80% 时脚本写 stderr，并可调用 `OPEN_LENS_ALERT_COMMAND MESSAGE`；**不会因水位自动删除额外快照**。cron 必须把 stderr 投递到邮件或 NAS 通知中心。

## 3. 恢复

目标目录必须不存在，脚本拒绝覆盖：

```sh
ops/backup/restore-check.sh /volume1/cold-backup/open-lens/snapshots/20260820T030000Z /tmp/open-lens-restored
sqlite3 /tmp/open-lens-restored/openlens.db 'SELECT id,name FROM docs ORDER BY created_at DESC LIMIT 5;'
```

恢复成功需要 `quick_check=ok`，并且 DB 引用的全部 Original、Scan、Outfit 都存在。

## 4. 无 NAS 时的 OSS 备选

在独立管理机或 NAS 上用 `rclone`/云厂商 CLI 把**已验证的本地 snapshots 目录**同步到启用版本控制/生命周期策略的 OSS bucket；不要从生产服务器直接上传，也不要把 OSS 凭据放到服务器。示例（实际 remote/bucket 只写在 NAS 私有配置）：

```sh
rclone sync /volume1/cold-backup/open-lens/snapshots private-oss:your-private-bucket/open-lens
```

OSS 是 NAS 缺失时的替代介质，不改变“先 dump、再恢复校验、最后发布”的流程。
