/**
 * 活动状态判定（v0.0.2，2026-08-08 实测）：
 * metasList type=active 条目含 activeStatus：1=进行中 / -1=评审中 / 0=已结束。
 * 进行中/评审中的活动文章无评分（score 恒 '-.-'），客户端应对这两类活动
 * 隐藏评分榜、评分与排名。
 */
import type { MetaInfo } from '../../../shared/types'

export type ActivityPhase = 'ongoing' | 'reviewing' | 'ended'

export function activityPhase(meta: { activeStatus?: number | string; deadline?: number }): ActivityPhase {
  const s = Number(meta.activeStatus)
  if (s === 1) return 'ongoing'
  if (s === -1) return 'reviewing'
  return 'ended'
}

/** 进行中/评审中（需要隔离评分榜/评分/排名的活动） */
export function isActiveReviewing(meta: { activeStatus?: number | string; deadline?: number }): boolean {
  const p = activityPhase(meta)
  return p === 'ongoing' || p === 'reviewing'
}

export const ACTIVITY_PHASE_LABEL: Record<ActivityPhase, string> = {
  ongoing: '进行中',
  reviewing: '评审中',
  ended: ''
}

/** 中文数字 → 整数（覆盖「第X期」1-99：一~九 / 十 / 十一~十九 / 二十 / 二十X） */
export function cnNumToInt(s: string): number {
  const digits: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (s === '十') return 10
  const ten = s.indexOf('十')
  if (ten < 0) return digits[s] ?? 0
  const tens = ten === 0 ? 1 : digits[s[0]] ?? 0
  const ones = ten === s.length - 1 ? 0 : digits[s[ten + 1]] ?? 0
  return tens * 10 + ones
}

/** 活动排序：练笔期次按期数倒序（最新在前），非练笔活动排最后（保持原序） */
export function sortActivities(metas: Array<{ name: string }>): MetaInfo[] {
  const issueOf = (name: string): number => {
    const m = /第([一二三四五六七八九十]+)期/.exec(name)
    return m ? cnNumToInt(m[1]) : 0
  }
  const exercises = metas
    .filter((m) => issueOf(m.name) > 0)
    .sort((a, b) => issueOf(b.name) - issueOf(a.name))
  const others = metas.filter((m) => issueOf(m.name) === 0)
  return [...exercises, ...others] as MetaInfo[]
}
