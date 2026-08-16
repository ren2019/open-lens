opencv.js(10MB,WASM 内联全量构建)体积超 git 限额不入库。
获取:从 spike/ 拷贝 —— `cp ../spike/opencv.js app/public/opencv.js`(spike 提交里有同款文件的获取说明),
或从 https://docs.opencv.org/4.x/opencv.js 下载。缺此文件时 app 走"检测降级"(全图框+手动拉角),功能不阻塞。
