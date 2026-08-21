# Open-Lens Desktop

课堂照片的批量导入、四角复核和全分辨率透视校正工具。Desktop 使用根 lockfile
固定的 `@techstark/opencv-js@4.12.0-release.1` 和仓库内 `app/public/detector-oss.js`；
资产缺失或 hash 不符时会明确退出。

## 快速开始

```bash
npm ci
npm run desktop:ingest -- --data ./desktop/data ~/Pictures/class-a
npm run desktop -- --data ./desktop/data
```

OpenCV npm tarball 由 `package-lock.json` 的 SHA-512 integrity 固定，包许可为 Apache-2.0；
Desktop 启动还会验证 `dist/opencv.js` SHA-256
`bd0c3e6448043de04f6a64a12cb7b759f78c3ab8f7c35c9f2e0f71c88bb17103`。该文件与
本次 #44/#56 真实 Desktop 证据使用的 `app/public/opencv.js` byte-for-byte 相同。因此 clean
checkout 执行根目录 `npm ci` 后即可运行 Desktop/E2E，不依赖被忽略的个人
`app/public/opencv.js`。

打开 <http://127.0.0.1:8791>。`--data` 可指向任意独立批次目录，也可用 `OPEN_LENS_DESKTOP_DATA` 设置；服务端口可用 `--port` 或 `PORT` 设置。未传输入路径时，ingest 会幂等地重新整理数据目录里已有的 `raw/`。

支持递归导入 `.heic`、`.jpg`、`.jpeg`、`.png`。同名同内容会跳过；同名不同内容会停止并报错，不会覆盖。HEIC 原件保留并用显式 `--out` 转为同名 JPEG。标注图长边为 1000 px，原图尺寸与字节数写入 `manifest.json`。

`manifest.json` 同时记录存储像素轴 `w/h`、EXIF `orientation` 和浏览器定向轴
`orientedW/orientedH`。标注、Scan、归档 `quad` 与 `detect_meta.proposal` 都以浏览器定向轴为准：

| EXIF | 显示语义 | 定向轴处理 | 支持状态 |
| --- | --- | --- | --- |
| 1 | 正常 | 保持 `w×h` | 支持；现有 Desktop/backfill 回归 |
| 2 | 水平镜像 | 未应用 | 不支持；缺少实际 metadata + 浏览器双端变换证据，fail-closed |
| 3 | 旋转 180° | 未应用 | 不支持；缺少实际 metadata + 浏览器双端变换证据，fail-closed |
| 4 | 垂直镜像 | 未应用 | 不支持；缺少实际 metadata + 浏览器双端变换证据，fail-closed |
| 5 | 转置 | 未应用 | 不支持；缺少实际 metadata + 浏览器双端变换证据，fail-closed |
| 6 | 顺时针 90° | 交换为 `h×w` | 支持；真实公开 fixture 完整 E2E |
| 7 | 横向转置 | 未应用 | 不支持；缺少实际 metadata + 浏览器双端变换证据，fail-closed |
| 8 | 逆时针 90° | 未应用 | 不支持；缺少实际 metadata + 浏览器双端变换证据，fail-closed |

对已验证的 1/6 不再给点做第二次旋转：浏览器打开 label 和归档 Original 时已经对两者应用
同一 EXIF 变换，backfill 只把定向 label 坐标按定向 Original 宽高归一缩放。JPEG EXIF 与
PNG `eXIf` 均只在各自 APP1/chunk payload 内读取 IFD0 orientation；无 orientation 等价于 1。
2–5、7–8、非法值、损坏 EXIF 或不支持图像格式都会明确失败。HEIC 在进入标注链前已由
ingest 规范化为 JPEG。

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

默认 Desktop gate 先在不含 ignored OpenCV 文件的 clean-checkout 形态验证 pinned npm asset，
再使用临时数据目录和隔离端口真实加载 OpenCV/检测器，验证幂等导入、检测提案、拖角保存、
全分辨率出片、GT/meta 持久化和复审 URL；随后注入 JSON/JPEG 写入失败与第二阶段崩溃。
仅定向复跑保存失败链路可用 `npm run e2e:desktop-save-failures`。

EXIF 定向回归（固定公开 orientation=6 原图及现有 orientation=1 真图，覆盖 ingest →
浏览器拖角/保存/Scan → backfill → SQLite quad/proposal → 归档重切）：

```bash
npm run e2e:exif-oriented-backfill
```

### 已生成 batch/archive 的处理

- 旧 batch 不必重新标注：新 backfill 从 `raw/` Original 读取 EXIF；新 ingest/save 写入的定向字段只作可审计和交叉校验。
- 同一 `--document-id` 只有在 DB 行精确等于旧/新 backfill 产物、且 Original/Scan 字节 hash
  精确等于源 batch 时才继续；旧坐标自动迁移到 `oriented-original-v1`，新结果保持幂等。
- 初始预检后，写连接以 `BEGIN IMMEDIATE` 取得 SQLite 写锁，并在任何 DB mutation 前重验 DB
  与输入/文件条件；Original 的方向与 hash 来自同一 bytes 快照，`batch-meta.json` 及源文件也会
  重验。候选 page id、Original/Scan 相对路径与目标路径必须各自唯一；page id 若属于其他
  document 会在写入前拒绝。合法旧 schema 缺少 `edited`/`detect_meta` 时，只在同一写事务的
  输入、文件和 ownership 门通过后迁移，再按新列复验。
- source/data root 必须是真目录；root 内路径组件不得是 symlink。已有归档目标和 SQLite 必须是
  data root 内的普通文件且只有一个 hard link。缺失文件先写同目录 stage，再以 hard link
  不覆盖安装；link 前、link 后和 stage unlink 前都重验 directory 与 stage 的
  inode/size/link/hash identity，移除 stage 后最终文件回到单链接 ownership 模型。失败清理只
  删除 identity 仍属于本次安装的文件。发现文件、重切、增强、换序或其他漂移时 fail-closed，
  使用新 `--document-id` 或人工对账。
- 文件系统与 SQLite **不宣称跨资源原子提交**。进程在文件安装后、DB commit 前崩溃时，可能
  留下 hash 正确的目标文件；重复运行会重验并完成 DB。普通受控失败会清理本次 stage；进程
  崩溃若只留下隐藏 stage 文件，目标和 DB 不变，可人工清理 stage 后重跑。若清理时 archive
  directory 或 stage 的 inode/link/hash identity 已漂移，则为避免沿替换后的路径删除外部文件，
  同样 fail-closed；失败回滚也不会删除 identity 已漂移目录中的 installed artifact。两种情况均
  需人工对账后清理。
