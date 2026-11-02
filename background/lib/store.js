// 持久化层：设置 / 队列 / 源健康度 / 各标签页搜索结果。
// MV3 service worker 会被随时回收，任何只放内存的状态都会丢，所以一律走 chrome.storage。

const K = {
  settings: 'gzg_settings',
  queue: 'gzg_queue',
  health: 'gzg_health',
  search: 'gzg_search'
};

export const DEFAULT_SETTINGS = {
  rootFolder: 'github',          // 下载目录下的总子文件夹，留空则直接放日期目录
  dateStyle: 'YYYY-MM-DD',       // YYYY-MM-DD | YYYYMMDD | YYYY-MM | none
  concurrency: 1,                // 需求要求「每次下载一个」，默认严格串行
  autoOnRepo: false,             // 进仓库页是否自动入队（默认关，避免路过就下载）
  maxAttempts: 8,                // 单条目总尝试次数（跨源跨 ref 写法累计）
  minValidBytes: 64,             // 小于此体积判为错误页（空仓库 zip 也有 ~150 B）
  stallSeconds: 90,              // 无进度多久判卡死并换源
  notify: true,                  // 批量完成后弹一次系统通知
  overwrite: false,              // false = uniquify（重名自动加 (1)）
  mirrorOrder: ['direct', 'gh-proxy.com', 'ghfast.top', 'ghproxy.net'],
  disabled: [],
  customMirrors: [
    // { id: 'my-mirror', label: '自建镜像', template: 'https://my.host/{url}' }
  ]
};

async function get(key, fallback) {
  const raw = await chrome.storage.local.get(key);
  const v = raw[key];
  return v === undefined || v === null ? fallback : v;
}

async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
  return value;
}

export async function loadSettings() {
  const stored = await get(K.settings, {});
  return { ...structuredClone(DEFAULT_SETTINGS), ...stored };
}

export async function saveSettings(patch) {
  const cur = await loadSettings();
  const next = { ...cur, ...patch };
  await set(K.settings, next);
  return next;
}

export async function loadQueue() {
  const q = await get(K.queue, null);
  if (!q || !Array.isArray(q.items)) return { items: [], seq: 1, updatedAt: 0 };
  return q;
}

export async function saveQueue(q) {
  q.updatedAt = Date.now();
  await set(K.queue, q);
  return q;
}

export async function loadHealth() {
  return get(K.health, {});
}

export async function saveHealth(h) {
  await set(K.health, h);
  return h;
}

/** 搜索结果按标签页隔离，切标签就能看到对应清单 */
export async function loadSearchStore() {
  return get(K.search, {});
}

/**
 * 搜索结果按标签页隔离，并且跨页累加：
 * 第 1、2、3 页各点一次「收集本页」，清单就是三页的并集（按 owner/repo 去重）。
 */
export async function putSearchResults(tabId, payload) {
  const store = await loadSearchStore();
  const k = String(tabId);
  const prev = store[k] || { collected: {}, pages: [] };
  const collected = prev.collected || {};
  const pages = new Set(prev.pages || []);

  for (const it of payload.items || []) {
    const key = `${it.owner}/${it.repo}`.toLowerCase();
    if (!it.owner || !it.repo) continue;
    collected[key] = { ...collected[key], ...it, key, addedAt: collected[key]?.addedAt || Date.now() };
  }
  if (payload.page) pages.add(Number(payload.page));

  store[k] = {
    url: payload.url || prev.url || '',
    query: payload.query ?? prev.query ?? '',
    page: payload.page || prev.page || 1,
    pages: [...pages].sort((a, b) => a - b),
    collected,
    count: Object.keys(collected).length,
    ts: Date.now()
  };
  // 顺手清掉 3 天前的僵尸标签数据
  const cutoff = Date.now() - 3 * 86400000;
  for (const id of Object.keys(store)) {
    if ((store[id]?.ts || 0) < cutoff) delete store[id];
  }
  await set(K.search, store);
  return store;
}

export async function clearSearchResults(tabId) {
  const store = await loadSearchStore();
  if (tabId === undefined || tabId === null) {
    await set(K.search, {});
    return {};
  }
  delete store[String(tabId)];
  await set(K.search, store);
  return store;
}

export const STORAGE_KEYS = K;
