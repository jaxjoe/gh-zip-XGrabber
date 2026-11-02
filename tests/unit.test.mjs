// 纯函数回归测试。node 14 不能直接 import .js 作为 ESM，
// 所以由 run.sh 先把被测文件复制成 .mjs。跑法：bash tests/run.sh
import assert from 'assert';
import { parseGitHubUrl, buildFilename, sanitize, sanitizeFolders, parseCount, dateFolder, itemKey } from './.tmp/naming.mjs';
import { refVariants, listSources, rankSources, buildSourceUrl, attemptPlan } from './.tmp/sources.mjs';

let n = 0;
const eq = (...a) => { assert.deepEqual(...a); n += 1; };
const ok = (...a) => { assert.ok(...a); n += 1; };

// ---- 页面识别
const repo = parseGitHubUrl('https://github.com/alchaincyf/huashu-design');
eq(repo.kind, 'repo'); eq(repo.owner, 'alchaincyf'); eq(repo.repo, 'huashu-design'); eq(repo.branch, 'HEAD');
eq(parseGitHubUrl('https://github.com/a/b/tree/main/src').branch, 'HEAD', '多段 tree 路径无法确定分支名时必须退回 HEAD');
eq(parseGitHubUrl('https://github.com/a/b/tree/dev').branch, 'dev');
const sub = parseGitHubUrl('https://github.com/a/b/issues/12');
eq([sub.kind, sub.owner, sub.repo], ['repo', 'a', 'b'], '仓库子页面仍属仓库上下文');
const srch = parseGitHubUrl('https://github.com/search?q=%E5%8A%A8%E7%94%BBskill&type=repositories&p=2');
eq([srch.kind, srch.query, srch.page], ['search', '动画skill', 2]);
eq(parseGitHubUrl('https://github.com/alchaincyf').kind, 'other', '个人页不是仓库页');
eq(parseGitHubUrl('https://github.com/settings/profile').kind, 'other', '站点级路径不能误判成 owner');
eq(parseGitHubUrl('https://github.com/orgs/rails/projects').kind, 'other');
eq(parseGitHubUrl('https://github.com/topics/python').kind, 'other');
eq(parseGitHubUrl('https://gist.github.com/x/y').kind, 'other');

// ---- 归档命名
const now = new Date(2026, 9, 10, 20, 30, 0);
const s = { rootFolder: 'github', dateStyle: 'YYYY-MM-DD' };
eq(buildFilename({ owner: 'alchaincyf', repo: 'huashu-design', ref: 'HEAD', settings: s, now }),
  'github/2026-10-10/alchaincyf__huashu-design__HEAD.zip');
eq(dateFolder('YYYY-MM-DD', now), '2026-10-10', '必须用本地日期而非 UTC（晚上 8 点后会跨天）');
eq(dateFolder('none', now), '', '不分日期必须是真空串，不能被 falsy 兜底成默认格式');
eq(dateFolder('YYYYMMDD', now), '20261010');
eq(dateFolder('乱填', now), '2026-10-10', '未知格式退回默认');
eq(buildFilename({ owner: 'a', repo: 'b', ref: 'HEAD', settings: { rootFolder: '', dateStyle: 'none' }, now }), 'a__b__HEAD.zip');
eq(sanitize('we/ird:*?"<>|name'), 'we_ird' + '_'.repeat(7) + 'name');
eq(buildFilename({ owner: '../evil', repo: 'x', ref: 'HEAD', settings: s, now }).includes('..'), false, 'owner 目录穿越必须被清洗');
eq(buildFilename({ owner: 'a', repo: 'b', ref: 'HEAD', settings: { rootFolder: '../../secret', dateStyle: 'YYYY-MM-DD' }, now }).includes('..'), false, '总子目录也要清洗');
eq(sanitizeFolders('..\\..\\secret'), 'secret', '穿越段整段丢弃');
eq(sanitizeFolders('code/github'), 'code/github', '允许嵌套总目录');
eq(sanitizeFolders('a/../b'), 'a/b', '中间的空段与穿越段都被吃掉');
eq(buildFilename({ owner: 'a', repo: 'b', ref: 'refs/heads/feature/x', settings: s, now }),
  'github/2026-10-10/a__b__refs_heads_feature_x.zip', 'ref 里的斜杠必须替换');
eq(itemKey({ owner: 'A', repo: 'B', ref: 'HEAD' }), 'a/b@head');

// ---- ref 候选：绝不静默降级到默认分支，避免下错内容
eq(refVariants('HEAD'), ['HEAD']);
eq(refVariants(''), ['HEAD']);
eq(refVariants('v1.2.3'), ['refs/heads/v1.2.3', 'refs/tags/v1.2.3', 'v1.2.3']);
eq(refVariants('feature/x'), ['refs/heads/feature/x', 'refs/tags/feature/x', 'feature/x']);
eq(refVariants('abc1234'), ['abc1234']);
eq(refVariants('refs/pull/9/merge'), ['refs/pull/9/merge']);

// ---- 数字解析
eq(parseCount('1.2k'), 1200);
eq(parseCount('39 stars'), 39);
eq(parseCount('12,345'), 12345);
eq(parseCount('—'), 0);

// ---- 源排序与降级
const settings = { ...s, mirrorOrder: ['direct', 'gh-proxy.com', 'ghfast.top'], disabled: ['ghfast.top'], customMirrors: [] };
eq(listSources(settings).map((x) => [x.id, x.enabled]),
  [['direct', true], ['gh-proxy.com', true], ['ghfast.top', false], ['ghproxy.net', true]]);
eq(rankSources(listSources(settings), {
  'gh-proxy.com': { bps: 6000000 },
  direct: { bps: 8000000, badUntil: Date.now() + 60000 },
  'ghproxy.net': { bps: 1 }
}).map((x) => x.id), ['gh-proxy.com', 'ghproxy.net', 'direct'], '高速 > 未测速 > 冷却中的失败源');
eq(buildSourceUrl(listSources(settings).find((x) => x.id === 'gh-proxy.com'), 'o', 'r', 'HEAD'),
  'https://gh-proxy.com/https://github.com/o/r/archive/HEAD.zip');
eq(buildSourceUrl({ id: 'mine', template: 'https://my.host/{url}' }, 'o', 'r', 'refs/heads/dev'),
  'https://my.host/https://github.com/o/r/archive/refs/heads/dev.zip');

const plan = attemptPlan({ ...s, mirrorOrder: ['direct', 'gh-proxy.com'], disabled: ['ghfast.top', 'ghproxy.net'] }, {}, { owner: 'o', repo: 'r', ref: 'v1' });
eq(plan.map((p) => [p.source.id, p.refPath]).slice(0, 4), [
  ['direct', 'refs/heads/v1'], ['gh-proxy.com', 'refs/heads/v1'],
  ['direct', 'refs/tags/v1'], ['gh-proxy.com', 'refs/tags/v1']], '先穷尽源再换 ref 写法');
eq(attemptPlan(settings, {}, { owner: 'o', repo: 'r', ref: 'HEAD' }).length, 3, 'HEAD 只有一种写法 × 3 个启用源');

// ---- 自定义镜像参与排序
const withCustom = { ...settings, customMirrors: [{ id: 'lab.host', label: '内网', template: 'https://lab.host/{url}' }], disabled: [] };
ok(listSources(withCustom).some((x) => x.id === 'lab.host' && !x.builtin));

// ---- 仓库名位置不再被当站点页（保留字收缩后的行为锁定）
eq(parseGitHubUrl('https://github.com/foo/releases').kind, 'repo', '名为 releases 的真仓库不该被漏判');
eq(parseGitHubUrl('https://github.com/github/features').kind, 'other');

// ---- 下载结果判定（在真实浏览器里很难稳定构造「200 但内容不是 zip」，所以规则单列单测）
import { verdict } from './.tmp/verify.mjs';
const V = (o) => verdict(o);
eq(V({ size: 487, mime: 'application/zip', minBytes: 64, state: 'complete' }).ok, true, '实测正规 zip 响应必须放行');
eq(V({ size: 31742609, mime: 'application/zip', minBytes: 64, state: 'complete' }).ok, true);
eq(V({ size: 200000, mime: 'application/x-zip-compressed', minBytes: 64, state: 'complete' }).ok, true, '个别内核用 x-zip-compressed');
eq(V({ size: 200000, mime: 'application/octet-stream', minBytes: 64, state: 'complete' }).ok, true);
eq(V({ size: 200000, mime: '', minBytes: 64, state: 'complete' }).ok, true, 'mime 缺失时不武断否决');
eq(V({ size: 9, mime: 'text/plain; charset=utf-8', minBytes: 64, state: 'complete' }).ok, false, '实测 gh 镜像 404 会回 9 字节 Not Found');
eq(V({ size: 300, mime: 'text/html', minBytes: 64, state: 'complete' }).ok, false, '200 + HTML 错误页必须拦');
eq(V({ size: 577, mime: 'application/json', minBytes: 64, state: 'complete' }).ok, false, '200 + JSON 冒充必须拦');
eq(V({ size: 5000, mime: 'text/html', minBytes: 64, state: 'complete' }).ok, false, '体积大也不能豁免 MIME 闸门');
eq(V({ size: 63, mime: 'application/zip', minBytes: 64, state: 'complete' }).ok, false, '体积下限边界');
eq(V({ size: 64, mime: 'application/zip', minBytes: 64, state: 'complete' }).ok, true, '体积下限边界内');
eq(V({ size: 1000, mime: 'application/zip', minBytes: 64, state: 'interrupted' }).ok, false, '未完成一律不算成功');
ok(V({ size: 300, mime: 'text/html', minBytes: 64, state: 'complete' }).reason.includes('Content-Type'), '拒绝理由要能被队列读出来');

// ---- 防漂移：background 与 content 世界的保留字集合必须完全一致
// （两份实现无法共享 import，content script 只能用 window.__GZG_SCRAPE 那份）
import fs from 'fs';
const readSet = (file, marker) => {
  const src = fs.readFileSync(file, 'utf8');
  const i = src.indexOf(marker);
  if (i < 0) throw new Error(`${file} 里找不到 ${marker}`);
  const body = src.slice(i, src.indexOf(']);', i));
  return new Set((body.match(/'[a-z0-9-]+'/g) || []).map((x) => x.replace(/'/g, '')));
};
for (const marker of ['const RESERVED_TOP = new Set([', 'const RESERVED_SECOND = new Set([']) {
  const a = readSet('background/lib/naming.js', marker);
  const b = readSet('content/scraper.js', marker);
  eq([...b].filter((x) => !a.has(x)).concat([...a].filter((x) => !b.has(x))), [], `${marker} 两份实现已漂移`);
}

// ---- 抓取器的链接判定（不依赖 DOM 的部分）
import { isRepoHref, normalizeUpdated } from './scraper-probe.mjs';
const NOW = new Date(2026, 9, 10, 12, 0, 0);   // 本地 2026-10-10 中午
const U = (raw) => normalizeUpdated(raw, NOW);
// GitHub 三种写法都要能变成可排序的 ISO 日期
eq(U('Oct 19, 2026, 3:10 PM UTC'), '2026-10-19', 'SSR 的 title 全格式');
eq(U('2026-10-19T08:00:00Z'), '2026-10-19', 'relative-time 的 datetime');
eq(U('3 days ago'), '2026-10-07', '客户端渲染后只剩相对时间');
eq(U('2 weeks ago'), '2026-09-26');
eq(U('on Aug 5'), '2026-08-05', '无年份的 on Mon D');
eq(U('Aug 5'), '2026-08-05');
eq(U('Dec 25'), '2025-12-25', '无年份且落在未来时归到去年');
eq(U('Jan 3, 2025'), '2025-01-03');
eq(U(''), '');
eq(U('yesterday'), '', '认不出的写法返回空，不能瞎猜');
eq(isRepoHref('/alchaincyf/huashu-design'), { owner: 'alchaincyf', repo: 'huashu-design' });
eq(isRepoHref('/a/b/'), { owner: 'a', repo: 'b' });
eq(isRepoHref('/a/b/c'), null, '三段路径不是仓库标题链接');
eq(isRepoHref('/topics/python'), null, '站点路径必须被保留字挡掉');
eq(isRepoHref('/search'), null);
eq(isRepoHref('/foo/releases'), { owner: 'foo', repo: 'releases' }, '名为 releases 的真仓库不能被漏判');
eq(isRepoHref('/foo/new'), null, '保留字位置的 new 不算仓库');

console.log(`ALL PASS · ${n} assertions`);
