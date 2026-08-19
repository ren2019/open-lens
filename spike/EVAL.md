# Detector evaluation GT

`ground-truth.json` 的每条记录只允许三种互斥语义：

- 普通目标：`{ mode, quad }`。检测到 quad 后按 IoU 评分；检测失败显示 `null`，沿用既有基线口径。
- 无目标：`{ mode, noTarget: true }`。画面里不存在目标；检测到任何 quad 都是误检。
- 期望降级：`{ mode, quad, expectFallback: true }`。画面里有目标和人工 GT，但目标被裁过半或边框物理不可见；检测失败是正确行为（产品进入全图框+手动路径），硬检出 quad 是误检。

`noTarget` 与 `expectFallback` 不得同时出现。businesscard 模式目前只有 schema/产品占位，不进入通用模式基线；收集真实名片 GT 后单独建集和基线。

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
