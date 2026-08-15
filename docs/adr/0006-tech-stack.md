# 技术选型：Vue 3 + Vite + TS 前端，Node.js (Fastify) + SQLite 服务端

前端：Vue 3 + Vite + TypeScript，不引入 UI 组件库（控件手写）。UI 面积小，核心复杂度在图像处理不在 UI 状态。OpenCV.js 加载分两步：spike 阶段用 CDN 全量（验证优先），正式版换按需裁剪的 WASM 构建或 service worker 缓存。

服务端：Node.js (Fastify) + SQLite。理由：部署简单、`sharp` 图像处理快、TypeScript 版 MCP SDK 官方维护最好（server 与 MCP server 同栈，类型共享）。考虑过 Python (FastAPI + Pillow)：完全可行，最终按长期维护偏好选 Node。

## Consequences

- reprocess/assemble 的服务端图像处理用 sharp 或 node 原生 OpenCV 绑定，实现时再定，不锁死。
- 取景/角点编辑这类 canvas 重交互用 Vue 模板 + ref 挂 canvas，不引专门的手势库。
