# -*- coding: utf-8 -*-
"""诊断：扩展到底有没有被 Chromium 装载（列 target + 抓 chrome://extensions 的报错文本）。"""
import json
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

EXT = "E:/git/gh-zip-grabber"

with sync_playwright() as p:
    udd = tempfile.mkdtemp(prefix="gzg-boot-")
    ctx = p.chromium.launch_persistent_context(
        user_data_dir=udd, headless=False,
        args=["--disable-extensions-except=" + EXT, "--load-extension=" + EXT, "--no-first-run"])
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    time.sleep(6)
    print("service_workers:", [w.url for w in ctx.service_workers])
    cdp = ctx.new_cdp_session(page)
    targets = cdp.send("Target.getTargets")["targetInfos"]
    for t in targets:
        print("  target:", t.get("type"), t.get("title", "")[:40], t.get("url", "")[:110])
    # chrome://extensions 的错误文本在 shadow DOM 里，逐个 open 元素取 innerText
    page.goto("chrome://extensions")
    page.wait_for_timeout(2500)
    txt = page.evaluate(r"""
      () => {
        const out = [];
        const mgr = document.querySelector('extensions-manager');
        const push = (el) => { if (el && el.shadowRoot) { out.push(el.shadowRoot.textContent || ''); } };
        push(mgr);
        const list = mgr && mgr.shadowRoot && mgr.shadowRoot.querySelector('extensions-item-list');
        push(list);
        const items = list && list.shadowRoot ? [...list.shadowRoot.querySelectorAll('extensions-item')] : [];
        items.forEach((it) => { out.push('ITEM: ' + (it.shadowRoot ? it.shadowRoot.textContent : it.textContent)); });
        const err = document.querySelector('extensions-error-message') ||
                    (mgr && mgr.shadowRoot && mgr.shadowRoot.querySelector('extensions-error-message'));
        push(err);
        return out.join('\n---\n').slice(0, 4000);
      }
    """)
    print("=== chrome://extensions 文本 ===")
    print(txt)
    ctx.close()
