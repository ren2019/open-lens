# 恢复演练：NAS pull 冷备（2026-08-20）

## 演练范围

用开发机当前 `.data` 作为只读生产数据源，临时目录模拟 NAS snapshot。演练覆盖与正式脚本相同的关键链路：live SQLite 读事务 `.dump` → dump SHA-256 → 排除 `openlens.db/wal/shm` 的文件树 rsync → 新目录恢复 → `PRAGMA quick_check` → 检查 DB 引用的全部 Original、Scan、Outfit。

未连接真实 NAS/SSH；远程 hop、NAS cron 通知和实际磁盘水位需要部署时再做一次现场验收。本次不改 `.data`，所有演练产物位于 `/tmp`。

## 执行结果

```text
PREPARE OK docs=22 pages=22 outfits=28
RESTORE OK quick_check=ok docs=22 pages=22 outfits=28 missing_files=0
```

恢复库可以执行正常查询，源库与恢复库三张核心表计数一致；所有 72 个 DB 文件引用（每页 Original + Scan、Outfit）均可在恢复文件树中找到。

## 结论与约束

- 不直接复制 live `openlens.db*`；文本 dump 必须先在临时 DB 还原并通过 quick_check。
- 快照只有在 dump hash、数据库恢复和引用文件检查全部通过后才从 `.partial-*` 原子发布。
- 保留 30 份是明确的代际策略；80% 水位只告警，不扩大自动删除范围。
- 备份凭据只在 NAS：服务器保存 NAS 公钥，不保存 NAS/OSS 的可用凭据。
- 恢复目标必须是新目录，`restore-check.sh` 拒绝覆盖现有目录。
