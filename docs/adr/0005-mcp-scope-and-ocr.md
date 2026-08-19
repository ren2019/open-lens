# MCP 提供"读 + 组织"（原"两个触发"已于 2026-08-20 移除，见文末 Amendment）；OCR 不进 MVP，由外部知识管理服务经 MCP 消费

MVP 的 MCP 能力范围：读（列出/检索 Scan、获取 Original/Outfit/OCR 文本）、组织（重命名、打标签、组装页）、触发仅两个——`reprocess`（对某 Original 重跑增强参数）和 `assemble`（把若干页组装成新 Outfit）。OCR 不进 MVP：服务端后续单独跑 PaddleOCR（中文板书识别明显强于 Tesseract），OCR 结果落 SQLite。用户的知识管理类服务（多个）后续作为 MCP 客户端来消费数据，不内建摘要/知识功能。

## Consequences

- reprocess/assemble 是服务端处理：需要服务端也有一份增强参数实现（Python/OpenCV 或 sharp），与手机端 OpenCV.js 参数语义需对齐（同一组预设值在两端渲染一致——允许近似，不要求像素级一致）。
- OCR 字段在 SQLite 里占位（nullable），MCP 读接口对无 OCR 的条目返回空而不是报错。

## Amendment(2026-08-20)

MCP 范围收敛为"读 + 组织"(US-I1/I2/I3):两个触发(I4 reprocess / I5 assemble)随 Epic J 一并砍掉。MCP 输出契约 = Original/Scan 文件 + 元数据,不含 Outfit 组装——agent 需要的 PDF/长图由 agent 客户端自行组装("处理发生在消费者那一端")。原"两端增强参数语义对齐"后果条随 US-C5 一并作废(只剩单端实现,无漂移问题)。
