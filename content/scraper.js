// 搜索结果抓取器（content script 世界的共享模块）。
//
// 为什么单独成文件：content script 不能用 import，但 manifest 的 js 数组里的多个文件
// 跑在同一个 isolated world，所以 detector.js 直接用这里的 window.__GZG_SCRAPE。
// 同时它也是可离线测试的：测试里把真实页面快照塞进 fixture，用 addScriptTag 加载本文件，
// 直接调 __GZG_SCRAPE.scrape(root) 断言结果，不依赖 github.com 可达。
//
// 为什么不能靠类名（血泪）：GitHub 的 CSS module 类名带构建哈希，且前缀本身会变。
// 实测 2026-10-10 当天，卡片类名从 Result-module__Result__I0WVD 变成 Result__Of4h7n，
// 依赖 [class*="Result-module__"] 的实现当场从「抓到 10 个」退化成「抓到 1 个」。
// 因此这里只信三类稳定锚点：data-testid、语义化 href（/stargazers 等）、以及仓库标题链接本身。
(function (global) {
  'use strict';

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
  // 只收「出现在仓库名位置上也不可能是真仓库」的词；issues/releases 这类子页名刻意不收，
  // 否则名为 releases 的真仓库会被漏判。
  const RESERVED_SECOND = new Set(['login', 'logout', 'join', 'new', 'topics', 'features', 'collections']);

  const REPO_HREF = /^\/([^/]+)\/([^/]+)\/?$/;

  function parseCount(text) {
    const s = String(text || '').replace(/[,\s']/g, '');
    const m = s.match(/([\d.]+)\s*([kmb])?/i);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return 0;
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
    return Math.round(n * mult);
  }

  function countFrom(container, suffix) {
    const a = container.querySelector(`a[href$="${suffix}"]`);
    if (!a) return 0;
    const label = a.getAttribute('aria-label') || '';
    const fromLabel = label.match(/([\d.,]+\s*k?)/i);
    return parseCount((fromLabel && fromLabel[0]) || a.textContent);
  }

  function isRepoHref(href) {
    const m = REPO_HREF.exec(href || '');
    if (!m) return null;
    const owner = decodeURIComponent(m[1]);
    const repo = decodeURIComponent(m[2]);
    if (!owner || !repo || RESERVED_TOP.has(owner.toLowerCase())) return null;
    if (RESERVED_SECOND.has(repo.toLowerCase())) return null;
    return { owner, repo };
  }

  /** 节点内出现的不同仓库键（>1 说明已经吞掉邻居卡片）；提前短路避免全量扫描 */
  function repoKeys(node) {
    const set = new Set();
    for (const a of node.querySelectorAll('a[href^="/"]')) {
      const hit = isRepoHref(a.getAttribute('href'));
      if (hit) set.add(hit.owner.toLowerCase() + '/' + hit.repo.toLowerCase());
      if (set.size > 1) return set;
    }
    return set;
  }

  /**
   * 卡片边界 = 仍然只包含这一个仓库的最高祖先。
   * 不用「第一个含元数据的祖先」那种写法：实测那样会停在只装着标题+star 的窄壳上，
   * 把描述和 Updated 时间留在外面（真实页面上表现为 desc/updated 全空）。
   */
  function cardFor(link, root) {
    let node = link.parentElement;
    let best = node;
    for (let depth = 0; node && node !== root && depth < 9; depth += 1) {
      if (repoKeys(node).size > 1) break;
      best = node;
      node = node.parentElement;
    }
    return best || root;
  }

  const DESC_SELECTORS = '[data-testid="results-item-desc"], [class*="Content-module"], [class*="Content__"], [class*="content__"], [class*="description"]';
  const NOISE = /Updated|\d{4}-\d{2}-\d{2}|^\s*(star|fork)\b/i;

  function cleanText(txt) {
    return String(txt || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * 描述。先按已知容器找；找不到就走结构兜底——从标题往上逐级看「下一个兄弟节点」，
   * 取第一个有正文、且不含 Updated/星数噪声的块。
   * 不能简单用 <p> 或最长文本兜底：实测那样会把整张卡片（含标题、语言、"Updated 3 days ago"）
   * 当成描述抓回来。
   */
  function readDesc(card, titleLink) {
    const direct = cleanText((card.querySelector(DESC_SELECTORS) || {}).textContent);
    if (direct.length >= 8 && !NOISE.test(direct)) return direct.slice(0, 220);

    const titleText = cleanText(titleLink.textContent);
    let node = titleLink;
    for (let depth = 0; node && node !== card && depth < 8; depth += 1) {
      node = node.parentElement;
      if (!node) break;
      let sib = node.nextElementSibling;
      while (sib) {
        const txt = cleanText(sib.textContent);
        if (txt.length >= 8 && !NOISE.test(txt) && !txt.includes(titleText)) return txt.slice(0, 220);
        sib = sib.nextElementSibling;
      }
    }
    return '';
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  function iso(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /**
   * 把 GitHub 三种时间写法统一成可排序的 YYYY-MM-DD：
   *   title="Oct 19, 2026, 3:10 PM UTC" / datetime="2026-10-19T..."  → 精确
   *   "on Aug 5"（无年份）                                            → 按今年补，落在未来就归到去年
   *   "3 days ago"（客户端渲染后 SSR 的 title 没了，只剩这个）        → 按天近似
   */
  function normalizeUpdated(raw, now) {
    const text = cleanText(raw).replace(/^on\s+/i, '');
    if (!text) return '';
    // 只有字符串自带年份时才信 Date.parse：实测 Date.parse('on Aug 5') 会被 V8 宽松解析成
    // 2001-08-05，把"今年 8 月 5 日"悄悄改成二十多年前，排序就全错了
    if (/\b(?:19|20)\d{2}\b/.test(text)) {
      const ms = Date.parse(raw);
      if (Number.isFinite(ms)) return iso(new Date(ms));
    }

    const ago = text.match(/^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i);
    if (ago) {
      const n = parseInt(ago[1], 10);
      const unit = ago[2].toLowerCase();
      const mins = { minute: 1, hour: 60, day: 1440, week: 10080, month: 43200, year: 525600 }[unit] || 0;
      return iso(new Date(now.getTime() - n * mins * 60000));
    }
    const md = text.match(/^([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:,?\s+(\d{4}))?/);
    if (md) {
      const month = MONTHS[md[1].slice(0, 3).toLowerCase()];
      if (month) {
        const day = parseInt(md[2], 10);
        let year = md[3] ? parseInt(md[3], 10) : now.getFullYear();
        const guess = new Date(year, month - 1, day);
        if (!md[3] && guess.getTime() > now.getTime() + 86400000) guess.setFullYear(--year);
        return iso(guess);
      }
    }
    return '';
  }

  /** 更新时间：四级锚点，SSR 与客户端渲染都能覆盖 */
  function readUpdated(card, now) {
    const rt = card.querySelector('relative-time[datetime], time[datetime]');
    if (rt) {
      const v = normalizeUpdated(rt.getAttribute('datetime'), now);
      if (v) return v;
    }
    const li = [...card.querySelectorAll('li, [class*="footerItem"], span, div')]
      .find((el) => /^Updated\b/.test(cleanText(el.textContent)) && cleanText(el.textContent).length < 120);
    const titled = li && li.querySelector('[title]');
    const candidates = [
      titled && titled.getAttribute('title'),
      li && cleanText(li.textContent).replace(/^Updated\s*/i, ''),
      (() => {
        const any = [...card.querySelectorAll('[title]')]
          .find((el) => /(?:19|20)\d{2}|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(el.getAttribute('title') || ''));
        return any && any.getAttribute('title');
      })(),
      (cleanText(card.textContent).match(/Updated\s+((?:on\s+)?[A-Za-z]{3}[a-z]*\s+\d{1,2}[^\s,]*(?:,\s*\d{4})?|\d+\s+(?:minute|hour|day|week|month|year)s?\s+ago|\d{4}-\d{2}-\d{2})/i) || [])[1]
    ];
    for (const cand of candidates) {
      const v = normalizeUpdated(cand, now);
      if (v) return v;
    }
    return '';
  }

  /**
   * 抓取一个搜索结果列表容器里的仓库。
   * @param {Element} root 列表容器（通常是 [data-testid="results-list"]）
   * @returns {Array<{owner,repo,url,stars,forks,lang,desc,updated}>}
   */
  function scrape(root, now) {
    if (!root) return [];
    const at = now instanceof Date ? now : new Date();
    const out = [];
    const seen = new Set();
    // 锚点 = 仓库标题链接，而不是任何类名。顺序即页面顺序。
    const links = [...root.querySelectorAll('a[href^="/"]')];
    for (const link of links) {
      const hit = isRepoHref(link.getAttribute('href'));
      if (!hit) continue;
      const key = `${hit.owner}/${hit.repo}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const card = cardFor(link, root);
      const langEl = card.querySelector('[aria-label$=" language"]');
      out.push({
        owner: hit.owner,
        repo: hit.repo,
        key,
        url: `https://github.com/${hit.owner}/${hit.repo}`,
        stars: countFrom(card, '/stargazers'),
        forks: countFrom(card, '/forks'),
        lang: langEl ? (langEl.textContent || '').trim() : '',
        desc: readDesc(card, link),
        updated: readUpdated(card, at)
      });
    }
    return out;
  }

  function findListRoot(doc) {
    const direct = doc.querySelector('[data-testid="results-list"]');
    if (direct) return direct;
    // 连 data-testid 都没了时的兜底：从第一个 star 链接往上找「同时装着 ≥2 个 star 链接」
    // 的最小祖先，即列表本身。取最小而不是最大，避免把导航里的其它 /owner/repo 链接卷进来。
    const first = doc.querySelector('a[href$="/stargazers"]');
    if (!first) return null;
    let node = first.parentElement;
    for (let depth = 0; node && depth < 10; depth += 1) {
      if (node.querySelectorAll('a[href$="/stargazers"]').length >= 2) return node;
      node = node.parentElement;
    }
    return first.parentElement;
  }

  function searchTotalCount(doc) {
    const el = doc.querySelector('[data-testid="resolved-count-label"]');
    if (!el) return null;
    return parseCount(el.textContent) || null;
  }

  global.__GZG_SCRAPE = {
    scrape,
    findListRoot,
    searchTotalCount,
    parseCount,
    isRepoHref,
    normalizeUpdated,
    RESERVED_TOP,
    RESERVED_SECOND
  };
})(typeof window !== 'undefined' ? window : globalThis);
