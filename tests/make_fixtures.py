# -*- coding: utf-8 -*-
"""
从真实 GitHub 搜索页快照生成结构漂移夹具。

为什么需要：2026-10-10 当天 GitHub 把搜索卡片的 CSS module 前缀从 `Result-module__Result__xxx`
改成了 `Result__xxx`，依赖类名的抓取实现当场从「抓到 10 个」退化成「抓到 1 个」。
所以夹具要主动模拟这种漂移：

  search-p2.html            真实快照（curl 下来的原样）
  search-p2-renamed.html    所有 class 值换成无意义 token，data-testid 保留
  search-p2-hostile.html    class 全换 + 连 results-list 这个 testid 也抹掉
                            （逼 findListRoot 走「按 /stargazers 聚类」的兜底路径）

用法：python tests/make_fixtures.py
"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
SRC = os.path.join(FIX, "search-p2.html")

CLS = re.compile(r'class="[^"]*"')
SCRIPT = re.compile(r"<script\b.*?</script>", re.S | re.I)


def renamed(html):
    n = [0]

    def sub(_m):
        n[0] += 1
        return 'class="q7z{:05d}"'.format(n[0])

    return CLS.sub(sub, html)


def hostile(html):
    out = renamed(html)
    out = out.replace('data-testid="results-list"', 'data-q7z="gone"')
    out = out.replace('data-testid="resolved-count-label"', 'data-q7z="gone"')
    return out


def main():
    if not os.path.exists(SRC):
        print("缺少真实快照 search-p2.html，请先执行：")
        print('  curl -A "Mozilla/5.0" -o tests/fixtures/search-p2.html \\')
        print('    "https://github.com/search?q=animation&type=repositories&p=2"')
        return 1
    html = io.open(SRC, encoding="utf-8", errors="replace").read()
    html = SCRIPT.sub("", html)  # 快照里的脚本在 file:// 下没意义，剥掉避免执行
    io.open(SRC, "w", encoding="utf-8", newline="\n").write(html)

    io.open(os.path.join(FIX, "search-p2-renamed.html"), "w", encoding="utf-8", newline="\n").write(renamed(html))
    io.open(os.path.join(FIX, "search-p2-hostile.html"), "w", encoding="utf-8", newline="\n").write(hostile(html))

    for name in ("search-p2.html", "search-p2-renamed.html", "search-p2-hostile.html"):
        p = os.path.join(FIX, name)
        body = io.open(p, encoding="utf-8").read()
        print("{:28s} {:>7d} B | stargazers {} | Result-module {} | results-list {}".format(
            name, os.path.getsize(p), body.count("/stargazers"),
            body.count("Result-module"), body.count('data-testid="results-list"')))
    return 0


if __name__ == "__main__":
    sys.exit(main())
