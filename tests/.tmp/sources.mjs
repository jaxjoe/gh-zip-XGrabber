// 下载源（直连 + 镜像）建模与择优。
//
// 关键前提（均在本机 2026-10 实测）：
//   1. github.com/{o}/{r}/archive/HEAD.zip 会自动解析默认分支，无需查 API、不占 60 次/小时配额；
//      写死 refs/heads/master 在默认分支为 main 的仓库上必挂，反之亦然。
//   2. codeload 与镜像都忽略 Range 请求（要 0-500000 会回整包），所以断点续传不可用，
//      失败只能整包重下 —— 队列按「换源重试」而非「续传」设计。
//   3. 镜像正常时返回真 zip（Content-Type: application/zip，PK\u03\x04 开头），
//      仓库不存在时老实返回 404 + text/plain，因此校验只需状态/MIME/体积。

export const BUILTIN_SOURCES = [
  {
    id: 'direct',
    label: 'GitHub 直连',
    host: 'github.com',
    template: 'https://github.com/{o}/{r}/archive/{ref}.zip'
  },
  {
    id: 'gh-proxy.com',
    label: 'gh-proxy.com',
    host: 'gh-proxy.com',
    template: 'https://gh-proxy.com/https://github.com/{o}/{r}/archive/{ref}.zip'
  },
  {
    id: 'ghfast.top',
    label: 'ghfast.top',
    host: 'ghfast.top',
    template: 'https://ghfast.top/https://github.com/{o}/{r}/archive/{ref}.zip'
  },
  {
    id: 'ghproxy.net',
    label: 'ghproxy.net',
    host: 'ghproxy.net',
    template: 'https://ghproxy.net/https://github.com/{o}/{r}/archive/{ref}.zip'
  }
];

export const BAD_SOURCE_PENALTY_MS = 5 * 60 * 1000; // 失败源冷却 5 分钟

export function canonicalArchiveUrl(owner, repo, refPath) {
  return `https://github.com/${owner}/${repo}/archive/${refPath}.zip`;
}

function enc(seg) {
  return encodeURIComponent(seg).replace(/%2F/g, '/');
}

/**
 * 用户填的 ref 可能是分支 / 标签 / commit / 留空。
 * 返回一组候选路径，按可能性排序；绝不静默降级到默认分支，避免下错内容。
 */
export function refVariants(ref) {
  const r = String(ref || '').trim();
  if (!r || r === 'HEAD') return ['HEAD'];
  if (r.startsWith('refs/')) return [enc(r)];
  if (/^[0-9a-f]{7,40}$/i.test(r)) return [r];
  const one = enc(r);
  return [`refs/heads/${one}`, `refs/tags/${one}`, one];
}

/** 把设置里的镜像配置展开成候选源数组（保持用户声明顺序） */
export function listSources(settings) {
  const custom = Array.isArray(settings.customMirrors) ? settings.customMirrors : [];
  const all = new Map();
  for (const s of BUILTIN_SOURCES) all.set(s.id, { ...s, builtin: true });
  for (const s of custom) {
    if (!s || !s.id || !s.template) continue;
    all.set(s.id, {
      id: s.id,
      label: s.label || s.id,
      template: s.template,
      host: safeHost(s.template) || s.id,
      builtin: false
    });
  }
  const disabled = new Set(settings.disabled || []);
  const order = Array.isArray(settings.mirrorOrder) && settings.mirrorOrder.length
    ? settings.mirrorOrder.filter((id) => all.has(id))
    : [];
  const rest = [...all.keys()].filter((id) => !order.includes(id));
  return [...order, ...rest].map((id) => ({ ...all.get(id), enabled: !disabled.has(id) }));
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function buildSourceUrl(source, owner, repo, refPath) {
  const full = canonicalArchiveUrl(owner, repo, refPath);
  const map = { url: full, o: encodeURIComponent(owner), r: encodeURIComponent(repo), ref: refPath };
  // 用 replace(/g) 而不是 replaceAll，兼容更老的 JS 引擎（测试环境是 node 14）
  return String(source.template).replace(/\{(url|o|r|ref)\}/g, (_, k) => map[k]);
}

/**
 * 择优排序：健康且历史速度高的在前；从未测过的源给一个乐观值，保证有机会被试到；
 * 冷却中的失败源沉到队尾（而不是剔除，全部冷却时仍能硬试）。
 */
export function rankSources(sources, health, now = Date.now()) {
  const usable = sources.filter((s) => s.enabled);
  const measured = usable
    .map((s) => health?.[s.id]?.bps || 0)
    .filter((v) => v > 0);
  const ceiling = measured.length ? Math.max(...measured) : 0;

  return usable
    .map((s, idx) => {
      const h = health?.[s.id] || {};
      const cooled = h.badUntil && h.badUntil > now;
      const score = h.bps > 0 ? h.bps : ceiling * 1.15;
      return { source: s, cooled, score, idx };
    })
    .sort((a, b) => {
      if (a.cooled !== b.cooled) return a.cooled ? 1 : -1;
      if (b.score !== a.score) return b.score - a.score;
      return a.idx - b.idx;
    })
    .map((e) => e.source);
}

/**
 * 第 n 次尝试用哪个源、哪个 ref 路径。
 * 先穷尽所有源（同一 ref 换源），再换 ref 写法，保证不会把「分支名写错」误判成「网络不通」。
 */
export function attemptPlan(settings, health, item, now = Date.now()) {
  const sources = rankSources(listSources(settings), health, now);
  const refs = refVariants(item.ref);
  const plan = [];
  for (const r of refs) {
    for (const s of sources) plan.push({ source: s, refPath: r });
  }
  return plan;
}
