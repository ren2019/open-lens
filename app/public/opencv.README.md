opencv.js(约 10MB,WASM 内联全量构建)按仓库的大运行资产约定不入库。移动 app 若需要真实
OpenCV，可从根 lockfile 固定的 `@techstark/opencv-js@4.12.0-release.1/dist/opencv.js` 复制；
包许可为 Apache-2.0，文件 SHA-256 为
`bd0c3e6448043de04f6a64a12cb7b759f78c3ab8f7c35c9f2e0f71c88bb17103`。缺此文件时 app 走
"检测降级"(全图框+手动拉角),功能不阻塞；Desktop 直接读取并验证 npm 包，不需要复制。
生产构建会由 service worker 缓存应用壳,OpenCV 加载器按 `open-lens-opencv-0.1.0` 版本缓存本文件;升级资产时必须同步提升缓存版本。
