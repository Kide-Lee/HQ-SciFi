/**
 * 分类规则（v0.0.9）：科幻杂谈、官方公告、外文翻译 三类文章
 * 不开启评审功能、不显示评分（与活动进行中/评审中的评分隔离同理）。
 * 判断依据为文章条目的 category 数组（MetaRef.name），
 * 列表级判断可用列表标题（分类名）。
 */
import type { MetaRef } from '../../../shared/types'

export const REVIEW_DISABLED_CATEGORY_NAMES = ['科幻杂谈', '官方公告', '外文翻译']

const REVIEW_DISABLED_SET = new Set(REVIEW_DISABLED_CATEGORY_NAMES)

/** 分类名是否为「不开启评审、不显示评分」的分类 */
export function isReviewDisabledCategoryName(name: string | null | undefined): boolean {
  return name != null && REVIEW_DISABLED_SET.has(name)
}

/** 列表标题是否属于禁用评审分类（列表标题可能带「作品库 · 」等前缀） */
export function isReviewDisabledCategoryTitle(title: string | null | undefined): boolean {
  if (!title) return false
  return REVIEW_DISABLED_CATEGORY_NAMES.some((n) => title.includes(n))
}

/** 文章是否属于「不开启评审、不显示评分」的分类 */
export function isReviewDisabledArticle(article: {
  category?: Array<Pick<MetaRef, 'name'>> | null
}): boolean {
  return article.category?.some((c) => isReviewDisabledCategoryName(c.name)) ?? false
}
