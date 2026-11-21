import type { RemoteArticle } from '../../../shared/types'

/** selectContents / reviewList 单页服务端最多回 50 条（传 100 也只回 50）。 */
const PAGE_SIZE = 50
/** 防呆上限：活动文章/评审很少超过 1000 条。 */
const MAX_PAGES = 20

/** 按页拉全某活动的文章（原实现 limit:100 只拿到前 50 篇，活动统计/活动树因此缺文章）。 */
export async function listAllActivityArticles(
  mid: number | string,
  order = 'created',
  maxPages = MAX_PAGES
): Promise<RemoteArticle[]> {
  const out: RemoteArticle[] = []
  const seen = new Set<string>()
  for (let page = 1; page <= maxPages; page++) {
    const res = await window.hqsf.listRemoteArticles({ mid, limit: PAGE_SIZE, order, page })
    if (!res.ok) break
    const items = res.data.items
    let added = 0
    for (const item of items) {
      const cid = String(item.cid)
      if (seen.has(cid)) continue
      seen.add(cid)
      out.push(item)
      added++
    }
    // 服务端在部分查询下忽略 page（第 2 页重复第 1 页）；没有新条目立即停。
    if (items.length < PAGE_SIZE || added === 0) break
  }
  return out
}
