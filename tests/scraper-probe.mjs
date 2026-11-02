// 把浏览器 IIFE 版 scraper.js 桥接成 ESM 供 node 单测使用。
// run.sh 会先把 content/scraper.js 复制成 tests/.tmp/scraper.mjs（scraper 自身只认 globalThis）。
import './.tmp/scraper.mjs';

const S = globalThis.__GZG_SCRAPE;
if (!S) throw new Error('scraper.js 没有挂上 __GZG_SCRAPE');

export const isRepoHref = S.isRepoHref;
export const parseCount = S.parseCount;
export const scrape = S.scrape;
export const findListRoot = S.findListRoot;
export const normalizeUpdated = S.normalizeUpdated;
export const RESERVED_TOP = S.RESERVED_TOP;
export const RESERVED_SECOND = S.RESERVED_SECOND;
