# 先跑 spike 验证 iOS Safari + OpenCV.js 可行性，再进入正式实现

两个核心不确定性——实时取景检测帧率、边缘检测对真实板书照片的质量——对话中无法 settle，必须跑代码。决定：正式实现前先做最小 spike，验收标准硬编码为三条：

1. iOS Safari（PWA standalone 模式）相机可用：`getUserMedia` + `facingMode: 'environment'` 稳定出流。hard fail = 相机打不开 → 架构级 blocker，回到架构层重议。
2. 边缘检测质量：拿真实场景照片（文件、投屏、白板板书各若干）测自动检测，一次选中或微调即可用的比例 ≥ 70% pass；< 70% 考虑服务端重处理路由。
3. 实时取景高亮 ≥ 5fps 可接受；< 5fps 走已批准的降级路径（拍后检测 + 手动调角点）。

Spike 范围排除：鉴权、上传、归档、MCP、PDF/长图导出、增强滤镜、标签、OPFS 队列。spike 只回答"iOS Safari + OpenCV.js 的效果与帧率够不够"。
