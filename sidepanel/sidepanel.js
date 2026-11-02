import { parseGitHubUrl, buildFilename, formatBytes, formatBps } from '../background/lib/naming.js';

const state = {
  view: 'repo',
  items: [],
  log: [],
  summary: {},
  settings: null,
  health: {},
  sources: [],
  searchStore: {},
  shortcuts: {},
  activeTab: null,
  activeInfo: { kind: 'other' },
  selection: new Set(),
  filter: '',
  sort: 'stars',
  busy: false
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
};

function send(msg) {
  return chrome.runtime.sendMessage(msg).then((r) => r || { ok: false, error: '无响应' })
    .catch((e) => ({ ok: false, error: String(e?.message || e) }));
}

// ---------------------------------------------------------------- 数据刷新

async function refresh() {
  const [snap, store, tabs] = await Promise.all([
    send({ type: 'GZG_SNAPSHOT' }),
    send({ type: 'GZG_SEARCH_LIST' }),
    chrome.tabs.query({ active: true, currentWindow: true })
  ]);
  if (snap.ok) {
    state.items = snap.items || [];
    state.log = snap.log || [];
    state.summary = snap.summary || {};
    state.settings = snap.settings;
    state.health = snap.health || {};
    state.sources = snap.sources || [];
  }
  if (store.ok) state.searchStore = store.store || {};
  const sc = await send({ type: 'GZG_SHORTCUTS' });
  if (sc && sc.ok) state.shortcuts = sc.shortcuts || {};
  state.activeTab = tabs[0] || null;
  state.activeInfo = parseGitHubUrl(state.activeTab?.url || '');
  render();
}

function currentCollected() {
  const tabId = state.activeTab?.id;
  const bucket = state.searchStore[String(tabId)] || null;
  if (bucket) return { tabId, bucket };
  // 面板自己的 tab id 不在 store 里时，退化成「最近一次有收集结果的标签」。
  // 必须把来源 tabId 一起返回，否则【清空收集】会拿当前 tabId 去删，
  // 显示的是别的标签的清单、删的却是空气（正是"点了没反应"的根因）。
  const ids = Object.keys(state.searchStore).filter((k) => (state.searchStore[k]?.count || 0) > 0);
  if (!ids.length) return { tabId: null, bucket: { collected: {}, count: 0, pages: [], query: '', url: '' } };
  ids.sort((a, b) => (state.searchStore[b].ts || 0) - (state.searchStore[a].ts || 0));
  return { tabId: Number(ids[0]), bucket: state.searchStore[ids[0]] };
}

function collectedList() {
  const { bucket } = currentCollected();
  let list = Object.values(bucket.collected || {});
  const f = state.filter.trim().toLowerCase();
  if (f) list = list.filter((it) => `${it.owner}/${it.repo} ${it.desc || ''} ${it.lang || ''}`.toLowerCase().includes(f));
  const cmp = {
    stars: (a, b) => (b.stars || 0) - (a.stars || 0),
    updated: (a, b) => String(b.updated || '').localeCompare(String(a.updated || '')),
    name: (a, b) => `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`),
    added: (a, b) => (a.addedAt || 0) - (b.addedAt || 0)
  }[state.sort] || ((a, b) => 0);
  return { list: list.sort(cmp), bucket };
}

// ---------------------------------------------------------------- 渲染

function render() {
  const s = state.summary;
  $('#nav-search-count').textContent = String(currentCollected().bucket.count || 0);
  $('#nav-queue-count').textContent = String((s.pending || 0) + (s.downloading || 0));
  $('#summary').textContent = state.settings
    ? `待下 ${s.pending || 0} · 进行中 ${s.downloading || 0} · 完成 ${s.done || 0}${s.failed ? ` · 失败 ${s.failed}` : ''} · 归档到「下载」/${state.settings.rootFolder ? `${state.settings.rootFolder}/` : ''}${dateFolderPreview()}`
    : '加载中…';

  for (const btn of document.querySelectorAll('.tab')) {
    btn.setAttribute('aria-selected', String(btn.dataset.view === state.view));
  }
  for (const v of ['repo', 'search', 'queue', 'settings']) {
    $(`#view-${v}`).hidden = v !== state.view;
  }

  renderRepo();
  renderSearch();
  renderQueue();
  renderSettings();
}

function dateFolderPreview() {
  try {
    return buildFilename({ owner: 'o', repo: 'r', ref: 'HEAD', settings: state.settings || {} })
      .split('/').slice(-2, -1)[0] || '';
  } catch { return ''; }
}

function renderRepo() {
  const box = $('#repo-card');
  box.textContent = '';
  const info = state.activeInfo;
  if (info.kind !== 'repo') {
    box.appendChild(el('p', 'hint', '当前标签页不是仓库页。打开任意 https://github.com/所有者/仓库 页面后，这里会出现下载入口。'));
    return;
  }
  const ref = info.branch || 'HEAD';

  const head = el('div', 'repo-head');
  head.appendChild(el('span', 'repo-title', `${info.owner}/${info.repo}`));
  head.appendChild(el('span', 'chip', ref === 'HEAD' ? '默认分支' : ref));
  box.appendChild(head);

  const bar = el('div', 'toolbar');
  const refInput = el('input');
  refInput.type = 'text';
  refInput.placeholder = '分支 / 标签（留空=默认）';
  refInput.value = ref === 'HEAD' ? '' : ref;
  refInput.style.flex = '1 1 150px';
  const btn = el('button', 'btn primary');
  const scKey = state.shortcuts['download-current-repo'];
  btn.append(document.createTextNode('下载源码 zip '));
  const kbd = el('kbd', 'kbd', scKey || '未绑定');
  kbd.title = scKey ? '快捷键可在 edge://extensions/shortcuts 修改' : '尚未绑定快捷键，可在 edge://extensions/shortcuts 设置';
  btn.appendChild(kbd);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const r = await send({
      type: 'GZG_ENQUEUE',
      origin: 'sidepanel-repo',
      repos: [{ owner: info.owner, repo: info.repo, ref: refInput.value.trim() || 'HEAD' }]
    });
    btn.disabled = false;
    flash(r?.ok ? (r.added?.length ? '已入队，切到「队列」看进度' : `跳过：${r.skipped?.[0]?.reason || '已存在'}`) : `失败：${r?.error}`);
    await refresh();
  });
  const link = el('button', 'btn', '复制直链');
  link.addEventListener('click', () => {
    navigator.clipboard.writeText(`https://github.com/${info.owner}/${info.repo}/archive/HEAD.zip`);
    flash('已复制 archive/HEAD.zip 直链');
  });
  const open = el('button', 'btn', '打开仓库页');
  open.addEventListener('click', () => chrome.tabs.update(state.activeTab.id, { url: `https://github.com/${info.owner}/${info.repo}` }));
  bar.append(refInput, btn, link, open);
  box.appendChild(bar);

  box.appendChild(el('div', 'preview', `→ 下载/${filenamePreview(info.owner, info.repo, refInput.value.trim() || 'HEAD')}`));
  refInput.addEventListener('input', () => {
    box.querySelector('.preview').textContent = `→ 下载/${filenamePreview(info.owner, info.repo, refInput.value.trim() || 'HEAD')}`;
  });
}

function filenamePreview(owner, repo, ref) {
  return buildFilename({ owner, repo, ref, settings: state.settings || {} });
}

function renderSearch() {
  const box = $('#search-list');
  const { list, bucket } = collectedList();
  box.textContent = '';
  $('#search-empty').hidden = list.length > 0;

  const selected = list.filter((it) => state.selection.has(it.key)).length;
  $('#btn-download-selected').textContent = `下载选中 (${selected})`;
  $('#btn-download-selected').disabled = selected === 0;
  $('#sel-all').checked = list.length > 0 && selected === list.length;
  $('#sel-all').indeterminate = selected > 0 && selected < list.length;

  if (bucket.query) {
    const head = el('div', 'meta');
    head.textContent = `查询「${bucket.query}」· 已收集 ${bucket.count} 个 · 覆盖第 ${(bucket.pages || []).join('、') || bucket.page} 页`;
    box.appendChild(head);
  }

  for (const it of list) {
    const row = el('div', 'row');
    const chk = el('input');
    chk.type = 'checkbox';
    chk.checked = state.selection.has(it.key);
    chk.addEventListener('change', () => {
      if (chk.checked) state.selection.add(it.key); else state.selection.delete(it.key);
      render();
    });

    const main = el('div', 'row-main');
    const name = el('div', 'name');
    const a = el('a', null, `${it.owner}/${it.repo}`);
    a.href = it.url || `https://github.com/${it.owner}/${it.repo}`;
    a.target = '_blank';
    a.rel = 'noreferrer';
    name.appendChild(a);
    main.appendChild(name);

    const meta = el('div', 'meta');
    const bits = [];
    if (it.stars) bits.push(`★ ${it.stars.toLocaleString()}`);
    if (it.forks) bits.push(`⑂ ${it.forks.toLocaleString()}`);
    if (it.lang) bits.push(it.lang);
    if (it.updated) bits.push(String(it.updated).slice(0, 10));
    meta.textContent = bits.join(' · ') || '—';
    main.appendChild(meta);

    if (it.desc) main.appendChild(el('div', 'desc', it.desc));
    row.append(chk, main);

    const one = el('button', 'btn mini', '下载');
    one.addEventListener('click', async () => {
      const r = await send({ type: 'GZG_ENQUEUE', origin: 'sidepanel-search', repos: [{ owner: it.owner, repo: it.repo, ref: 'HEAD', note: it.desc }] });
      flash(r?.ok ? (r.added?.length ? `${it.repo} 已入队` : `跳过：${r.skipped?.[0]?.reason}`) : `失败：${r?.error}`);
      await refresh();
    });
    row.appendChild(one);
    box.appendChild(row);
  }
}

function renderQueue() {
  const box = $('#queue-list');
  box.textContent = '';
  if (!state.items.length) {
    box.appendChild(el('p', 'empty', '队列是空的。在仓库页点「下载源码 zip」，或在「清单」里多选后批量入队。'));
  }

  const order = { downloading: 0, pending: 1, failed: 2, canceled: 3, done: 4 };
  const items = [...state.items].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.createdAt - a.createdAt);

  for (const it of items) {
    const row = el('div', 'row');
    const main = el('div', 'row-main');

    const name = el('div', 'name');
    name.textContent = `${it.owner}/${it.repo}`;
    main.appendChild(name);

    const meta = el('div', 'meta');
    const bits = [chipLabel(it.status)];
    if (it.ref && it.ref !== 'HEAD') bits.push(it.ref);
    if (it.attempts > 1 && it.status !== 'done') bits.push(`第 ${it.attempts} 次`);
    if (it.sourceId) bits.push(it.sourceId);
    if (it.total) bits.push(`${formatBytes(it.received)}/${formatBytes(it.total)}`);
    if (it.status === 'downloading' && it.bps) bits.push(formatBps(it.bps));
    if (it.status === 'done' && it.bps) bits.push(formatBps(it.bps));
    meta.textContent = bits.filter(Boolean).join(' · ');
    main.appendChild(meta);

    const fileLine = el('div', 'meta');
    fileLine.textContent = it.filename || '';
    main.appendChild(fileLine);

    if (it.lastError && it.status !== 'done') {
      const err = el('div', 'desc');
      err.style.color = 'var(--err)';
      err.textContent = it.lastError;
      main.appendChild(err);
    }
    row.appendChild(main);

    const pct = it.total ? Math.min(100, Math.round((it.received / it.total) * 100)) : 0;
    if (it.status === 'downloading') {
      const p = el('div', 'progress');
      const i = el('i');
      i.style.width = `${pct}%`;
      p.appendChild(i);
      row.insertBefore(p, main.nextSibling);
    }

    const acts = el('div', 'toolbar');
    acts.style.margin = '0';
    if (it.status === 'failed' || it.status === 'canceled') {
      const b = el('button', 'btn mini', '重试');
      b.addEventListener('click', async () => { await send({ type: 'GZG_RETRY', ids: [it.id] }); await refresh(); });
      acts.appendChild(b);
    }
    if (it.status === 'pending' || it.status === 'downloading') {
      const b = el('button', 'btn mini', '取消');
      b.addEventListener('click', async () => { await send({ type: 'GZG_CANCEL', ids: [it.id] }); await refresh(); });
      acts.appendChild(b);
    }
    if (it.status === 'done' && it.downloadId) {
      const b = el('button', 'btn mini', '定位文件');
      b.addEventListener('click', () => send({ type: 'GZG_SHOW_FILE', downloadId: it.downloadId }));
      acts.appendChild(b);
    }
    const rm = el('button', 'btn mini', '移除');
    rm.addEventListener('click', async () => { await send({ type: 'GZG_REMOVE', ids: [it.id] }); await refresh(); });
    acts.appendChild(rm);
    row.appendChild(acts);
    box.appendChild(row);
  }

  $('#log').textContent = (state.log || [])
    .slice(-80)
    .map((l) => `${new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false })} [${l.level}] ${l.msg}`)
    .join('\n');
}

function chipLabel(status) {
  return { pending: '排队中', downloading: '下载中', done: '已完成', failed: '失败', canceled: '已取消' }[status] || status;
}

function renderSettings() {
  const s = state.settings;
  if (!s) return;
  if (state.busy) return; // 用户正在输入时不回灌，避免光标跳动

  setVal('#s-rootFolder', s.rootFolder);
  setVal('#s-dateStyle', s.dateStyle);
  setVal('#s-concurrency', String(s.concurrency));
  setVal('#s-maxAttempts', s.maxAttempts);
  setVal('#s-stallSeconds', s.stallSeconds);
  setVal('#s-minValidBytes', s.minValidBytes);
  $('#s-notify').checked = !!s.notify;
  $('#s-overwrite').checked = !!s.overwrite;
  $('#s-autoOnRepo').checked = !!s.autoOnRepo;
  $('#sc-list').textContent = [
    `打开 / 关闭侧边栏：${state.shortcuts._execute_action || '未绑定'}`,
    `下载当前仓库源码 zip：${state.shortcuts['download-current-repo'] || '未绑定'}`
  ].join('\n');
  $('#path-preview').textContent = `示例：下载/${buildFilename({ owner: 'alchaincyf', repo: 'huashu-design', ref: 'HEAD', settings: s })}`;

  const box = $('#sources');
  box.textContent = '';
  for (const src of state.sources) {
    const h = state.health[src.id] || {};
    const row = el('div', 'source');
    const on = el('input');
    on.type = 'checkbox';
    on.checked = src.enabled;
    on.addEventListener('change', () => {
      const disabled = new Set(state.settings.disabled || []);
      if (on.checked) disabled.delete(src.id); else disabled.add(src.id);
      saveSettings({ disabled: [...disabled] });
    });
    const label = el('span', 'grow', `${src.label}${src.builtin ? '' : '（自定义）'}${src.enabled ? '' : ' [已停用]'}`);
    const stat = el('span', 'status');
    const cooled = h.badUntil && h.badUntil > Date.now();
    stat.textContent = [
      cooled ? '冷却中' : '',
      h.bps ? formatBps(h.bps) : '未测速',
      (h.ok || h.fail) ? `成功${h.ok || 0}/失败${h.fail || 0}` : ''
    ].filter(Boolean).join(' · ') || '待用';
    stat.className = `status ${cooled ? 'chip failed' : ''}`;
    const test = el('button', 'btn mini', '测速');
    test.addEventListener('click', () => speedTest([src.id]));
    row.append(on, label, stat, test);

    if (!src.builtin) {
      const del = el('button', 'btn mini danger', '删除');
      del.addEventListener('click', () => {
        const customMirrors = (state.settings.customMirrors || []).filter((m) => m.id !== src.id);
        const mirrorOrder = (state.settings.mirrorOrder || []).filter((id) => id !== src.id);
        saveSettings({ customMirrors, mirrorOrder });
      });
      row.appendChild(del);
    }
    box.appendChild(row);
  }
}

function setVal(sel, v) {
  const n = $(sel);
  if (n && document.activeElement !== n) n.value = String(v ?? '');
}

let flashTimer = null;
function flash(text) {
  const n = $('#summary');
  n.textContent = text;
  n.style.color = 'var(--info)';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { n.style.color = ''; render(); }, 2600);
}

async function saveSettings(patch) {
  state.busy = true;
  await send({ type: 'GZG_SETTINGS_SAVE', patch });
  state.busy = false;
  await refresh();
}

async function speedTest(ids) {
  $('#speed-status').textContent = '测速中…';
  const r = await send({ type: 'GZG_SPEED_TEST', ids });
  if (r?.ok) {
    $('#speed-status').textContent = r.results
      .map((x) => `${x.label} ${x.ok ? `${formatBps(x.bps)}` : '失败'}`)
      .join(' | ');
  } else {
    $('#speed-status').textContent = `测速失败：${r?.error}`;
  }
  await refresh();
}

// ---------------------------------------------------------------- 事件绑定

function bind() {
  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    state.view = btn.dataset.view;
    render();
  });

  $('#flt').addEventListener('input', (e) => { state.filter = e.target.value; renderSearch(); $('#nav-search-count').textContent = String(currentCollected().bucket.count || 0); });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; renderSearch(); });

  $('#sel-all').addEventListener('change', (e) => {
    const { list } = collectedList();
    if (e.target.checked) list.forEach((it) => state.selection.add(it.key));
    else list.forEach((it) => state.selection.delete(it.key));
    renderSearch();
  });

  $('#btn-clear-collected').addEventListener('click', async () => {
    // 清的是「当前正在展示的清单」，不一定是激活标签页 —— 面板会回退显示最近有数据的标签
    const { tabId } = currentCollected();
    await send({ type: 'GZG_SEARCH_CLEAR', tabId, all: tabId === null });
    state.selection.clear();
    await refresh();
  });

  $('#btn-download-selected').addEventListener('click', async () => {
    const { list } = collectedList();
    const picked = list.filter((it) => state.selection.has(it.key));
    if (!picked.length) return;
    const r = await send({
      type: 'GZG_ENQUEUE',
      origin: 'sidepanel-batch',
      repos: picked.map((it) => ({ owner: it.owner, repo: it.repo, ref: 'HEAD', note: it.desc }))
    });
    if (r?.ok) {
      flash(`入队 ${r.added.length} 个${r.skipped.length ? `，跳过 ${r.skipped.length} 个` : ''}`);
      state.view = 'queue';
    }
    await refresh();
  });

  $('#btn-retry-failed').addEventListener('click', async () => {
    const ids = state.items.filter((it) => it.status === 'failed' || it.status === 'canceled').map((it) => it.id);
    if (ids.length) await send({ type: 'GZG_RETRY', ids });
    await refresh();
  });
  $('#btn-clear-finished').addEventListener('click', async () => { await send({ type: 'GZG_CLEAR_FINISHED' }); await refresh(); });
  $('#btn-clear-all').addEventListener('click', async () => { await send({ type: 'GZG_CLEAR_ALL' }); await refresh(); });
  $('#btn-pump').addEventListener('click', async () => { await send({ type: 'GZG_RETRY', ids: state.items.filter((i) => i.status === 'pending').map((i) => i.id) }); await refresh(); });

  const bindField = (sel, key, cast = (v) => v) => {
    $(sel).addEventListener('change', (e) => saveSettings({ [key]: cast(e.target.value) }));
  };
  bindField('#s-rootFolder', 'rootFolder', (v) => v.split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .map((s) => s.replace(/[:*?"<>|]/g, '_').replace(/\.{2,}/g, '_').trim())
    .join('/'));
  bindField('#s-dateStyle', 'dateStyle');
  bindField('#s-concurrency', 'concurrency', (v) => parseInt(v, 10) || 1);
  bindField('#s-maxAttempts', 'maxAttempts', (v) => Math.max(1, parseInt(v, 10) || 8));
  bindField('#s-stallSeconds', 'stallSeconds', (v) => Math.max(20, parseInt(v, 10) || 90));
  bindField('#s-minValidBytes', 'minValidBytes', (v) => Math.max(22, parseInt(v, 10) || 64));
  $('#s-notify').addEventListener('change', (e) => saveSettings({ notify: e.target.checked }));
  $('#s-overwrite').addEventListener('change', (e) => saveSettings({ overwrite: e.target.checked }));
  $('#s-autoOnRepo').addEventListener('change', (e) => saveSettings({ autoOnRepo: e.target.checked }));

  $('#btn-speedtest').addEventListener('click', () => speedTest(null));

  $('#btn-add-mirror').addEventListener('click', () => {
    const label = $('#cm-label').value.trim();
    const template = $('#cm-template').value.trim();
    if (!template || !/{url}|\{o\}/.test(template)) {
      $('#speed-status').textContent = '模板需要包含 {url} 或 {o}/{r}/{ref}';
      return;
    }
    let host = '';
    try { host = new URL(template).host; } catch { $('#speed-status').textContent = '模板不是合法 URL'; return; }
    const id = host;
    const customMirrors = [...(state.settings.customMirrors || []).filter((m) => m.id !== id), { id, label: label || host, template }];
    const mirrorOrder = [...new Set([...(state.settings.mirrorOrder || []), ...customMirrors.map((m) => m.id)])];
    $('#cm-label').value = '';
    $('#cm-template').value = '';
    saveSettings({ customMirrors, mirrorOrder });
  });

  $('#btn-reset').addEventListener('click', async () => {
    const r = await send({ type: 'GZG_SNAPSHOT' });
    const defaults = {
      rootFolder: 'github', dateStyle: 'YYYY-MM-DD', concurrency: 1, autoOnRepo: false,
      maxAttempts: 8, minValidBytes: 64, stallSeconds: 90, notify: true, overwrite: false,
      mirrorOrder: ['direct', 'gh-proxy.com', 'ghfast.top', 'ghproxy.net'], disabled: [], customMirrors: []
    };
    await saveSettings(defaults);
    flash('已恢复默认设置');
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'GZG_CHANGED' || msg?.type === 'GZG_SEARCH_UPDATED') refresh();
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === state.activeTab?.id && (changeInfo.status === 'complete' || changeInfo.url)) refresh();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.gzg_queue || changes.gzg_settings)) refresh();
  });
}

async function boot() {
  bind();
  await refresh();
  if (state.activeInfo.kind === 'search') state.view = 'search';
  else if (state.activeInfo.kind === 'other' && (state.summary.pending || state.summary.downloading)) state.view = 'queue';
  render();
}

boot();
