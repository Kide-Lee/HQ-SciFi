import type { ActivityPhase } from '../../lib/activity'

/** 活动状态缓存（mid → phase；从文章跳转活动列表时用，避免重复请求） */
let cache: Record<string, ActivityPhase> | null = null

export function getActivePhaseCache(): Record<string, ActivityPhase> | null {
  return cache
}

export function setActivePhaseCache(value: Record<string, ActivityPhase>): void {
  cache = value
}
