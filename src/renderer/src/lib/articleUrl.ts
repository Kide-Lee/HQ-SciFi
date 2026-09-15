/**
 * v1.1.12：H5 文章页公开链接（分享 / 复制链接用）。
 * H5 前端包实测路由为 pages/contents/info?cid=。
 */
export function h5ArticleUrl(cid: string): string {
  return `https://www.huangqisf.com/h5/#/pages/contents/info?cid=${encodeURIComponent(cid)}`
}
