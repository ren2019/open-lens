# Open-Lens

自托管的文档扫描系统，替代已退役的 Microsoft Lens。手机浏览器（iOS Safari PWA）采集并处理图像，云服务器归档并向 AI agent 开放数据访问。

## Language

### 采集与处理

**Scan（扫描件）**:
一次拍照处理流程产出的成品：一张经过透视校正和增强的图像。
_Avoid_: 照片、图片、scan image

**Page（页）**:
Scan 的组成单位。一个文档由一页或多页组成，每页对应一张 Scan。
_Avoid_: 帧、sheet

**Original（原图）**:
相机直出、未经处理的 JPEG。每页同时保留 Original 和 Scan，重处理（Reprocess）的输入。
_Avoid_: 原始照片、raw

**Capture（采集）**:
手机端打开相机到一页成像的动作。只发生在手机端。
_Avoid_: 拍照、拍摄

**Edge Detection（边缘检测）**:
从 Original 中识别文档四角的处理。手机端完成，OpenCV.js。
_Avoid_: 角点检测（角点是检测的结果，不是处理本身）

**Enhancement（增强）**:
对 Scan 施加的清晰化处理：黑白、灰度、对比度强化等。手机端完成。
_Avoid_: 滤镜（指 UI 上的选单，不是处理本身）、清晰化

**Outfit（成品）**:
一页或多页 Scan 组织后的最终交付物：单图、长图或 PDF。
_Avoid_: 导出物、output、export（指动作，不指产物）
