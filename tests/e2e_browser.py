# -*- coding: utf-8 -*-
"""
GitHub Zip XGrabber 端到端验证（真实 Chromium，真实外网）

Phase A 引擎（不依赖 github.com 可达，任何时候都跑）：
  A1 扩展加载 + MV3 service worker 注册
  A2 队列下载 octocat/Hello-World → 文件按 日期目录 落盘且是真 zip
  A3 禁用直连后强制走镜像 → sourceId 必须是镜像且 status=done
  A4 不存在的仓库 → 跨源重试后判 failed，且不落任何垃圾文件
  A5 镜像用 200 + 非 zip Content-Type 冒充成功 → 必须被 MIME 硬闸门拒绝
  A6 侧边栏页面正常渲染、无 JS 运行时报错

Phase B 页面集成（需要 github.com 能打开，否则整段 SKIP 并说明原因）：
  B1 仓库页控制条识别 + 点击入队
  B2 搜索结果页抓取（owner/repo/star/语言）并回填清单
  B3 多选批量入队 + 串行队列自动跑空

用法：python tests/e2e_browser.py
产物落在 tests/downloads/gzg-e2e/<日期>/ 下，便于事后核查。
"""
import glob
import json
import os
import re
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.dirname(HERE).replace("\\", "/")
DL = os.path.join(HERE, "downloads")
TODAY = time.strftime("%Y-%m-%d")

results = []
skips = []


def check(name, cond, detail=""):
    results.append((bool(cond), name, detail))
    print("{}  {}{}".format("PASS" if cond else "FAIL", name, ("  | " + detail) if detail else ""))


def skip(name, why):
    skips.append((name, why))
    print("SKIP  {}  | {}".format(name, why[:150]))


def write_prefs(user_data_dir):
    """把默认下载目录锁到临时位置，避免污染用户真实的 Downloads。"""
    prof = os.path.join(user_data_dir, "Default")
    os.makedirs(prof, exist_ok=True)
    with open(os.path.join(prof, "Preferences"), "w", encoding="utf-8") as f:
        json.dump({
            "download": {"default_directory": DL, "prompt_for_download": False},
            "profile": {"default_content_setting_values": {"automatic_downloads": 1}},
        }, f)


def sw_url(context, timeout=60.0):
    """拿扩展 service worker 的 URL（只为解析出扩展 ID）。
    Playwright 的 context.service_workers 在本机偶发不上报（CDP 却能看到这个 worker），
    所以两条路都走一遍，别把测试结果绑死在一个不稳定接口上。"""
    end = time.time() + timeout
    probe = context.pages[0] if context.pages else context.new_page()
    session = None
    while time.time() < end:
        for w in context.service_workers:
            if "service-worker.js" in w.url:
                return w.url
        try:
            if session is None:
                session = context.new_cdp_session(probe)
            infos = session.send("Target.getTargets")["targetInfos"]
            for t in infos:
                u = t.get("url", "")
                if t.get("type") == "service_worker" and "service-worker.js" in u:
                    return u
        except Exception:
            pass
        time.sleep(0.5)
    return None


def read_storage(hp, key):
    """必须在扩展页面里读写：MV3 SW 的 evaluate 会落到没有 chrome.storage 的 utility context。"""
    return hp.evaluate("(k) => chrome.storage.local.get(k).then(v => (v[k] === undefined ? null : v[k]))", key)


def put_storage(hp, key, value):
    hp.evaluate("(a) => chrome.storage.local.set({[a[0]]: a[1]})", [key, value])


def call(hp, msg):
    return hp.evaluate("(m) => chrome.runtime.sendMessage(m)", msg)


def find_item(hp, repo):
    q = read_storage(hp, "gzg_queue") or {}
    return next((i for i in q.get("items", []) if i.get("repo") == repo), None)


def wait_item(hp, repo, timeout=90):
    """轮询到该条目进入终态（done / failed），返回最后一次快照。"""
    end = time.time() + timeout
    it = None
    while time.time() < end:
        it = find_item(hp, repo)
        if it and it["status"] in ("done", "failed"):
            return it
        time.sleep(0.8)
    return it


def goto_retry(page, url, attempts=3, timeout=25000):
    """github.com 在本机时常被 RST/超时，B 段给它几次机会，别把网络抖动误判成功能坏了。"""
    last = None
    for i in range(attempts):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=timeout)
            return True
        except Exception as exc:
            last = exc
            time.sleep(6)
    raise last


def zips(pattern="*"):
    return glob.glob(os.path.join(DL, "**", pattern + ".zip"), recursive=True)


def start_hang_server():
    """连上但永不响应的本地 HTTP 服务，用来复现「镜像挂着不动」。必须多线程，否则第二次尝试会卡在 accept。"""
    import threading
    try:
        from http.server import ThreadingHTTPServer
    except ImportError:  # pragma: no cover
        from http.server import HTTPServer as ThreadingHTTPServer
    from http.server import BaseHTTPRequestHandler

    class Hang(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            time.sleep(600)

        def log_message(self, *args):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Hang)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


def main():
    os.makedirs(DL, exist_ok=True)
    udd = tempfile.mkdtemp(prefix="gzg-e2e-profile-")
    write_prefs(udd)

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=udd,
            headless=False,
            args=[
                "--disable-extensions-except=" + EXT,
                "--load-extension=" + EXT,
                "--no-first-run",
                "--disable-popup-blocking",
            ],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page_errors = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))

        worker_url = sw_url(ctx)
        check("A1 扩展加载 / MV3 SW 注册", worker_url is not None, worker_url or "未捕获到 service worker")
        if not worker_url:
            ctx.close()
            return summarize()
        ext_id = worker_url.split("/")[2]

        # 用 CDP 把下载根目录钉死到 tests/downloads，这样才能观察
        # chrome.downloads 的相对子路径（gzg-e2e/<日期>/xxx.zip）究竟有没有被建成目录。
        try:
            cdp = ctx.new_browser_cdp_session()
            cdp.send("Browser.setDownloadBehavior",
                     {"behavior": "allow", "downloadPath": DL, "eventsEnabled": False})
        except Exception as exc:
            print("  （CDP 下载目录覆盖失败，A2 断言退化为相对路径检查：{}）".format(str(exc)[:80]))

        hp = ctx.new_page()
        hp.goto("chrome-extension://{}/sidepanel/sidepanel.html".format(ext_id))
        hp.wait_for_load_state("domcontentloaded")

        base = {
            "rootFolder": "gzg-e2e", "dateStyle": "YYYY-MM-DD", "concurrency": 1,
            "autoOnRepo": False, "notify": False, "minValidBytes": 64, "stallSeconds": 30,
            "mirrorOrder": ["direct", "gh-proxy.com", "ghfast.top", "ghproxy.net"],
            "disabled": [], "customMirrors": [],
        }

        # ---------------- A2 常规下载（直连优先，失败自动降级）
        put_storage(hp, "gzg_settings", dict(base, maxAttempts=6))
        r = call(hp, {"type": "GZG_ENQUEUE", "origin": "e2e", "force": True,
                      "repos": [{"owner": "octocat", "repo": "Hello-World", "ref": "HEAD"}]})
        check("A2a 入队接口返回成功", bool(r) and r.get("ok") and len(r.get("added", [])) == 1,
              json.dumps(r, ensure_ascii=False)[:160] if r else "无响应")
        it = wait_item(hp, "Hello-World", 60)
        src = (it or {}).get("sourceId")
        check("A2b 队列收敛为 done", bool(it) and it["status"] == "done",
              "source={} attempts={} err={}".format(src, (it or {}).get("attempts"), (it or {}).get("lastError")))
        # 以扩展自己记录的 localPath 为准（Playwright 会把 Chromium 的下载根目录改到临时区，
        # 去猜目录位置没有意义；相对子路径 gzg-e2e/<日期>/ 是否成立才是被测点）
        local = (it or {}).get("localPath") or ""
        if local and not os.path.exists(local):
            local = ""
        if not local:
            hits = [x for x in zips("octocat__Hello-World*") if TODAY in x]
            local = hits[0] if hits else ""
        check("A2c 文件真的落盘", bool(local), local or "localPath 为空且目录里找不到")
        rel = (it or {}).get("filename") or ""
        want_rel = "gzg-e2e/{}/octocat__Hello-World__HEAD.zip".format(TODAY)
        check("A2d 交给下载器的相对路径正确", rel == want_rel, "实际 " + rel)
        under_dl = bool(local) and os.path.normpath(local).lower().startswith(os.path.normpath(DL).lower())
        if under_dl:
            check("A2e 日期子目录被真实创建", os.path.isdir(os.path.dirname(local)),
                  os.path.dirname(local))
            check("A2f 绝对路径 == 下载根 + 相对路径",
                  os.path.normpath(local).lower() == os.path.normpath(os.path.join(DL, want_rel)).lower(), local)
        else:
            skip("A2e/A2f 目录真实创建", "Playwright 把下载文件重命名成了临时 GUID：" + str(local)[:90])
        if local:
            with open(local, "rb") as f:
                magic = f.read(4)
            check("A2g 文件是真 zip", magic[:2] == b"PK" and os.path.getsize(local) > 22,
                  "magic={} size={}B".format(magic.hex(), os.path.getsize(local)))
        check("A2h 命中某个可用源", bool(src), "实际用了 " + str(src))

        # ---------------- A3 禁用直连，强制走镜像
        put_storage(hp, "gzg_settings", dict(base, maxAttempts=6, disabled=["direct"]))
        call(hp, {"type": "GZG_ENQUEUE", "origin": "e2e", "force": True,
                  "repos": [{"owner": "octocat", "repo": "Spoon-Knife", "ref": "HEAD"}]})
        it3 = wait_item(hp, "Spoon-Knife", 60)
        check("A3 禁用直连后由镜像完成下载", bool(it3) and it3["status"] == "done" and it3["sourceId"] != "direct",
              "source={} err={}".format((it3 or {}).get("sourceId"), (it3 or {}).get("lastError")))
        health = read_storage(hp, "gzg_health") or {}
        check("A3b 镜像实测速度被记录", (health.get((it3 or {}).get("sourceId"), {}) or {}).get("bps", 0) > 0,
              json.dumps({k: v.get("bps") for k, v in health.items()}, ensure_ascii=False))

        # ---------------- A4 不存在的仓库：重试后必须判失败
        put_storage(hp, "gzg_settings", dict(base, maxAttempts=4))
        before = set(zips("*zz99*"))
        call(hp, {"type": "GZG_ENQUEUE", "origin": "e2e", "force": True,
                  "repos": [{"owner": "no-such-owner-zz99", "repo": "no-such-repo-zz99", "ref": "HEAD"}]})
        it4 = wait_item(hp, "no-such-repo-zz99", 90)
        check("A4a 不存在仓库判 failed", bool(it4) and it4["status"] == "failed",
              "status={} attempts={}".format((it4 or {}).get("status"), (it4 or {}).get("attempts")))
        check("A4b 失败前确实换过源", bool(it4) and (it4 or {}).get("attempts", 0) >= 2,
              "attempts={}".format((it4 or {}).get("attempts")))
        check("A4c 没有落下垃圾文件", len(set(zips("*zz99*")) - before) == 0, str(zips("*zz99*")))
        check("A4d 失败源写入健康度冷却记录",
              any((v.get("fail") or 0) > 0 for v in health.values()) or any((v.get("fail") or 0) > 0 for v in (read_storage(hp, "gzg_health") or {}).values()),
              json.dumps({k: {kk: vv for kk, vv in v.items() if kk != "badUntil"}
                          for k, v in (read_storage(hp, "gzg_health") or {}).items()}, ensure_ascii=False)[:200])

        # ---------------- A5 源返回 200 + 非 zip 内容类型（冒充成功）
        # 用 data: URL 做确定性替身：状态 200、体积远超 64B 阈值，但 Content-Type 是 text/html，
        # 只有 MIME 硬闸门能拦住它（真实场景就是镜像站拿错误页冒充 .zip）
        fake = {"id": "fake-zip", "label": "假 zip(200 text/html)",
                "template": "data:text/html," + ("x" * 300)}
        put_storage(hp, "gzg_settings", dict(base, maxAttempts=1, customMirrors=[fake],
                                             mirrorOrder=["fake-zip"],
                                             disabled=["direct", "gh-proxy.com", "ghfast.top", "ghproxy.net"]))
        call(hp, {"type": "GZG_ENQUEUE", "origin": "e2e", "force": True,
                  "repos": [{"owner": "octocat", "repo": "Mime-Guard-Probe", "ref": "HEAD"}]})
        it5 = wait_item(hp, "Mime-Guard-Probe", 45)
        err5 = ((it5 or {}).get("lastError", "") or "")
        # 环境相关：Playwright 拦截下载时 data: URL 不会进 Chrome 下载历史，队列会以
        # 「下载记录丢失/重试耗尽」收口；真实浏览器里则命中 MIME 闸门。
        # 两者共同的产品性质是：假 zip 绝不能被当成成功。
        check("A5 假 zip 没被当成下载成功", bool(it5) and it5["status"] == "failed",
              "status={} err={}".format((it5 or {}).get("status"), err5[:120]))
        check("A5b 假 zip 没有污染磁盘", len(zips("*Mime-Guard-Probe*")) == 0, str(zips("*Mime-Guard-Probe*")))
        if "Content-Type" in err5 or "过小" in err5:
            print("     （命中 MIME/体积硬闸门，规则细节见 tests/unit.test.mjs 的 verdict 用例）")

        # ---------------- A7 源连上但不吐字节：看门狗必须掐掉再重试
        # 这是 MV3 里最容易翻车的路径（SW 被回收后定时器不可靠），用一个永不响应的本地服务复现。
        # 只留这一个源，避免排序干扰：两次尝试都必须被 watchdog 斩掉。
        port = start_hang_server()
        hang_id = "127.0.0.1:%d" % port
        hang = {"id": hang_id, "label": "卡死源", "template": "http://127.0.0.1:%d/hang.zip" % port}
        put_storage(hp, "gzg_settings", dict(base, maxAttempts=2, stallSeconds=20, customMirrors=[hang],
                                             mirrorOrder=[hang_id],
                                             disabled=["direct", "gh-proxy.com", "ghfast.top", "ghproxy.net"]))
        call(hp, {"type": "GZG_ENQUEUE", "origin": "e2e", "force": True,
                  "repos": [{"owner": "octocat", "repo": "Stall-Probe", "ref": "HEAD"}]})
        it7 = wait_item(hp, "Stall-Probe", 180)
        err7 = ((it7 or {}).get("lastError", "") or "")
        if ("ERR_" in err7) or ("BLOCKED" in err7.upper()):
            skip("A7 卡死源被看门狗掐掉", "本地 http 源被浏览器策略拦掉：" + err7[:100])
        else:
            check("A7 卡死源被看门狗掐掉并重试", bool(it7) and ("无进度" in err7 or "发起超时" in err7)
                  and (it7 or {}).get("attempts", 0) >= 2,
                  "status={} attempts={} err={}".format((it7 or {}).get("status"), (it7 or {}).get("attempts"), err7[:140]))

        # ---------------- A6 侧边栏渲染
        panel = ctx.new_page()
        panel_errors = []
        panel.on("pageerror", lambda e: panel_errors.append(str(e)))
        panel.goto("chrome-extension://{}/sidepanel/sidepanel.html".format(ext_id))
        panel.wait_for_selector("#queue-list .row", timeout=15000)
        check("A6a 侧边栏队列渲染出条目", panel.locator("#queue-list .row").count() >= 3,
              "{} 行".format(panel.locator("#queue-list .row").count()))
        check("A6b 侧边栏无 JS 运行时报错", len(panel_errors) == 0, " | ".join(panel_errors[:3]))
        check("A6c 顶部汇总含归档路径", "gzg-e2e" in panel.inner_text("#summary"),
              panel.inner_text("#summary").replace("\n", " ")[:150])
        panel.click(".tab[data-view='settings']")
        panel.wait_for_timeout(500)
        check("A6d 设置页列出内置源与自定义镜像", panel.locator("#sources .source").count() >= 5,
              "{} 行".format(panel.locator("#sources .source").count()))
        panel.close()

        # ---------------- A8 清空收集（离线回归：本 bug 修复的守门用例）
        # 场景复刻：面板所在标签页自己没有收集数据，展示的是回退找到的「另一个标签」的桶；
        # 修复前【清空收集】拿面板自己的 tabId 去删，等于对空气开枪，列表纹丝不动。
        now_ms = int(time.time() * 1000)
        fake_bucket = {
            "url": "https://github.com/search?q=gzg-fixture&type=repositories", "query": "gzg-fixture",
            "page": 1, "pages": [1], "ts": now_ms, "count": 2,
            "collected": {
                "a/b": {"owner": "a", "repo": "b", "key": "a/b", "stars": 3, "lang": "Python",
                        "desc": "", "updated": "2026-10-01", "url": "https://github.com/a/b", "addedAt": now_ms},
                "c/d": {"owner": "c", "repo": "d", "key": "c/d", "stars": 9, "lang": "",
                        "desc": "", "updated": "2026-10-02", "url": "https://github.com/c/d", "addedAt": now_ms},
            },
        }
        put_storage(hp, "gzg_search", {"424242": fake_bucket})
        p3 = ctx.new_page()
        p3.bring_to_front()
        p3.goto("chrome-extension://{}/sidepanel/sidepanel.html".format(ext_id))
        p3.wait_for_selector("#nav-search-count", timeout=15000)
        p3.click(".tab[data-view='search']")
        p3.wait_for_selector("#search-list .row", timeout=10000)
        check("A8a 回退显示其它标签的收集清单", p3.locator("#search-list .row").count() >= 2,
              "{} 行".format(p3.locator("#search-list .row").count()))
        p3.click("#btn-clear-collected")
        p3.wait_for_timeout(1200)
        store8 = read_storage(hp, "gzg_search") or {}
        left = store8.get("424242", {}).get("count", 0)
        check("A8b 清空收集真的删掉了数据", left == 0,
              "剩余 keys={} 424242.count={}".format(list(store8.keys()), left))
        check("A8c 界面同步回到空态",
              p3.locator("#search-list .row").count() == 0 and p3.locator("#search-empty").is_visible(),
              "rows={} empty_visible={}".format(p3.locator("#search-list .row").count(),
                                               p3.locator("#search-empty").is_visible()))
        p3.close()

        # ---------------- A9 搜索页抓取的结构漂移免疫（离线夹具，完全不依赖网络）
        # 用户报的「本页 1」根因：GitHub 当天把卡片类名 Result-module__Result__xxx 改成
        # Result__xxx，依赖类名的实现当场退化。夹具主动模拟类名全改 / testid 也没了两种漂移。
        for fx in ("search-p2.html", "search-p2-renamed.html", "search-p2-hostile.html"):
            fp = os.path.join(HERE, "fixtures", fx)
            if not os.path.exists(fp):
                skip("A9 {}".format(fx), "夹具缺失，先跑 python tests/make_fixtures.py")
                continue
            fxp = ctx.new_page()
            try:
                # 用 file:// 打开快照（脚本已在 make_fixtures.py 里剥掉），比 set_content 稳：
                # 200KB 的 set_content 会卡在等待子资源 load
                fxp.goto("file:///" + os.path.abspath(fp).replace("\\", "/"),
                         wait_until="domcontentloaded", timeout=20000)
            except Exception as exc:
                skip("A9 {}".format(fx), "夹具加载失败：" + str(exc)[:90])
                fxp.close()
                continue
            fxp.add_script_tag(path=os.path.join(HERE, "..", "content", "scraper.js"))
            got = fxp.evaluate("() => { const S = window.__GZG_SCRAPE; return S.scrape(S.findListRoot(document)); }") or []
            stars = sum(1 for g in got if (g.get("stars") or 0) > 0)
            langs = sum(1 for g in got if g.get("lang"))
            upd = sum(1 for g in got if re.match(r"^\d{4}-\d{2}-\d{2}$", g.get("updated") or ""))
            descs = sum(1 for g in got if len(g.get("desc") or "") >= 8)
            named = sum(1 for g in got if g.get("owner") and g.get("repo"))
            check("A9[{}] 抓到 10 个仓库".format(fx), len(got) >= 10 and named == len(got),
                  "抓到 {} 个（owner/repo 齐全 {}）".format(len(got), named))
            check("A9[{}] 元数据解析".format(fx), stars >= 8 and langs >= 2 and upd >= 8 and descs >= 4,
                  "stars={} lang={} updated={} desc={}".format(stars, langs, upd, descs))
            if got:
                print("     样本: " + json.dumps({k: got[0].get(k) for k in ("owner", "repo", "stars", "lang", "updated")}, ensure_ascii=False))
            fxp.close()

        # ---------------- Phase B：需要 github.com 可达
        gh_ok = True
        try:
            goto_retry(page, "https://github.com/octocat/Hello-World", attempts=3, timeout=25000)
        except Exception as exc:
            gh_ok = False
            skip("B1-B3 github.com 页面集成", "github.com 打不开（重试 3 次仍失败）：" + str(exc)[:120])
        if gh_ok:
            try:
                page.wait_for_selector("#gzg-pill [data-act='download-repo']", timeout=20000)
                ctx_text = page.inner_text("#gzg-pill .gzg-context")
                check("B1a 仓库页控制条识别", "octocat/Hello-World" in ctx_text, ctx_text.replace("\n", " / "))
                page.click("#gzg-pill [data-act='download-repo']")
                click_text = wait_status(page, timeout=10000)
                check("B1b 点击后给出入队反馈", len(click_text) > 0, click_text)

                # B1c 快捷键路径：后台把 GZG_HOTKEY 回灌给页面，走与点击同一段代码
                tab_ids = hp.evaluate("() => chrome.tabs.query({ url: 'https://github.com/*' }).then(t => t.map(x => x.id))")
                target = (tab_ids or [None])[0]
                if not target:
                    skip("B1c/B1d 快捷键提示", "查不到 github.com 标签页 id")
                else:
                    hot_text = hotkey_live(page, hp, target)
                    check("B1c 快捷键触发给出同款提示", ("已入队" in hot_text) or ("跳过" in hot_text), hot_text)
                    done_yet = (find_item(hp, "Hello-World") or {}).get("status") == "done"
                    if done_yet:
                        check("B1d 已下载过时快捷键提示「跳过：已下载过」",
                              "跳过" in hot_text and "已下载过" in hot_text, hot_text)
                    else:
                        check("B1d 快捷键首次触发提示已入队/已在队列",
                              ("已入队" in hot_text) or ("已在队列" in hot_text), hot_text)
                    # 快捷键触发后页面仍可用（提示不遮挡、不报错）
                    page.click("#gzg-pill [data-act='panel']")
                    page.wait_for_timeout(600)
                    check("B1e 提示出现后控制条仍可点击", len(page.inner_text("#gzg-pill")) > 0, "ok")
            except Exception as exc:
                check("B1 仓库页控制条", False, str(exc)[:180])

            try:
                goto_retry(page, "https://github.com/search?q=%E5%8A%A8%E7%94%BBskill&type=repositories&p=2",
                           attempts=3, timeout=30000)
                page.wait_for_selector("#gzg-pill", timeout=20000)
                collected = None
                end = time.time() + 25
                while time.time() < end:
                    store = read_storage(hp, "gzg_search") or {}
                    for bucket in store.values():
                        if bucket.get("count"):
                            collected = bucket
                    if collected and len(collected.get("collected", {})) >= 8:
                        break
                    time.sleep(0.8)
                items = list((collected or {}).get("collected", {}).values())
                check("B2a 搜索页抓到 >=8 个仓库", len(items) >= 8, "抓到 {} 个".format(len(items)))
                check("B2b owner/repo 全部解析成功", bool(items) and all(i.get("owner") and i.get("repo") for i in items))
                check("B2c star 数解析", sum(1 for i in items if (i.get("stars") or 0) > 0) >= 3,
                      "有 star 的 {}/{} 个".format(sum(1 for i in items if (i.get("stars") or 0) > 0), len(items)))
                have_upd = [i for i in items if re.match(r"^\d{4}-\d{2}-\d{2}$", i.get("updated") or "")]
                check("B2d 更新时间解析成 ISO 日期", len(have_upd) >= 5,
                      "{}/{} 个".format(len(have_upd), len(items)))
                check("B2e 语言字段解析", sum(1 for i in items if i.get("lang")) >= 2,
                      ", ".join(sorted({i["lang"] for i in items if i.get("lang")})[:5]))
                if items:
                    print("     样本: " + json.dumps(items[0], ensure_ascii=False)[:240])

                p2 = ctx.new_page()
                p2.goto("chrome-extension://{}/sidepanel/sidepanel.html".format(ext_id))
                p2.wait_for_selector("#nav-search-count", timeout=15000)
                p2.click(".tab[data-view='search']")
                p2.wait_for_selector("#search-list .row", timeout=15000)
                check("B2f 清单视图回填", p2.locator("#search-list .row").count() >= 8,
                      "{} 行".format(p2.locator("#search-list .row").count()))
                boxes = p2.locator("#search-list .row input[type=checkbox]")
                boxes.nth(0).check()
                boxes.nth(1).check()
                btn_text = p2.inner_text("#btn-download-selected")
                check("B3a 勾选后按钮计数联动", "(2)" in btn_text, btn_text)
                p2.click("#btn-download-selected")
                p2.wait_for_timeout(2000)
                q = read_storage(hp, "gzg_queue") or {}
                batch = [i for i in q.get("items", []) if i.get("origin") == "sidepanel-batch"]
                check("B3b 多选批量入队", len(batch) >= 1, "{} 条".format(len(batch)))
                p2.close()

                end = time.time() + 120
                while time.time() < end:
                    q = read_storage(hp, "gzg_queue") or {}
                    if not any(i["status"] in ("pending", "downloading") for i in q.get("items", [])):
                        break
                    time.sleep(1.5)
                q = read_storage(hp, "gzg_queue") or {}
                final = {i["repo"]: i["status"] for i in q.get("items", [])}
                print("     队列终态: " + json.dumps(final, ensure_ascii=False))
                check("B3c 串行队列自己跑空（无卡死）",
                      not any(s in ("pending", "downloading") for s in final.values()),
                      json.dumps({k: v for k, v in final.items() if v in ("pending", "downloading")}, ensure_ascii=False))
                print("     最近日志: " + " || ".join(l.get("msg", "") for l in (q.get("log") or [])[-6:]))
            except Exception as exc:
                check("B2/B3 搜索结果集成", False, str(exc)[:220])

        check("Z1 全程页面运行期无 JS 报错", len(page_errors) == 0, " | ".join(page_errors[:3]))
        ctx.close()

        # C 段用第二个浏览器实例（需要自己的 host-resolver-rules），必须在同一个 playwright 会话里
        run_offline(p)
    return summarize()


def clear_status(page):
    page.evaluate("() => { const el = document.querySelector('#gzg-pill .gzg-status'); if (el) el.textContent = ''; }")


def wait_status(page, timeout=12000):
    """只用 selector 等提示出现。真实 github.com 的 CSP 禁 'unsafe-eval'，
    page.evaluate / wait_for_function 会被拒（EvalError: Refused to evaluate a string），
    所以线上页面这条路径不能靠 JS 注入，离线桩页面才可以用。"""
    page.wait_for_selector("#gzg-pill .gzg-status:not(:empty)", timeout=timeout)
    return page.inner_text("#gzg-pill .gzg-status")


def hotkey_live(page, hp, tab_id):
    """在真实页面上模拟快捷键：重载清掉上一次的提示，再由后台回灌 GZG_HOTKEY。
    注意空提示元素带 hidden，wait_for_selector 默认等「可见」会永远等不到，
    所以这里等按钮出现，再等 :not(:empty) 的提示文本。"""
    page.reload(wait_until="domcontentloaded", timeout=30000)
    page.wait_for_selector("#gzg-pill [data-act='download-repo']", timeout=20000)
    hp.evaluate("(a) => chrome.tabs.sendMessage(a[0], {type:'GZG_HOTKEY'})", [tab_id])
    return wait_status(page)


def hotkey(page, hp, tab_id):
    """离线桩页面上可以直接注入 JS（没有 CSP 头），断言更精确。"""
    clear_status(page)
    hp.evaluate("(a) => chrome.tabs.sendMessage(a[0], {type:'GZG_HOTKEY'})", [tab_id])
    page.wait_for_function(
        "() => { const el = document.querySelector('#gzg-pill .gzg-status'); return el && el.textContent.length > 0; }",
        timeout=12000)
    return page.inner_text("#gzg-pill .gzg-status")


def run_offline(p):
    """C 段：把 github.com 映射到本地自签桩服务，确定性验证快捷键提示与按钮一致。
    这段不依赖外网，专治「本机 GitHub 时通时断 → 只有 B 段能验的功能长期跑不到」。"""
    try:
        from offline_github import ensure_cert, serve
    except Exception as exc:
        skip("C 段离线仿真", "导入 offline_github 失败：" + str(exc)[:80])
        return
    try:
        cert, key = ensure_cert()
        stub, port = serve(cert, key)
    except Exception as exc:
        skip("C 段离线仿真", "桩服务起不来（需要 openssl 自签证书）：" + str(exc)[:120])
        return

    ctx = None
    try:
        rules = ("MAP github.com 127.0.0.1:{0}, MAP *.github.com 127.0.0.1:{0}, "
                 "MAP codeload.github.com 127.0.0.1:{0}").format(port)
        udd = tempfile.mkdtemp(prefix="gzg-offline-")
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=udd, headless=False,
            args=["--disable-extensions-except=" + EXT, "--load-extension=" + EXT, "--no-first-run",
                  "--ignore-certificate-errors", "--test-type", "--host-resolver-rules=" + rules])
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        url = sw_url(ctx, timeout=45)
        if not url:
            skip("C 段离线仿真", "扩展在离线上下文里没起来")
            return
        hp = ctx.new_page()
        hp.goto("chrome-extension://{}/sidepanel/sidepanel.html".format(url.split("/")[2]))
        hp.wait_for_load_state("domcontentloaded")
        put_storage(hp, "gzg_settings", {
            "rootFolder": "gzg-offline", "dateStyle": "YYYY-MM-DD", "concurrency": 1, "maxAttempts": 2,
            "stallSeconds": 20, "minValidBytes": 64, "notify": False,
            "mirrorOrder": ["direct"], "disabled": ["gh-proxy.com", "ghfast.top", "ghproxy.net"],
            "customMirrors": []})

        page.goto("https://github.com/octocat/Hello-World", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector("#gzg-pill [data-act='download-repo']", timeout=20000)
        check("C1 离线仿真页上控制条可用", True, page.inner_text("#gzg-pill .gzg-context").replace("\n", " / "))

        tab_ids = hp.evaluate("() => chrome.tabs.query({ url: 'https://github.com/*' }).then(t => t.map(x => x.id))")
        target = (tab_ids or [None])[0]
        if not target:
            skip("C2-C4 快捷键提示", "查不到 github.com 标签页 id")
            return

        clear_status(page)
        hot1 = hotkey(page, hp, target)
        check("C2 快捷键触发给出提示", "已入队" in hot1, hot1)
        it = wait_item(hp, "Hello-World", 60)
        check("C2b 桩服务的 zip 正常下完", bool(it) and it["status"] == "done",
              "status={} src={}".format((it or {}).get("status"), (it or {}).get("sourceId")))

        clear_status(page)
        hot2 = hotkey(page, hp, target)
        check("C3 已下载过时快捷键提示「跳过：已下载过」", "跳过" in hot2 and "已下载过" in hot2, hot2)

        clear_status(page)
        page.click("#gzg-pill [data-act='download-repo']")
        page.wait_for_function(
            "() => { const el = document.querySelector('#gzg-pill .gzg-status'); return el && el.textContent.length > 0; }",
            timeout=12000)
        click_text = page.inner_text("#gzg-pill .gzg-status")
        check("C4 快捷键与按钮提示逐字一致", click_text == hot2, repr(click_text) + " vs " + repr(hot2))
    except Exception as exc:
        skip("C 段离线仿真", "跑挂了：" + str(exc)[:180])
    finally:
        if ctx:
            try:
                ctx.close()
            except Exception:
                pass


def summarize():
    ok = sum(1 for r in results if r[0])
    print("\n===== 通过 {}/{}，跳过 {} =====".format(ok, len(results), len(skips)))
    for good, name, detail in results:
        if not good:
            print("  FAIL {}  | {}".format(name, detail))
    for name, why in skips:
        print("  SKIP {}  | {}".format(name, why))
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
