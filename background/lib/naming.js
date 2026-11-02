// 纯函数工具：URL 解析、文件命名、数字格式化
// content script 与 background 共用同一套语义，但 content script 是 classic script，
// 所以这里导出的函数在 detector.js 里有一份等价的内联副本（改动需同步）。

const RESERVED_TOP = new Set([
  'about', 'account', 'accounts', 'apps', 'blog', 'charts', 'checkout', 'codespaces',
  'collections', 'contact', 'contributions', 'customer', 'discussions', 'docs', 'download',
  'education', 'enterprise', 'events', 'features', 'gallery', 'gh-cli', 'git', 'github-latest',
  'hello-world', 'install', 'join', 'joins', 'landing', 'language', 'learn', 'links', 'login',
  'logout', 'marketplace', 'mobile', 'new', 'nonprofits', 'notifications', 'orgs', 'pages',
  'privacy', 'products', 'programs', 'readmemode', 'resources', 'roadmap', 'samples', 'search',
  'security', 'server', 'services', 'settings', 'showcases', 'signup', 'site', 'sponsors',
  'staff', 'status', 'support', 'terms', 'topics', 'tours', 'trainings', 'weekly', 'welcome', 'why-github'
]);

// 只列「出现在仓库名位置上也不可能是真仓库」的保留字。
// 刻意不收 issues / releases / settings 这类子页名：它们在 /owner/repo/xxx 里是子页面，
// 但 /owner/releases 完全可能是真仓库，误判会让控制条整条消失（漏报比误报更难受）。
const RESERVED_SECOND = new Set(['login', 'logout', 'join', 'new', 'topics', 'features', 'collections']);

/**
 * 解析 github.com 路径。
 * @returns {{kind:'repo'|'search'|'other', owner?:string, repo?:string, branch?:string, page?:number, query?:string, type?:string}}
 */
export function parseGitHubUrl(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return { kind: 'other' };
  }
  if (u.hostname !== 'github.com') return { kind: 'other' };

  const seg = decodeURIComponent(u.pathname).split('/').filter(Boolean);

  if (seg[0] === 'search') {
    const type = u.searchParams.get('type') || 'repositories';
    let page = parseInt(u.searchParams.get('p') || '1', 10);
    if (!Number.isFinite(page) || page < 1) page = 1;
    return {
      kind: 'search',
      query: u.searchParams.get('q') || '',
      type,
      page
    };
  }

  if (seg.length >= 2 && !RESERVED_TOP.has(seg[0]) && !RESERVED_SECOND.has(seg[1])) {
    // /owner/repo 或 /owner/repo/tree/<branch>/... 或 /owner/repo/releases 等子页
    let branch = '';
    if (seg.length >= 4 && (seg[2] === 'tree' || seg[2] === 'archive')) {
      // /owner/repo/tree/main/src/a.ts -> main/src/a.ts，取不到干净分支名时退回 HEAD
      const rest = seg.slice(3).join('/');
      branch = /^[^/]+$/.test(rest) ? rest : '';
    }
    return {
      kind: 'repo',
      owner: seg[0],
      repo: seg[1],
      branch: branch || 'HEAD',
      sub: seg.slice(2).join('/')
    };
  }

  return { kind: 'other' };
}

/** Windows / Chromium 都禁止的文件名字符，一次性替换成下划线；顺带消灭任何 '..'，杜绝目录穿越 */
export function sanitize(name, max = 80) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '_')
    .trim()
    .slice(0, max);
}

/** 允许用户写 code/github 这种嵌套总目录：先丢掉 . 与 .. 段，再逐段清洗 */
export function sanitizeFolders(value, max = 60) {
  return String(value || '')
    .split(/[\\/]+/)
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .map((seg) => sanitize(seg, max))
    .filter((seg) => seg && seg !== '.')
    .join('/');
}

/** 本地日期，不用 toISOString（UTC 会让晚上 8 点后归档到明天） */
export function dateFolder(style, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const map = {
    'YYYY-MM-DD': `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`,
    YYYYMMDD: `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`,
    'YYYY-MM': `${now.getFullYear()}-${p(now.getMonth() + 1)}`,
    none: ''
  };
  // 注意：'none' 的值是空串，用 || 兜底会被当成 falsy 而错误退回默认格式
  return Object.prototype.hasOwnProperty.call(map, style) ? map[style] : map['YYYY-MM-DD'];
}

/**
 * 相对「下载目录」的路径。chrome.downloads 的 filename 支持相对子路径并自动建目录，
 * 但不允许绝对路径与 .. —— 这里强制清洗成安全的相对路径。
 * 例：github/2026-10-10/alchaincyf__huashu-design__master.zip
 */
export function buildFilename({ owner, repo, branch = 'HEAD', ref = '', settings, now }) {
  const parts = [];
  const root = sanitizeFolders(settings?.rootFolder ?? 'github');
  if (root) parts.push(root);
  const day = dateFolder(settings?.dateStyle ?? 'YYYY-MM-DD', now);
  if (day) parts.push(day);

  let label = branch;
  if (ref && ref !== 'HEAD' && ref !== branch) label = ref;
  const base = [sanitize(owner), sanitize(repo), sanitize(label || 'HEAD')]
    .filter(Boolean)
    .join('__');
  parts.push(`${base}.zip`);
  return parts.join('/');
}

/** 仓库在队列/去重表里的唯一键 */
export function itemKey({ owner, repo, ref }) {
  return `${owner}/${repo}@${ref || 'HEAD'}`.toLowerCase();
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatBps(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '—';
  return `${formatBytes(bytesPerSec)}/s`;
}

/** "1.2k" / "12,345" / "1'234" -> 1200 / 12345 */
export function parseCount(text) {
  const s = String(text || '').replace(/[,\s'’]/g, '');
  const m = s.match(/([\d.]+)\s*([kmb])?/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(n * mult);
}
