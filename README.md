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
- 冷备运维:`ops/backup/README.md`(NAS pull、30 份、80% 告警、恢复演练)

真机验收(同网段 iPhone):`http://<mac-ip>:5173`,相机需 HTTPS 或 localhost——真机请走部署链路(Caddy,ADR-004)。桌面 Chrome 可用相册导入走完整链路(无摄像头时)。

## 结构

```
app/     Vue 3 + Vite + TS(不引 UI 库,ADR-006)
  src/detector.ts   检测 seam: cv 就绪→spike 检测器;缺→全图框降级(US-B3)
  src/imaging.ts    sRGB 透视校正(条带仿射)+ 像素增强 + 长图拼接
  src/store.ts      旅程状态机(旅程结构 = 原型 v2 验证版)+ 上传队列
  public/opencv.js  spike 同款 10MB 全量构建(正式版换裁剪构建)
  public/detector-oss.js  spike DocumentDetector 移植(UMD)
server/  Fastify + better-sqlite3
  归档(Original+Scan+Outfit 落盘,元数据 SQLite)+ 单 token + 裸文件读
app/e2e/run.mjs     US 级 Playwright runner:全组 `npm run e2e:smoke`;单组 `npm run e2e:us -- US-B1`
app/e2e/us/         按 US 分文件的真实断言(多选/拖角/增强/Outfit/归档/历史等)
```

## 已实现(MVP P0 对应)

采集(A1 实时 quad 高亮/静态降级/A2 快门/A3 连拍 batch/A4 相册导入)· 检测(B1 裁剪器/B2 透视/B3 降级)·
增强(C1 四档真实像素处理)· 组织(D1 页序/D2 改名/D3 标签/D4 历史/D7 远程详情与再导出)· 导出(E1 单图/E2 PDF/E3 长图)·
上传(F1 归档/F2 OPFS 断网队列)· 服务端(G1-G3)· 部署链路(G4 属运维)· PWA(H1 安装壳/H2 离线缓存/H3 能力门)·
MCP(I1-I3 已接):`POST /mcp`,与 REST 共用 `OL_TOKEN` Bearer 鉴权及 server service 层。工具为
`list_documents`、`get_document`、`get_file`、`rename_document`、`set_tags`、
`reorder_pages`、`list_tags`;运行 `npm run e2e:mcp` 做协议级契约验收。

> 2026-08-20 spec 修订:Epic J(服务端图像管线)砍掉,MCP 收敛为读+组织;新增 G5 冷备 / H3 能力门(P0)、D8 桌面批量重切(P1);F2 改 OPFS 硬持久;D2 降 P1;A1 标可降级。

OpenCV.js 已随包(10MB),检测可用;`cv 缺失` 场景走全图框 + 手动拉角,产品不阻塞。
