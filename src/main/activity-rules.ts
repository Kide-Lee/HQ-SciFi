import type { ArticleDetail, CommentItem, RemoteArticle, ReviewItem } from '../shared/types'

/**
 * 荒启底层规则：投稿期间（进行中）/ 评稿期间（评审中）必须匿名，且不暴露评分与排名。
 * 本模块提供纯数据脱敏函数，由各接口适配层在返回给渲染层前统一调用。
 * 脱敏原则：只改「展示字段」，保留内部字段（authorId/isAnonymous/activeid 等）供后续规则判断。
 */

/** 服务端在活动期间对作者评论回复的占位文案（不展示，直接过滤） */
export const SERVER_HIDDEN_COMMENT = '活动期间，作者评论回复暂时隐藏'

/** 展示名匿名化：替换 name/nickname/avatar 等展示字段，保留 uid 等内部字段 */
function anonymizeUserJson(u: Record<string, unknown> | undefined): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(u ?? {}) }
  next.name = '匿名用户'
  next.nickname = '匿名用户'
  next.screenName = '匿名用户'
  next.avatar = ''
  next.headImg = ''
  next.headImgUrl = ''
  next.avatarUrl = ''
  return next
}

function isInMids(mids: Set<string>, mid: unknown): boolean {
  return mid != null && mids.has(String(mid))
}

/** 文章列表条目脱敏：进行中/评审中活动文章隐藏评分、匿名作者展示名 */
export function sanitizeArticleList(items: RemoteArticle[], mids: Set<string>): RemoteArticle[] {
  for (const it of items) {
    if ((it.active ?? []).some((m) => isInMids(mids, m.mid))) {
      it.score = '-.-'
      it.hideScore = true
      it.authorInfo = anonymizeUserJson(it.authorInfo)
    }
  }
  return items
}

/** 文章详情脱敏：正文保留，评分隐藏，作者展示名匿名化 */
export function sanitizeArticleDetail(detail: ArticleDetail, mids: Set<string>): ArticleDetail {
  if ((detail.active ?? []).some((m) => isInMids(mids, m.mid))) {
    detail.score = '-.-'
    detail.userJson = anonymizeUserJson(detail.userJson)
  }
  return detail
}

/**
 * 评审列表脱敏：进行中/评审中活动的评审不展示评分（含文章评分回退）。
 * 例外：自己的评审始终保留评分——用户应当能看到自己提交的评分，
 * 匿名/隐藏规则只约束他人可见性。
 */
export function sanitizeReviewList(items: ReviewItem[], mids: Set<string>, myUid?: string): ReviewItem[] {
  for (const it of items) {
    const isMine = myUid != null && myUid !== '' && String(it.uid ?? '') === String(myUid)
    if (isInMids(mids, it.activeid) && !isMine) {
      it.actualscore = '-.-'
      it.score = '-.-,-.-,-.-,-.-,-.-'
      it.hideScore = true
    }
  }
  return items
}

/**
 * 评论列表脱敏：
 * 1. 过滤服务端占位评论；
 * 2. 若评论所属文章处于匿名活动期，且评论者就是文章作者，则匿名化评论者展示名。
 * @param anonymousCids 匿名活动文章 cid 集合（调用方尽量补全；缺失时只做占位过滤）
 */
export function sanitizeCommentList(items: CommentItem[], anonymousCids?: Set<string>): CommentItem[] {
  const filtered = items.filter((c) => String(c.text ?? '').trim() !== SERVER_HIDDEN_COMMENT)
  if (!anonymousCids || anonymousCids.size === 0) return filtered
  for (const c of filtered) {
    const cid = String(c.cid ?? '')
    if (!anonymousCids.has(cid)) continue
    const authorId = String(c.authorId ?? '')
    const articleAuthorId = String(c.articleAuthorId ?? '')
    if (authorId !== '' && authorId !== '0' && articleAuthorId !== '' && articleAuthorId !== '0' && authorId === articleAuthorId) {
      c.author = '匿名用户'
      c.avatar = undefined
    }
  }
  return filtered
}
