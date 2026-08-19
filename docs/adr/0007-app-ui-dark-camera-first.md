# App UI:暗场相机优先(原型变体 A)

2026-08-19 用 `prototype/app-ui-prototype.html` 做了 3 个结构迥异的变体(A 暗场相机优先 / B 亮色文档中心 / C 奶油步骤向导)× 6 个主要页面,用户选定 **A**。

核心理由:使用场景是课堂拍投影,相机是绝对主场——A 让取景即首页,资料库/详情都是相机上的叠层;B 把相机降级为 FAB 模态,多一次跳转;C 的逐屏向导对高频连拍是负担。

iOS Safari PWA 可行性已逐条论证:相机 standalone 可用性有 US-H1 spike 实证;拖角 pointer events 已在产线(Crop.vue);`backdrop-filter` 毛玻璃限用于小控件(模式 pill、图标钮),大面积面板用近不透明色,避免全屏视频上的合成器开销;safe-area / `viewport-fit=cover` / `black-translucent` 已在 `index.html` 就位。

## Consequences

- app 视觉令牌:深色底 `#0b0b0d`、强调黄 `#ffd60a`、近不透明 sheet `#141416`;新页面/组件以此为准(CLAUDE.md 有指针,原型文件存 main 作活参考,含败选的 B/C)。
- 相机是首页;资料库/详情以叠层呈现,不做底 tab 主导航。
- 赢家已折入 `app/src`(commit f5756fe,e2e 15/15 未破);败选变体不进产线代码。
