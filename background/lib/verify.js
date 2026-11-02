// 下载结果判定。抽成纯函数是为了能被单元测试覆盖——在真实浏览器里构造
// 「200 状态码但内容不是 zip」的镜像响应很难稳定复现（实测镜像会拿 9 字节 text/plain
// 或几百字节 HTML/JSON 错误页冒充 .zip），但判定规则本身是可以确定验证的。

// 实测：GitHub 正规归档响应一律 application/zip；部分镜像透传 application/x-zip-compressed
// 或 application/octet-stream。除此之外的 Content-Type 都按错误页处理。
const ZIP_MIME = /zip|octet-stream/i;

/**
 * @param {{size:number, mime?:string, minBytes?:number, state?:string}} r
 * @returns {{ok:boolean, reason:string}}
 */
export function verdict(r) {
  const size = Number(r?.size) || 0;
  const mime = String(r?.mime || '');
  const min = Number(r?.minBytes) || 64;

  if (r?.state && r.state !== 'complete') {
    return { ok: false, reason: `下载未完成（${r.state}）` };
  }
  if (size < min) {
    return { ok: false, reason: `文件过小（${size} B < ${min} B，疑似错误页）` };
  }
  // mime 缺失时不武断否决（个别内核不上报），体积门槛已经拦住绝大多数错误页
  if (mime && !ZIP_MIME.test(mime)) {
    return { ok: false, reason: `响应 Content-Type=${mime}，不是 zip（疑似镜像错误页）` };
  }
  return { ok: true, reason: '' };
}
