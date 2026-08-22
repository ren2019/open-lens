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
4. 将刷新前后两行连同 GT 快照一起纳入 #46；若子集非空，两行样本集发生变化，对照时必须保留 `mIoU样本` 和 `expectFallback剔除`，不只报一个 mIoU 数字。若用户明确确认无需指认，则保留完整的相同行并说明这是 GT 未改写的 no-op 对照。

## #46 基线刷新实录（2026-08-22）

### 人工门结论

- 在 detector 提交 `c7f8d1d2e884d86fa493c4310639933a0513c773` 上重新生成 screen 只读候选队列，共 24 张。
- 用户已逐张目视这 24 张候选，并明确确认“切割都 ok”。按本文语义，这是显式“无需指认”，不是从低 IoU、`null` 或文件名推断出的结论。
- 最终 `expectFallback` 子集为空，`0/218`；`noTarget=0/218`。没有虚构其他 ID，也没有运行需要非空 ID 的 `mark-expect-fallback --set/--apply`。
- 候选为：`IMG_4063`、`IMG_4070`、`IMG_4087`、`IMG_4091`、`IMG_4093`、`IMG_4096`、`IMG_4097`、`IMG_4117`、`IMG_4148`、`IMG_4150`、`IMG_4155`、`IMG_4158`、`IMG_4172`、`IMG_4173`、`IMG_4185`、`IMG_4186`、`IMG_4202`、`IMG_4203`、`IMG_4211`、`IMG_4233`、`IMG_4241`、`IMG_4264`、`IMG_4266`、`IMG_4293`。

### GT 审计身份

- 刷新前 GT SHA-256：`bd2a58f622c70b7e6a719cd2e74ed799a94985d5e871d52b184f6cb83980b67e`
- 刷新后 GT SHA-256：`bd2a58f622c70b7e6a719cd2e74ed799a94985d5e871d52b184f6cb83980b67e`
- `ground-truth.json`：218 records，全部为 `screen`，`expectFallback=0`，`noTarget=0`。
- `.gt-snapshots/ground-truth.pre-coordinate-recovery-2026-08-20T00-08-00Z.json` SHA-256：`9fd1b97557e1b2171b9f7c13dd5d5772916d2663caa10da4080d5822cbe1c832`。
- `.gt-snapshots/ground-truth.reviewed-2026-08-22-no-expect-fallback.json` SHA-256：`bd2a58f622c70b7e6a719cd2e74ed799a94985d5e871d52b184f6cb83980b67e`。这是人工门完成时冻结的当前 GT；因子集为空，不用一次虚假的 `--apply` 制造写入。

### 218 张全模式对照

刷新前（未改 GT，detector `c7f8d1d2e884d86fa493c4310639933a0513c773`）：

```text
auto       总样本=218 mIoU=0.906 mIoU样本=218 expectFallback剔除=0 IoU≥0.7: 191/218 expectFallback=0/0 误检=-
screen     总样本=218 mIoU=0.960 mIoU样本=207 expectFallback剔除=0 IoU≥0.7: 194/207 expectFallback=0/0 误检=-
document   总样本=218 mIoU=0.956 mIoU样本=208 expectFallback剔除=0 IoU≥0.7: 194/208 expectFallback=0/0 误检=-
whiteboard 总样本=218 mIoU=0.943 mIoU样本=212 expectFallback剔除=0 IoU≥0.7: 194/212 expectFallback=0/0 误检=-
```

刷新后（明确无需指认，detector 与 GT 均不变）：

```text
auto       总样本=218 mIoU=0.906 mIoU样本=218 expectFallback剔除=0 IoU≥0.7: 191/218 expectFallback=0/0 误检=-
screen     总样本=218 mIoU=0.960 mIoU样本=207 expectFallback剔除=0 IoU≥0.7: 194/207 expectFallback=0/0 误检=-
document   总样本=218 mIoU=0.956 mIoU样本=208 expectFallback剔除=0 IoU≥0.7: 194/208 expectFallback=0/0 误检=-
whiteboard 总样本=218 mIoU=0.943 mIoU样本=212 expectFallback剔除=0 IoU≥0.7: 194/212 expectFallback=0/0 误检=-
```

前后样本集与哈希相同，所以四行一致是本次人工结论的预期结果，不是漏跑或用其他 ID 替代空子集。

### #10 可审计补记文本

以下文本供维护者补记到已关闭的 #10；本次实现不代为发布：

```text
2026-08-22 由 #46 完成 git 审计补记：用户已逐张目视 screen 模式 24 个只读候选并确认“切割都 ok”。按 EVAL.md 语义显式记录为“无需指认”，expectFallback 子集保持为空（0/218），noTarget=0/218；没有从 null、低 IoU 或文件名自动推断任何 ID。坐标换算 bug 修复并恢复 GT 后，当前 ground-truth.json SHA-256 为 bd2a58f622c70b7e6a719cd2e74ed799a94985d5e871d52b184f6cb83980b67e。保持 detector c7f8d1d2e884d86fa493c4310639933a0513c773 不变，在 #41 新聚合语义下重跑 218 张全模式：auto 0.906（mIoU样本 218）、screen 0.960（207，IoU≥0.7 194/207）、document 0.956（208）、whiteboard 0.943（212）；各模式 expectFallback剔除=0、expectFallback=0/0、误检=-。刷新前后 GT 哈希与完整汇总行一致，因为人工结论是 no-op。当前 GT、coordinate-recovery 快照和 2026-08-22 reviewed/no-expectFallback 快照已由 #46 纳入 git，照片仍保持忽略。
```
