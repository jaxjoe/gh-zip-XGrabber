// 下载队列引擎（在 service worker 内运行）。
//
// 三条设计约束来自 MV3 的真实行为：
//   1. SW 空闲 ~30s 即被回收，定时器不可靠 —— 状态一律落 chrome.storage，
//      推进靠 downloads.onChanged 事件唤醒 + chrome.alarms 看门狗兜底。
//   2. 不能自己 fetch 再 createObjectURL（31 MB 仓库很吃内存），
//      一律交给 chrome.downloads，让浏览器接管磁盘写入。
//   3. SW 死亡期间可能正好有下载完成/失败，事件会丢 —— 所以每轮 pump 前先
//      reconcile：用 downloads.search 以浏览器为准核对每条 downloading 记录。

import { loadSettings, loadQueue, saveQueue, loadHealth, saveHealth } from './store.js';
import { buildFilename, itemKey } from './naming.js';
import { attemptPlan, buildSourceUrl, BAD_SOURCE_PENALTY_MS } from './sources.js';
import { verdict } from './verify.js';

const TICK_ALARM = 'gzg-tick';
const MAX_LOG = 120;
// 发起下载后等待句柄的宽限期。要大于 chrome.downloads.download() 的正常决议时间，
// 又要明显小于 stallSeconds，才能保证「连上不吐字节」的源被快速摘掉。
const START_GRACE_MS = 25000;

let pumping = false;

// ---------------------------------------------------------------- 日志

function pushLog(q, level, msg) {
  q.log = q.log || [];
  q.log.push({ t: Date.now(), level, msg });
  if (q.log.length > MAX_LOG) q.log.splice(0, q.log.length - MAX_LOG);
}

// ---------------------------------------------------------------- 入队

/**
 * @param {Array<{owner:string,repo:string,ref?:string,note?:string}>} repos
 * @param {{origin?:string, force?:boolean, now?:Date}} opts
 */
export async function enqueue(repos, opts = {}) {
  const settings = await loadSettings();
  const q = await loadQueue();
  const now = opts.now || new Date();
  const existing = new Map(q.items.map((it) => [it.key, it]));

  const added = [];
  const skipped = [];

  for (const input of repos) {
    const owner = String(input.owner || '').trim();
    const repo = String(input.repo || '').trim();
    if (!owner || !repo) continue;
    const ref = String(input.ref || 'HEAD').trim() || 'HEAD';
    const key = itemKey({ owner, repo, ref });

    const prev = existing.get(key);
    if (prev && !opts.force && ['pending', 'downloading', 'done'].includes(prev.status)) {
      skipped.push({ key, reason: prev.status === 'done' ? '已下载过' : '已在队列中' });
      continue;
    }
    if (prev && opts.force) {
      // 强制重下时，若旧条目正在下载必须先掐掉，否则它会变成一条
      // 队列里已不存在、事件也无人认领的孤儿下载（文件会莫名其妙多出来一份）
      if (prev.status === 'downloading' && prev.downloadId) {
        try {
          await chrome.downloads.cancel(prev.downloadId);
        } catch { /* 已结束 */ }
      }
      q.items = q.items.filter((x) => x !== prev);
    }

    const item = {
      id: `i${q.seq++}`,
      key,
      owner,
      repo,
      ref,
      note: input.note || '',
      origin: opts.origin || 'manual',
      status: 'pending',
      attempts: 0,
      sourceId: '',
      url: '',
      filename: buildFilename({ owner, repo, ref, settings, now }),
      downloadId: null,
      received: 0,
      total: 0,
      bps: 0,
      lastError: '',
      createdAt: now.getTime(),
      startedAt: 0,
      finishedAt: 0,
      lastProgressAt: 0
    };
    q.items.push(item);
    existing.set(key, item);
    added.push(item);
  }

  pushLog(q, 'info', added.length ? `入队 ${added.length} 个${skipped.length ? `，跳过 ${skipped.length} 个` : ''}` : `全部跳过（已在队列/已下载）`);
  await saveQueue(q);
  await refreshBadge();
  if (added.length) startTick();
  pump().catch(() => {});
  return { added: added.map(strip), skipped };
}

function strip(it) {
  return { id: it.id, owner: it.owner, repo: it.repo, ref: it.ref, status: it.status };
}

// ---------------------------------------------------------------- 推进

export async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    const settings = await loadSettings();
    let q = await loadQueue();
    const health = await loadHealth();

    q = await reconcile(q, settings, health);
    await failStalled(q, settings, health);

    const active = q.items.filter((it) => it.status === 'downloading').length;
    const limit = Math.max(1, Math.min(4, Number(settings.concurrency) || 1));

    let used = active;
    for (const item of q.items) {
      if (used >= limit) break;
      if (item.status !== 'pending') continue;
      const ok = await startOne(item, settings, health, q);
      if (ok) used += 1;
      else break; // 没有可用源了，等下一轮
    }

    await saveQueue(q);
    await saveHealth(health);
    await refreshBadge();
    await maybeNotify(q, settings);
  } finally {
    pumping = false;
    // 若还有 pending 且当前空闲，说明需要再来一轮（例如刚有下载失败重排）
    const q2 = await loadQueue();
    const stillActive = q2.items.some((it) => it.status === 'downloading');
    const hasPending = q2.items.some((it) => it.status === 'pending');
    if (hasPending && !stillActive) {
      setTimeout(() => pump().catch(() => {}), 500);
    } else if (!hasPending && !stillActive) {
      stopTick();
    }
  }
}

/** 以浏览器为准，核对所有 downloading 记录（SW 死亡期间的事件可能已丢） */
async function reconcile(q, settings, health) {
  const stuck = q.items.filter((it) => it.status === 'downloading');
  for (const item of stuck) {
    if (!item.downloadId) {
      // 句柄还没回来：给 chrome.downloads.download() 一点时间；超过宽限期说明这个源
      // 连上但不吐字节（promise 永挂），先按 URL 找回真实下载记录，找不回来才判失败换源。
      if (Date.now() - (item.startedAt || 0) < START_GRACE_MS) continue;
      const orphan = await findDownloadByUrl(item);
      if (orphan) {
        item.downloadId = orphan.id;
        item.lastProgressAt = Date.now();
        pushLog(q, 'warn', `#${item.id} 找回无句柄的下载 id=${orphan.id}`);
        if (orphan.state === 'complete') {
          await finalizeComplete(item, orphan, q, settings, health);
          continue;
        }
        if (orphan.state === 'interrupted') {
          await handleFailure(item, orphan.error || 'interrupted', q, settings, health);
          continue;
        }
        try {
          await chrome.downloads.cancel(orphan.id);
        } catch { /* noop */ }
        await handleFailure(item, `源无响应超过 ${Math.round(START_GRACE_MS / 1000)}s`, q, settings, health);
        continue;
      }
      await handleFailure(item, `发起超时（${Math.round(START_GRACE_MS / 1000)}s 内没有拿到下载句柄）`, q, settings, health);
      continue;
    }
    let found = [];
    try {
      found = await chrome.downloads.search({ id: item.downloadId });
    } catch {
      found = [];
    }
    const d = found[0];
    if (!d) {
      pushLog(q, 'warn', `#${item.id} 下载记录丢失，重新排队`);
      item.status = 'pending';
      item.downloadId = null;
      continue;
    }
    item.total = d.totalBytes || item.total;
    if (d.state === 'in_progress') {
      // 只有字节真的前进了才刷新心跳，否则会把 failStalled 的卡死判定永久抹掉
      const got = d.currentBytes || 0;
      if (got > (item.received || 0)) {
        item.received = got;
        item.lastProgressAt = Date.now();
      }
      continue;
    }
    if (d.state === 'complete') {
      item.received = d.fileSize || d.totalBytes || item.received;
      await finalizeComplete(item, d, q, settings, health, true);
      continue;
    }
    // interrupted
    await handleFailure(item, d.error || d.state || 'interrupted', q, settings, health);
  }
  return q;
}

/** 卡死检测：长时间零进度就掐掉换源（镜像站常见「连上但不动」） */
async function failStalled(q, settings, health) {
  const timeout = Math.max(20, Number(settings.stallSeconds) || 90) * 1000;
  for (const item of q.items) {
    if (item.status !== 'downloading') continue;
    if (!item.downloadId) continue; // 没句柄的由 reconcile 的宽限期逻辑负责，别双重计失败
    const last = item.lastProgressAt || item.startedAt || 0;
    if (!last || Date.now() - last < timeout) continue;
    if (item.downloadId) {
      try {
        await chrome.downloads.cancel(item.downloadId);
      } catch { /* 已结束 */ }
    }
    await handleFailure(item, `无进度超过 ${Math.round(timeout / 1000)}s`, q, settings, health);
  }
  return q;
}

/**
 * 按 URL 找回下载记录。用于 chrome.downloads.download() 的 promise 永挂、
 * 我们拿不到 id、但浏览器其实已经把这条下载建起来的情况。
 */
async function findDownloadByUrl(item) {
  if (!item.url) return null;
  let list = [];
  try {
    list = await chrome.downloads.search({ url: item.url, limit: 8, orderBy: ['startTime'] });
  } catch {
    return null;
  }
  const floor = (item.startedAt || 0) - 3000;
  return (list || []).find((d) => {
    const t = d.startTime ? new Date(d.startTime).getTime() : 0;
    return t >= floor;
  }) || null;
}

/**
 * 发起一次下载。
 *
 * 关键：绝不 await chrome.downloads.download()。镜像「接受连接但不吐字节」时，
 * 这个 promise 会一直挂着，若同步等待就会把 pumping 锁永久占住、整条队列死锁
 * （实测复现过：本地 hang 服务让条目 75 秒都停在 attempts=0）。
 * 所以这里同步把条目置为 downloading 并立即返回，id 由回调异步认领（adopt），
 * 拿不到句柄的情况交给看门狗 reconcile 兜底。
 */
async function startOne(item, settings, health, q) {
  const plan = attemptPlan(settings, health, item);
  if (!plan.length) {
    item.status = 'failed';
    item.lastError = '没有可用下载源（检查镜像设置）';
    pushLog(q, 'error', `#${item.id} ${item.key} 无可用源`);
    return false;
  }
  if (item.attempts >= (Number(settings.maxAttempts) || 8)) {
    item.status = 'failed';
    item.lastError = item.lastError || '超过最大尝试次数';
    pushLog(q, 'error', `#${item.id} ${item.repo} 重试耗尽：${item.lastError}`);
    return true;
  }

  const { source, refPath } = plan[item.attempts % plan.length];
  const url = buildSourceUrl(source, item.owner, item.repo, refPath);
  const filename = buildFilename({ owner: item.owner, repo: item.repo, ref: refPath, settings });

  item.attempts += 1;
  item.status = 'downloading';
  item.sourceId = source.id;
  item.url = url;
  item.filename = filename;
  item.refPath = refPath;
  item.startedAt = Date.now();
  item.lastProgressAt = Date.now();
  item.downloadId = null;
  item.received = 0;
  item.total = 0;
  pushLog(q, 'info', `#${item.id} 第${item.attempts}次 [${source.label}] ${item.owner}/${item.repo}@${refPath} → ${filename}`);

  chrome.downloads.download({
    url,
    filename,
    saveAs: false,
    conflictAction: settings.overwrite ? 'overwrite' : 'uniquify',
    method: 'GET'
  }).then(
    (id) => adoptDownload(item.id, id),
    (err) => rejectStart(item.id, String(err?.message || err))
  );
  return true;
}

/** 下载句柄回来了 */
async function adoptDownload(itemId, downloadId) {
  const q = await loadQueue();
  const item = q.items.find((it) => it.id === itemId);
  if (!item || item.status !== 'downloading') {
    // 期间已被取消或换源，这是个无主下载，直接掐掉别留孤儿文件
    try {
      await chrome.downloads.cancel(downloadId);
    } catch { /* noop */ }
    await saveQueue(q);
    return;
  }
  item.downloadId = downloadId;
  item.lastProgressAt = Date.now();
  pushLog(q, 'info', `#${item.id} 下载句柄 id=${downloadId}`);
  await saveQueue(q);
  await refreshBadge();
}

/** 发起就失败（URL 非法 / 被浏览器策略拦），换源重试 */
async function rejectStart(itemId, message) {
  const [q, settings, health] = await Promise.all([loadQueue(), loadSettings(), loadHealth()]);
  const item = q.items.find((it) => it.id === itemId);
  if (!item || item.status !== 'downloading') return;
  await handleFailure(item, `发起失败：${message}`, q, settings, health);
  await saveQueue(q);
  await saveHealth(health);
  await refreshBadge();
  pump().catch(() => {});
}

// ---------------------------------------------------------------- 事件

export async function handleDelta(delta) {
  const q = await loadQueue();
  const settings = await loadSettings();
  const health = await loadHealth();
  const item = q.items.find((it) => it.downloadId === delta.id);
  if (!item) {
    // 可能是 adopt() 还没把 id 写回、下载就已经结束（事件丢在窄窗口里）。
    // 交给 reconcile 按 URL 兜底找回，不要在这里下结论。
    if (delta.state && q.items.some((it) => it.status === 'downloading' && !it.downloadId)) {
      pump().catch(() => {});
    }
    return;
  }

  if (delta.totalBytes?.current) item.total = delta.totalBytes.current;
  if (delta.currentBytes?.current !== undefined) {
    if (delta.currentBytes.current > (item.received || 0)) {
      item.received = delta.currentBytes.current;
      item.lastProgressAt = Date.now();
    } else if (delta.currentBytes.current === 0) {
      item.lastProgressAt = item.lastProgressAt || item.startedAt || Date.now();
    }
  }

  const state = delta.state?.current;
  if (state === 'in_progress') {
    await saveQueue(q);
    return;
  }

  if (state === 'complete') {
    const [d] = await chrome.downloads.search({ id: delta.id });
    await finalizeComplete(item, d || delta, q, settings, health);
  } else if (state === 'interrupted') {
    await handleFailure(item, delta.error?.current || delta.interruptedReason || 'interrupted', q, settings, health);
  } else {
    await saveQueue(q);
    return;
  }

  await saveQueue(q);
  await saveHealth(health);
  await refreshBadge();
  pump().catch(() => {});
}

async function finalizeComplete(item, d, q, settings, health, quiet = false) {
  const size = d?.fileSize || d?.totalBytes || item.received || 0;
  const mime = String(d?.mime || '');
  const check = verdict({ size, mime, minBytes: Number(settings.minValidBytes) || 64, state: d?.state });

  const elapsed = Math.max(0.2, (Date.now() - (item.startedAt || Date.now())) / 1000);
  item.total = size;
  item.received = size;
  item.bps = Math.round(size / elapsed);
  item.finishedAt = Date.now();

  const h = (health[item.sourceId] = health[item.sourceId] || { ok: 0, fail: 0, bps: 0, badUntil: 0 });

  if (!check.ok) {
    // 实测镜像会用 9~14 字节的 text/plain，或 200 状态码的 HTML/JSON 页面冒充 .zip，
    // 必须判失败而不是当成功收下
    item.status = 'pending';
    item.downloadId = null;
    item.lastError = check.reason;
    h.fail += 1;
    h.badUntil = Date.now() + BAD_SOURCE_PENALTY_MS;
    // 把这份坏文件从磁盘和下载记录里一起清掉，避免用户误以为下载成功
    if (d?.id) {
      try {
        await chrome.downloads.removeFile(d.id);
        await chrome.downloads.erase({ id: d.id });
      } catch { /* 可能已被清理 */ }
    }
    pushLog(q, 'warn', `#${item.id} ${item.repo} 校验不过：${item.lastError}，换源重试`);
  } else {
    item.status = 'done';
    item.lastError = '';
    item.localPath = d?.filename || '';
    h.ok += 1;
    h.bps = h.bps ? Math.round(h.bps * 0.6 + item.bps * 0.4) : item.bps;
    h.badUntil = 0;
    if (!quiet) pushLog(q, 'info', `#${item.id} 完成 ${item.repo}.zip ${fmtSize(size)} · ${Math.round(item.bps / 1024)} KB/s [${item.sourceId}]`);
  }
}

async function handleFailure(item, reason, q, settings, health) {
  const h = (health[item.sourceId || 'unknown'] = health[item.sourceId || 'unknown'] || { ok: 0, fail: 0, bps: 0, badUntil: 0 });
  h.fail += 1;
  h.badUntil = Date.now() + BAD_SOURCE_PENALTY_MS;

  if (item.downloadId) {
    // cancel 会顺带丢弃 .crdownload，避免失败碎片堆在下载目录里
    try {
      await chrome.downloads.cancel(item.downloadId);
    } catch { /* noop */ }
  }
  item.downloadId = null;
  item.lastError = String(reason || 'failed');

  const max = Number(settings.maxAttempts) || 8;
  if (item.attempts >= max) {
    item.status = 'failed';
    pushLog(q, 'error', `#${item.id} ${item.repo} 失败（已试 ${item.attempts} 次）：${item.lastError}`);
  } else {
    item.status = 'pending';
    pushLog(q, 'warn', `#${item.id} ${item.repo} 第 ${item.attempts} 次失败（${item.lastError}），换源重试`);
  }
}

// ---------------------------------------------------------------- 手动操作

export async function retryItems(ids, { force = true } = {}) {
  const q = await loadQueue();
  const set = new Set(ids || []);
  let n = 0;
  for (const item of q.items) {
    if (!set.has(item.id)) continue;
    if (item.status === 'done' && !force) continue;
    item.status = 'pending';
    item.attempts = 0;
    item.lastError = '';
    item.downloadId = null;
    n += 1;
  }
  pushLog(q, 'info', `手动重试 ${n} 项`);
  await saveQueue(q);
  startTick();
  pump().catch(() => {});
  return n;
}

export async function cancelItems(ids) {
  const q = await loadQueue();
  const set = new Set(ids || []);
  for (const item of q.items) {
    if (!set.has(item.id)) continue;
    if (item.status === 'downloading' && item.downloadId) {
      try {
        await chrome.downloads.cancel(item.downloadId);
      } catch { /* noop */ }
    }
    item.status = 'canceled';
    item.downloadId = null;
    item.finishedAt = Date.now();
  }
  pushLog(q, 'info', `取消 ${set.size} 项`);
  await saveQueue(q);
  await refreshBadge();
  pump().catch(() => {});
}

export async function removeItems(ids) {
  const q = await loadQueue();
  const set = new Set(ids || []);
  q.items = q.items.filter((it) => !set.has(it.id));
  await saveQueue(q);
  await refreshBadge();
  return q.items.length;
}

export async function clearFinished() {
  const q = await loadQueue();
  q.items = q.items.filter((it) => !['done', 'failed', 'canceled'].includes(it.status));
  pushLog(q, 'info', '清空已完成/失败项');
  await saveQueue(q);
  await refreshBadge();
}

export async function clearAll() {
  const q = await loadQueue();
  for (const item of q.items) {
    if (item.status === 'downloading' && item.downloadId) {
      try {
        await chrome.downloads.cancel(item.downloadId);
      } catch { /* noop */ }
    }
  }
  await saveQueue({ items: [], seq: 1, log: [] });
  await refreshBadge();
  stopTick();
}

// ---------------------------------------------------------------- 展示辅助

export function summarize(q) {
  const by = (s) => q.items.filter((it) => it.status === s).length;
  return {
    pending: by('pending'),
    downloading: by('downloading'),
    done: by('done'),
    failed: by('failed'),
    canceled: by('canceled'),
    total: q.items.length
  };
}

export async function refreshBadge() {
  try {
    const q = await loadQueue();
    const s = summarize(q);
    const active = s.downloading + s.pending;
    await chrome.action.setBadgeText({ text: active ? String(active) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: s.failed ? '#d1242f' : '#1f883d' });
    await chrome.action.setTitle({
      text: `GitHub Zip XGrabber — 进行中 ${s.downloading} / 待下 ${s.pending} / 完成 ${s.done}${s.failed ? ` / 失败 ${s.failed}` : ''}`
    });
  } catch { /* 扩展重载瞬间可能不可用 */ }
}

async function maybeNotify(q, settings) {
  const s = summarize(q);
  if (s.pending || s.downloading) {
    q.notifiedAt = 0;
    return;
  }
  if (!settings.notify || !q.items.length) return;
  if (q.notifiedAt && Date.now() - q.notifiedAt < 60000) return;
  if (!s.done && !s.failed) return;
  q.notifiedAt = Date.now();
  await saveQueue(q);
  const body = `成功 ${s.done} 个${s.failed ? `，失败 ${s.failed} 个` : ''}，已按日期归档到「下载」文件夹`;
  try {
    await chrome.notifications.create('gzg-batch-done', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'GitHub Zip XGrabber 队列已跑完',
      message: body
    });
  } catch { /* 通知不可用时静默 */ }
}

function fmtSize(n) {
  if (!Number.isFinite(n)) return '?';
  if (n > 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n > 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// ---------------------------------------------------------------- 看门狗

export function startTick() {
  chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
}

export function stopTick() {
  chrome.alarms.clear(TICK_ALARM).catch?.(() => {});
}

export async function onTick() {
  const q = await loadQueue();
  const busy = q.items.some((it) => ['pending', 'downloading'].includes(it.status));
  if (!busy) {
    stopTick();
    await refreshBadge();
    return;
  }
  await pump();
}

export async function getSnapshot() {
  const q = await loadQueue();
  return { items: q.items, log: q.log || [], summary: summarize(q) };
}
