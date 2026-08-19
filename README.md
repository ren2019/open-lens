# Open-Lens

自托管的文档扫描系统,替代已退役的 Microsoft Lens。手机浏览器(iOS Safari PWA)采集并处理图像,云服务器归档并向 AI agent 开放数据访问。

- Spec:`docs/spec/user-stories.md`(范围已对齐)
- 决策:`docs/adr/0001-0006`
- Spike 结论:`spike/`(检测器移植 + 真机验证)
- 旅程原型:`prototype/journey-prototype.html`(逻辑模块已搬入 `app/src/store.ts`)

## 本地开发

```bash
npm install          # 根: concurrently
npm run dev          # 同时起 app(5173)+ server(8787)
```

- App:http://localhost:5173(token 输入 `dev-token`)
- Server API:http://localhost:8787(`Authorization: Bearer dev-token`)
- 数据落 `.data/`(文件按 `YYYY/MM/` + SQLite `openlens.db`)

真机验收(同网段 iPhone):`http://<mac-ip>:5173`,相机需 HTTPS 或 localhost——真机请走部署链路(Caddy,ADR-004)。桌面 Chrome 可用相册导入走完整链路(无摄像头时)。

## 结构

```
app/     Vue 3 + Vite + TS(不引 UI 库,ADR-006)
  src/detector.ts   检测 seam: cv 就绪→spike 检测器;缺→全图框降级(US-B3)
  src/imaging.ts    透视校正(条带仿射)+ 增强近似 + 长图拼接
  src/store.ts      旅程状态机(旅程结构 = 原型 v2 验证版)+ 上传队列
  public/opencv.js  spike 同款 10MB 全量构建(正式版换裁剪构建)
  public/detector-oss.js  spike DocumentDetector 移植(UMD)
server/  Fastify + better-sqlite3
  归档(Original+Scan+Outfit 落盘,元数据 SQLite)+ 单 token + 裸文件读
app/e2e/smoke.mjs   Playwright 冒烟:导入→裁剪→增强→标签→长图/PDF→归档→服务端可查
```

## 已实现(MVP P0 对应)

采集(A1 高亮降级版/A2 快门/A3 连拍 batch/A4 相册导入)· 检测(B1 裁剪器/B2 透视/B3 降级)·
增强(C1 四档,CSS 近似待 cv)· 组织(D1 页序/D2 改名/D3 标签/D4 历史)· 导出(E1 单图/E2 PDF/E3 长图)·
上传(F1 归档/F2 断网队列)· 服务端(G1-G3)· 部署链路(G4 属运维)· PWA(H1 manifest 最小,H2 缓存待做)·
MCP(I1-I3 待接,server service 层已具备)

> 2026-08-20 spec 修订:Epic J(服务端图像管线)砍掉,MCP 收敛为读+组织;新增 G5 冷备 / H3 能力门(P0)、D8 桌面批量重切(P1);F2 改 OPFS 硬持久;D2 降 P1;A1 标可降级。

OpenCV.js 已随包(10MB),检测可用;`cv 缺失` 场景走全图框 + 手动拉角,产品不阻塞。
