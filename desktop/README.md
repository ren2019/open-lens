# Open-Lens Desktop

课堂照片的批量导入、四角复核和全分辨率透视校正工具。它复用移动端 `app/public/` 中的 OpenCV 与检测器资产；资产缺失时会明确退出，避免桌面端静默使用另一套实现。

## 快速开始

```bash
npm run desktop:ingest -- --data ./desktop/data ~/Pictures/class-a
npm run desktop -- --data ./desktop/data
```

打开 <http://127.0.0.1:8791>。`--data` 可指向任意独立批次目录，也可用 `OPEN_LENS_DESKTOP_DATA` 设置；服务端口可用 `--port` 或 `PORT` 设置。未传输入路径时，ingest 会幂等地重新整理数据目录里已有的 `raw/`。

支持递归导入 `.heic`、`.jpg`、`.jpeg`、`.png`。同名同内容会跳过；同名不同内容会停止并报错，不会覆盖。HEIC 原件保留并用显式 `--out` 转为同名 JPEG。标注图长边为 1000 px，原图尺寸与字节数写入 `manifest.json`。

```text
data/
├── raw/                 原始输入和 HEIC 转出的 JPEG
├── label/               1000 px PNG 与 ground-truth.json
├── outputs/             全分辨率校正 JPEG（质量 0.92）
├── manifest.json
└── batch-meta.json
```

## 复核工作流

- 蓝色虚线是检测提案，绿色框和把手是最终四角。
- 拖动绿色角点后可撤销/重做（`⌘/Ctrl+Z`、`⌘/Ctrl+Shift+Z`），选择模式后保存；保存会持久化 GT/meta，并自动按原图分辨率覆盖渲染成品。
- 点“成品墙”浏览整个批次；缩略图会区分已渲染、未渲染、无目标和黄色比例告警。点任意卡片进入重标，保存并覆盖出片后会自动回到墙上刷新该卡片。
- “无有效目标”只用于画面里没有目标；“期望降级”用于有目标和 GT、但被裁过半或边框物理不可见的图片。后者以紫色进度点标识，并进入 detector eval 的正确失败语义；每次改变该状态前会自动把整份 GT 存入 `label/.gt-snapshots/`。
- 底部灰/绿/橙/红/黄点分别表示未标、已标、人工修正、无目标、比例待复核。
- `/#pos=12` 跳到第 12 张；`/#review=IMG_4083,IMG_4087` 只复审指定图片。
- 比例告警是课堂投影经验阈值，只提示复核，不阻止保存。

`desktop/data/` 默认被 Git 忽略。不要提交课堂原图、GT 或输出。现有 `spike/photos-batch/` 私有数据不会被工具自动迁移或改写；需要使用时请显式传 `--data spike/photos-batch`。

## 验证

```bash
npm run e2e:desktop
```

冒烟测试使用临时数据目录和隔离端口，真实加载产品 OpenCV/检测器，验证幂等导入、检测提案、拖角保存、全分辨率出片、GT/meta 持久化和复审 URL。
