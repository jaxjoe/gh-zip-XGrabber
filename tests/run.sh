#!/usr/bin/env bash
# 纯函数回归测试入口。node 14 不能直接 import .js 当 ESM，先复制成 .mjs。
# 跑法：bash tests/run.sh   （在仓库根目录执行，测试里按相对路径读源文件）
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p tests/.tmp
cp background/lib/naming.js tests/.tmp/naming.mjs
cp background/lib/sources.js tests/.tmp/sources.mjs
cp background/lib/verify.js tests/.tmp/verify.mjs
cp content/scraper.js tests/.tmp/scraper.mjs
node tests/unit.test.mjs
