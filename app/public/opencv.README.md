opencv.js(10MB,WASM 内联全量构建)按仓库的大运行资产约定不入库。
获取:从 spike/ 拷贝 —— `cp ../spike/opencv.js app/public/opencv.js`(spike 提交里有同款文件的获取说明),
或从 https://docs.opencv.org/4.x/opencv.js 下载。缺此文件时 app 走"检测降级"(全图框+手动拉角),功能不阻塞。
生产构建会由 service worker 缓存应用壳,OpenCV 加载器按 `open-lens-opencv-0.1.0` 版本缓存本文件;升级资产时必须同步提升缓存版本。
