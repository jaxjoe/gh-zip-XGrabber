// GitHub Zip XGrabber — MV3 service worker 入口
// 只做三件事：注册事件、路由消息、把耗时动作交给 lib/queue.js。

import { parseGitHubUrl } from './lib/naming.js';
import {
  loadSettings, saveSettings, loadHealth, saveHealth,
  putSearchResults, loadSearchStore, clearSearchResults
} from './lib/store.js';
import { listSources, rankSources, buildSourceUrl } from './lib/sources.js';
import { verdict } from './lib/verify.js';
import * as Q from './lib/queue.js';

Q.refreshBadge().catch(() => {});

// ---------------------------------------------------------------- 生命周期

chrome.runtime.onInstalled.addListener(async () => {
  await loadSettings(); // 触发一次读取，保证有默认值
  try {
    await chrome.sidePanel.setOptions({ path: 'sidepanel/sidepanel.html', enabled: true });
  } catch { /* Edge 某些版本无该接口，回退为标签页打开 */ }
});

chrome.runtime.onStartup.addListener(() => {
  Q.getSnapshot().then((snap) => {
    if (snap.items.some((it) => ['pending', 'downloading'].includes(it.status))) {
      Q.startTick();
      Q.pump().catch(() => {});
    }
  });
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'gzg-tick') Q.onTick().catch(() => {});
});

chrome.downloads.onChanged.addListener((delta) => {
  Q.handleDelta(delta).catch(() => {});
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (typeof tab?.id === 'number') await chrome.sidePanel.open({ tabId: tab.id });
    else await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch {
    chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html') });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'download-current-repo') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  // 优先把信号回灌给页面：让快捷键与点击走同一段代码，
  // 提示文案（已入队 / 跳过：已下载过 / 失败）与按钮效果保持一致
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'GZG_HOTKEY' });
    if (r?.ok) return;
  } catch { /* 内容脚本不在（非 GitHub 页 / 刚被禁用），走下面的兜底 */ }

  const info = parseGitHubUrl(tab.url || '');
  if (info.kind !== 'repo') {
    notify('GitHub Zip XGrabber', '当前页面不是仓库页，快捷键未触发下载');
    return;
  }
  const res = await Q.enqueue([{ owner: info.owner, repo: info.repo, ref: info.branch }], { origin: 'shortcut' });
  const text = res.added?.length
    ? `已入队 ${info.owner}/${info.repo}（${info.branch}）`
    : (res.skipped?.length ? `跳过：${res.skipped[0].reason}` : '入队失败');
  notify('GitHub Zip XGrabber', text);
});

function notify(title, message) {
  chrome.notifications.create('gzg-hotkey-' + Date.now(), {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message
  }).catch(() => {});
}

// ---------------------------------------------------------------- 消息路由

const SPEED_TEST_URL_REPO = { owner: 'octocat', repo: 'Hello-World', ref: 'HEAD' };

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('GZG_')) return false;

  (async () => {
    try {
      switch (msg.type) {
        case 'GZG_PING':
          return { ok: true, ts: Date.now() };

        case 'GZG_ENQUEUE': {
          const r = await Q.enqueue(msg.repos || [], {
            origin: msg.origin || 'manual',
            force: !!msg.force
          });
          broadcast('GZG_CHANGED');
          return { ok: true, ...r };
        }

        case 'GZG_PAGE_INFO': {
          const info = parseGitHubUrl(msg.url || sender.tab?.url || '');
          return { ok: true, info };
        }

        case 'GZG_SNAPSHOT': {
          const [items, settings, health] = await Promise.all([
            Q.getSnapshot(),
            loadSettings(),
            loadHealth()
          ]);
          const all = listSources(settings);
          const ranked = rankSources(all, health);
          // 设置页要能看到被停用的源（否则取消勾选后它就消失了，再也勾不回来）
          const sources = [...ranked, ...all.filter((s) => !s.enabled)];
          return { ok: true, ...items, settings, health, sources };
        }

        case 'GZG_SEARCH_SAVE': {
          const tabId = msg.tabId ?? sender.tab?.id;
          if (typeof tabId === 'number') {
            await putSearchResults(tabId, {
              url: msg.url,
              items: msg.items || [],
              query: msg.query || '',
              page: msg.page || 1
            });
            broadcast('GZG_SEARCH_UPDATED', { tabId });
          }
          return { ok: true };
        }

        case 'GZG_SEARCH_LIST': {
          const store = await loadSearchStore();
          return { ok: true, store };
        }

        case 'GZG_SEARCH_CLEAR':
          // all=true 或 tabId 缺失时整库清空；否则只清指定标签页的收集桶
          await clearSearchResults(msg.all ? null : msg.tabId);
          broadcast('GZG_SEARCH_UPDATED', { tabId: msg.tabId });
          return { ok: true };

        case 'GZG_SETTINGS_SAVE': {
          const next = await saveSettings(msg.patch || {});
          broadcast('GZG_CHANGED');
          return { ok: true, settings: next };
        }

        case 'GZG_RETRY':
          await Q.retryItems(msg.ids);
          broadcast('GZG_CHANGED');
          return { ok: true };

        case 'GZG_CANCEL':
          await Q.cancelItems(msg.ids);
          broadcast('GZG_CHANGED');
          return { ok: true };

        case 'GZG_REMOVE':
          await Q.removeItems(msg.ids);
          broadcast('GZG_CHANGED');
          return { ok: true };

        case 'GZG_CLEAR_FINISHED':
          await Q.clearFinished();
          broadcast('GZG_CHANGED');
          return { ok: true };

        case 'GZG_CLEAR_ALL':
          await Q.clearAll();
          broadcast('GZG_CHANGED');
          return { ok: true };

        case 'GZG_OPEN_SIDE_PANEL': {
          const tabId = msg.tabId ?? sender.tab?.id;
          try {
            if (typeof tabId === 'number') {
              await chrome.sidePanel.open({ tabId });
            } else {
              await chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
            }
          } catch {
            chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html') });
          }
          return { ok: true };
        }

        case 'GZG_SHORTCUTS': {
          // 用户在 edge://extensions/shortcuts 改过绑定，UI 必须显示实际生效的那个，
          // 不能把 manifest 里的建议值写死在界面上
          const cmds = await chrome.commands.getAll();
          const map = {};
          for (const c of cmds || []) {
            if (c.name) map[c.name] = c.shortcut || '';
          }
          return { ok: true, shortcuts: map };
        }

        case 'GZG_SHOW_FILE': {
          if (msg.downloadId) {
            try {
              await chrome.downloads.show(msg.downloadId);
            } catch { /* 文件可能已被移走 */ }
          }
          return { ok: true };
        }

        case 'GZG_SPEED_TEST':
          return await runSpeedTest(msg.ids);

        default:
          return { ok: false, error: `未知消息 ${msg.type}` };
      }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  })().then(respond, (err) => respond({ ok: false, error: String(err?.message || err) }));

  return true; // 异步响应
});

function broadcast(type, payload) {
  chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
}

/**
 * 真实测速：用一个小仓库（octocat/Hello-World，约 0.5 KB）逐个源走一遍 chrome.downloads。
 * 不引 fetch，所以不需要为镜像额外申请 host 权限；测完即删除临时文件。
 */
async function runSpeedTest(onlyIds) {
  const settings = await loadSettings();
  const health = await loadHealth();
  const sources = listSources(settings).filter((s) => s.enabled);
  const targets = onlyIds?.length ? sources.filter((s) => onlyIds.includes(s.id)) : sources;
  const results = [];

  for (const source of targets) {
    const url = buildSourceUrl(source, SPEED_TEST_URL_REPO.owner, SPEED_TEST_URL_REPO.repo, 'HEAD');
    const started = Date.now();
    try {
      const id = await chrome.downloads.download({
        url,
        filename: `__gzg_speedtest_${Date.now()}.zip`,
        saveAs: false,
        conflictAction: 'uniquify'
      });
      const item = await waitForDownload(id, 20000);
      const secs = Math.max(0.15, (Date.now() - started) / 1000);
      const size = item.fileSize || item.totalBytes || 0;
      const bps = Math.round(size / secs);
      const good = verdict({ size, mime: item.mime || '', minBytes: 22, state: item.state }).ok;
      if (!good) item.error = item.error || verdict({ size, mime: item.mime || '', minBytes: 22, state: item.state }).reason;
      const h = (health[source.id] = health[source.id] || { ok: 0, fail: 0, bps: 0, badUntil: 0 });
      if (good) {
        h.bps = bps;
        h.badUntil = 0;
      } else {
        h.fail += 1;
        h.badUntil = Date.now() + 5 * 60 * 1000;
      }
      results.push({ id: source.id, label: source.label, ok: good, bps, ms: Math.round(secs * 1000), error: good ? '' : item.error || item.state || '响应异常' });
      try {
        await chrome.downloads.removeFile(id);
      } catch { /* noop */ }
      try {
        await chrome.downloads.erase({ id });
      } catch { /* noop */ }
    } catch (err) {
      results.push({ id: source.id, label: source.label, ok: false, bps: 0, ms: 0, error: String(err?.message || err) });
    }
    await saveHealth(health);
  }

  results.sort((a, b) => (b.ok - a.ok) || (b.bps - a.bps));
  broadcast('GZG_CHANGED');
  return { ok: true, results };
}

function waitForDownload(id, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      chrome.downloads.cancel(id).catch(() => {});
      resolve({ state: 'interrupted', error: '测速超时', fileSize: 0, mime: '' });
    }, timeoutMs);

    async function listener(delta) {
      if (delta.id !== id) return;
      const st = delta.state?.current;
      if (st && st !== 'in_progress') {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(listener);
        const [item] = await chrome.downloads.search({ id }).catch(() => [null]);
        resolve(item ? { ...item, error: delta.error?.current || item.error || '' } : { state: st, error: '', fileSize: 0, mime: '' });
      }
    }
    chrome.downloads.onChanged.addListener(listener);
  });
}

Q.refreshBadgePublic?.();
