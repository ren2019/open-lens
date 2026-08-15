#!/bin/bash
# A/B 对照: JS 移植 (detector.js) vs C++ 参考实现 (ref-detector, OSS 上游逐行移植)
# 用法: ./ab-test.sh photos/xxx.jpg   (需要 png 版本,会自动转)
cd "$(dirname "$0")"
src="$1"
png="${src%.jpg}.png"
[ -f "$png" ] || sips -s format png "$src" --out "$png" >/dev/null 2>&1
echo "== JS port (OpenCV.js, 浏览器同款) =="
node bench-real.js "$png" 2>/dev/null | grep -E "^(detect|quad)"
echo "== C++ reference (上游算法原生复刻) =="
/tmp/oss/ref-detector "$src"
