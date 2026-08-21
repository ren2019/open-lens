# Detector evaluation GT

`ground-truth.json` 的每条记录只允许三种互斥语义：

- 普通目标：`{ mode, quad }`。检测到 quad 后按 IoU 评分；检测失败显示 `null`，沿用既有基线口径。
- 无目标：`{ mode, noTarget: true }`。画面里不存在目标；检测到任何 quad 都是误检。
- 期望降级：`{ mode, quad, expectFallback: true }`。画面里有目标和人工 GT，但目标被裁过半或边框物理不可见；检测失败是正确行为（产品进入全图框+手动路径），硬检出 quad 是误检。

`noTarget` 与 `expectFallback` 不得同时出现。businesscard 模式目前只有 schema/产品占位，不进入通用模式基线；收集真实名片 GT 后单独建集和基线。

## mIoU 聚合口径

对每个 detector 模式，mIoU 样本集 `M` 只包含「普通目标且实际检出 quad」的记录：

```text
M = {row | !noTarget && !expectFallback && detectedQuad}
mIoU = sum(IoU(row.quad, detectedQuad) for row in M) / |M|
```

- 普通目标的检出继续产生真实 IoU；普通目标漏检仍显示 `null` 且不进入聚合，保持冻结基线的既有口径。
- `noTarget` 没有可用的 IoU GT，不进入聚合。
- `expectFallback` 无论正确降级还是硬检出，都不产生 IoU 样本；不使用 `1.0` 或 `0` 冒充 IoU。正确降级只计入 `expectFallback=ok/total`，硬检出另列为误检。
- `|M| = 0` 时输出 `mIoU=n/a`，不把「无聚合样本」显示成零分或满分。

汇总行同时输出：`总样本`（数据集中存在对应文件并完成评测的记录数）、`mIoU样本=|M|`、`expectFallback剔除`、fallback 成功率与误检文件名。

由用户确认子集后先 dry-run，再显式应用：

```bash
node spike/mark-expect-fallback.js photos-batch/label --set IMG_4096,IMG_4148
node spike/mark-expect-fallback.js photos-batch/label --set IMG_4096,IMG_4148 --apply
node spike/eval-run.js photos-batch/label
```

只看汇总可在评测命令末尾加 `--summary`。

先生成需要人工看的 screen 漏检/低分队列（不会改 GT），再把输出的 `reviewUrl` 放进已启动的 desktop 工具：

```bash
node spike/eval-run.js photos-batch/label --mode screen --review-candidates
```

候选条件只是 `null` 或 IoU < 0.70，用来把 218 张缩成小队列；它不是 `expectFallback` 结论，仍需逐张目视确认。

`--apply` 会在数据集的 `.gt-snapshots/` 留下写前快照。不要从低 IoU、`null` 或文件名自动推断子集；物理不可检是人工语义判断。

## #46 后续基线刷新

本计分口径落地时不修改 GT；当前 218 张 GT 的 `expectFallback=0`，所以 screen mIoU 冻结值仍为 `0.960`。#46 必须在用户完成低分候选目视确认后单独刷新：

1. 先用本口径在未改 GT 上跑 `node spike/eval-run.js photos-batch/label --mode screen --summary`，记录 GT 哈希、detector 提交、总样本、mIoU 样本数、剔除数与 mIoU。
2. 由用户确认精确子集（或明确确认无需指认），再通过 dry-run + `--apply` 写入；agent 不代为目视判断。
3. 保持 detector 提交不变，在新 GT 上重跑同一命令；记录新 GT 哈希、上述全部计数、fallback 成功率/误检与新 mIoU。
4. 将刷新前后两行连同 GT 快照一起纳入 #46；两行样本集发生了变化，对照时必须保留 `mIoU样本` 和 `expectFallback剔除`，不只报一个 mIoU 数字。
