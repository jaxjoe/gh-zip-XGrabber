// content script：GitHub 页面识别 + 悬浮控制条。
// 搜索结果抓取在 content/scraper.js（manifest 里先注入，同 isolated world 共享 window 全局），
// 这样抓取器能被离线页面夹具直接测试；保留字集合也只剩那一份，避免多处实现漂移。

(() => {
  'use strict';
  if (window.__GZG_LOADED__) return;
  window.__GZG_LOADED__ = true;

  const SCRAPER = window.__GZG_SCRAPE;
  if (!SCRAPER) {
    console.warn('[GZG] scraper.js 未加载，控制条不启用');
    return;
  }
  const { RESERVED_TOP, RESERVED_SECOND } = SCRAPER;

  function parseGitHubUrl(href) {
    let u;
    try { u = new URL(href, location.href); } catch { return { kind: 'other' }; }
    if (u.hostname !== 'github.com') return { kind: 'other' };
    const seg = decodeURIComponent(u.pathname).split('/').filter(Boolean);
    if (seg[0] === 'search') {
      let page = parseInt(u.searchParams.get('p') || '1', 10);
      if (!Number.isFinite(page) || page < 1) page = 1;
      return { kind: 'search', query: u.searchParams.get('q') || '', type: u.searchParams.get('type') || 'repositories', page };
    }
    if (seg.length >= 2 && !RESERVED_TOP.has(seg[0]) && !RESERVED_SECOND.has(seg[1])) {
      let branch = '';
      if (seg.length >= 4 && (seg[2] === 'tree' || seg[2] === 'archive')) {
        const rest = seg.slice(3).join('/');
        branch = /^[^/]+$/.test(rest) ? rest : '';
      }
      return { kind: 'repo', owner: seg[0], repo: seg[1], branch: branch || 'HEAD' };
    }
    return { kind: 'other' };
  }

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e?.message || e) }));
  }

  // 快捷键绑定要在界面上显示给用户（用户可能已在 edge://extensions/shortcuts 改过）
  let SHORTCUTS = {};
  async function loadShortcuts() {
    const r = await send({ type: 'GZG_SHORTCUTS' });
    if (r && r.ok) {
      SHORTCUTS = r.shortcuts || {};
      if (pill && pill.dataset.kind === 'repo') renderPill(parseGitHubUrl(location.href));
    }
  }

  function readStorage(key, fallback) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (res) => {
          const v = res?.[key];
          resolve(v === undefined || v === null ? fallback : v);
        });
      } catch {
        resolve(fallback);
      }
    });
  }

  function writeStorage(key, value) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [key]: value }, resolve);
      } catch {
        resolve();
      }
    });
  }

  function today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /**
   * 自动下载：全局开关 autoOnRepo 命中所有仓库，白名单 gzg_auto_repos 命中单个仓库。
   * 两条通道共用「同一仓库同一天只自动下一次」的去重，避免来回切标签页就把下载目录塞满。
   */
  async function maybeAutoDownload(info) {
    if (info.kind !== 'repo') return;
    const key = `${info.owner}/${info.repo}`.toLowerCase();
    const [settings, whitelist, seen] = await Promise.all([
      readStorage('gzg_settings', {}),
      readStorage('gzg_auto_repos', {}),
      readStorage('gzg_auto_seen', {})
    ]);
    if (!settings.autoOnRepo && !whitelist[key]) return;
    if (seen[key] === today()) return;

    await writeStorage('gzg_auto_seen', { ...seen, [key]: today() });
    const r = await send({ type: 'GZG_ENQUEUE', origin: 'auto', repos: [{ owner: info.owner, repo: info.repo, ref: 'HEAD' }] });
    if (r?.ok && r.added?.length) setStatus(`已自动入队 ${info.owner}/${info.repo}`, 'ok');
  }

  async function toggleRepoWhitelist(info) {
    const key = `${info.owner}/${info.repo}`.toLowerCase();
    const map = await readStorage('gzg_auto_repos', {});
    map[key] = !map[key];
    await writeStorage('gzg_auto_repos', map);
    return !!map[key];
  }

  // -------------------------------------------------------------- 搜索结果抓取
  // 实现已移到 content/scraper.js（同一 isolated world 共享全局），这样能被离线夹具测试覆盖。
  // 抓取以「仓库标题链接」为锚点、卡片边界由祖先推导，绝不依赖构建哈希类名。

  function scrapeSearchResults() {
    const root = SCRAPER.findListRoot(document);
    return SCRAPER.scrape(root);
  }

  function searchTotalCount() {
    return SCRAPER.searchTotalCount(document);
  }

  function pushResults(items, info) {
    if (!items.length) return Promise.resolve();
    // 注意：消息体的 type 是路由判别位，搜索类型必须叫 searchType，
    // 否则会把 'GZG_SEARCH_SAVE' 覆盖成 'repositories' 而被后台忽略。
    return send({
      type: 'GZG_SEARCH_SAVE',
      url: location.href,
      query: info.query,
      page: info.page,
      searchType: info.type,
      items
    });
  }

  // -------------------------------------------------------------- 悬浮控制条

  let pill = null;
  let currentKey = '';

  function ensurePill() {
    if (pill && document.documentElement.contains(pill)) return pill;
    pill = document.createElement('div');
    pill.id = 'gzg-pill';
    pill.dataset.open = '1';
    pill.innerHTML = `
      <button class="gzg-tab" data-act="toggle" title="展开 / 收起 GitHub Zip Grabber">GZG</button>
      <div class="gzg-body">
        <div class="gzg-line gzg-context"></div>
        <div class="gzg-actions"></div>
        <div class="gzg-line gzg-status" hidden></div>
      </div>`;
    document.documentElement.appendChild(pill);
    pill.addEventListener('click', onPillClick);
    return pill;
  }

  function setStatus(text, tone) {
    const el = pill?.querySelector('.gzg-status');
    if (!el) return;
    // 收起状态下 .gzg-body 是 display:none，提示会被吞掉 —— 快捷键触发时尤其要自动展开
    if (text && pill.dataset.open === '0') pill.dataset.open = '1';
    el.hidden = !text;
    el.textContent = text || '';
    el.dataset.tone = tone || '';
    if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 6000);
  }

  /** 高亮一下对应按钮，让"按下快捷键 = 点了哪个按钮"这件事看得见 */
  function pulse(el) {
    if (!el) return;
    el.classList.remove('gzg-pulse');
    void el.offsetWidth; // 重启动画
    el.classList.add('gzg-pulse');
    setTimeout(() => el.classList.remove('gzg-pulse'), 900);
  }

  /**
   * 下载当前仓库。按钮点击与快捷键（后台回灌 GZG_HOTKEY）共用这一条路径，
   * 所以两条入口的提示文案、去重行为、失败反馈完全一致。
   * @param {HTMLButtonElement|null} btn 触发按钮；快捷键路径下取面板上的按钮做高亮
   */
  async function downloadRepo(btn) {
    ensurePill(); // 快捷键可能在首屏渲染前到达，先保证提示有地方落
    const info = parseGitHubUrl(location.href);
    if (info.kind !== 'repo') {
      setStatus('当前页面不是仓库页，快捷键未触发下载', 'warn');
      return { ok: false, reason: 'not-repo' };
    }
    const target = btn || pill?.querySelector('[data-act="download-repo"]');
    if (target) {
      target.disabled = true;
      pulse(target);
    }
    const ref = pill?.querySelector('.gzg-ref')?.value?.trim() || info.branch || 'HEAD';
    const r = await send({
      type: 'GZG_ENQUEUE',
      origin: 'repo-page',
      repos: [{ owner: info.owner, repo: info.repo, ref }]
    });
    if (target) target.disabled = false;
    if (r?.ok && r.added?.length) setStatus(`已入队 ${info.owner}/${info.repo}（${ref}）→ 侧边栏看进度`, 'ok');
    else if (r?.skipped?.length) setStatus(`跳过：${r.skipped[0].reason}`, 'warn');
    else setStatus(`失败：${r?.error || '未知错误'}`, 'err');
    return r || { ok: false };
  }

  // 后台的 chrome.commands 回调打不进浏览器级快捷键，只能把信号回灌给页面，
  // 由页面走与点击完全相同的逻辑（顺带还能读到输入框里手填的分支名）
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg && msg.type === 'GZG_HOTKEY') {
      downloadRepo(null);
      respond({ ok: true });
      return;
    }
    return false;
  });

  async function onPillClick(e) {
    const ctl = e.target.closest('button, input[data-act]');
    if (!ctl) return;
    const act = ctl.dataset.act;
    const info = parseGitHubUrl(location.href);

    if (act === 'toggle') {
      pill.dataset.open = pill.dataset.open === '1' ? '0' : '1';
      return;
    }
    if (act === 'toggle-auto') {
      const on = await toggleRepoWhitelist(info);
      ctl.checked = on;
      setStatus(on ? `已把 ${info.repo} 加入自动下载` : `已取消 ${info.repo} 的自动下载`, 'ok');
      return;
    }
    if (act === 'panel') {
      await send({ type: 'GZG_OPEN_SIDE_PANEL' });
      return;
    }
    if (act === 'download-repo') {
      await downloadRepo(ctl);
      return;
    }
    if (act === 'collect-page') {
      const items = scrapeSearchResults();
      await pushResults(items, info);
      setStatus(`本页已收集 ${items.length} 个仓库`, 'ok');
      return;
    }
    if (act === 'download-page') {
      const items = scrapeSearchResults();
      if (!items.length) { setStatus('没抓到仓库，可能被折叠或页面未加载完', 'warn'); return; }
      await pushResults(items, info);
      const r = await send({
        type: 'GZG_ENQUEUE',
        origin: 'search-page',
        repos: items.map((it) => ({ owner: it.owner, repo: it.repo, ref: 'HEAD', note: it.desc }))
      });
      setStatus(r?.ok ? `本页 ${r.added.length} 个已入队${r.skipped.length ? `，跳过 ${r.skipped.length}` : ''}` : '入队失败', r?.ok ? 'ok' : 'err');
      return;
    }
  }

  function renderPill(info) {
    const el = ensurePill();
    const ctx = el.querySelector('.gzg-context');
    const actions = el.querySelector('.gzg-actions');
    el.dataset.kind = info.kind;

    if (info.kind === 'repo') {
      const sc = SHORTCUTS['download-current-repo'];
      const kbd = sc
        ? ` <kbd class="gzg-kbd" title="快捷键可在 edge://extensions/shortcuts 修改">${sc}</kbd>`
        : ` <kbd class="gzg-kbd gzg-kbd-off" title="未绑定快捷键，可在 edge://extensions/shortcuts 设置">未绑定</kbd>`;
      ctx.innerHTML = `<strong>${info.owner}/${info.repo}</strong><span class="gzg-sub">当前视图 ${info.branch === 'HEAD' ? '默认分支' : info.branch}</span>`;
      actions.innerHTML = `
        <button class="gzg-btn gzg-primary" data-act="download-repo">下载源码 zip${kbd}</button>
        <input class="gzg-ref" placeholder="${info.branch === 'HEAD' ? '分支/标签' : info.branch}" title="留空 = 默认分支（HEAD 自动解析）" value="${info.branch === 'HEAD' ? '' : info.branch}">
        <label class="gzg-auto"><input type="checkbox" data-act="toggle-auto"> 自动</label>
        <button class="gzg-btn" data-act="panel">队列 / 设置</button>`;
      const cb = actions.querySelector('[data-act="toggle-auto"]');
      readStorage('gzg_auto_repos', {}).then((map) => {
        cb.checked = !!map[`${info.owner}/${info.repo}`.toLowerCase()];
      });
      return;
    }

    if (info.kind === 'search') {
      const items = scrapeSearchResults();
      const total = searchTotalCount();
      ctx.innerHTML = `<strong>搜索结果</strong><span class="gzg-sub">${info.type === 'repositories' ? '仓库' : info.type} · 本页 ${items.length}${total ? ` / 共约 ${total.toLocaleString()}` : ''}${info.page > 1 ? ` · 第 ${info.page} 页` : ''}</span>`;
      actions.innerHTML = info.type === 'repositories'
        ? `
        <button class="gzg-btn gzg-primary" data-act="collect-page">收集本页 ${items.length} 个</button>
        <button class="gzg-btn" data-act="download-page">本页全部入队</button>
        <button class="gzg-btn" data-act="panel">清单 / 多选</button>`
        : `<button class="gzg-btn" data-act="panel">打开面板</button>
           <span class="gzg-sub">仅 repositories 搜索支持批量下载</span>`;
      return;
    }

    ctx.innerHTML = `<strong>GitHub Zip Grabber</strong><span class="gzg-sub">非仓库/搜索页</span>`;
    actions.innerHTML = `<button class="gzg-btn" data-act="panel">打开队列</button>`;
  }

  function refresh() {
    const info = parseGitHubUrl(location.href);
    const key = `${info.kind}:${info.owner || ''}/${info.repo || ''}:${location.search}`;
    if (key === currentKey) return;
    currentKey = key;
    renderPill(info);
    maybeAutoDownload(info);
    if (info.kind === 'search' && info.type === 'repositories') {
      // 新版搜索页是 React 渲染，SSR 已含结果，但仍补几次延迟抓取以防首屏空
      [0, 400, 1200, 2500].forEach((ms) => setTimeout(() => {
        const items = scrapeSearchResults();
        if (items.length) pushResults(items, info);
      }, ms));
    }
  }

  // GitHub 用 turbo 做无刷新导航：URL 变了页面不重载，content script 不能只跑一次
  const navEvents = ['turbo:load', 'popstate', 'navigationend'];
  for (const ev of navEvents) document.addEventListener(ev, () => setTimeout(refresh, 120));
  const pushState = history.pushState;
  const replaceState = history.replaceState;
  history.pushState = function (...args) { const r = pushState.apply(this, args); setTimeout(refresh, 120); return r; };
  history.replaceState = function (...args) { const r = replaceState.apply(this, args); setTimeout(refresh, 120); return r; };
  new MutationObserver(() => { if (document.querySelector('#gzg-pill') !== pill) { pill = null; refresh(); } })
    .observe(document.documentElement, { childList: true, subtree: false });

  refresh();
  loadShortcuts();
})();
