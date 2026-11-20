import { useCallback, useEffect, useRef } from 'react'
import { clearDraft, draftStorageKey, writeDraft, type DraftRef } from '../../lib/draftCache'

/**
 * v1.1.12：把输入框 / 表单的当前值同步到未提交草稿缓存。
 *
 * - 值有实质内容（`isEmpty` 为 false）时写入，与基线一致或清空时清除；
 * - 只在值真正变化时读写（按 key + 序列化值判重），不打扰每次渲染；
 *   挂载时若恢复出草稿，会把同一份内容写回一次，等效于刷新保留期；
 * - 组件卸载不清除——这正是「离开/刷新后恢复」依赖的行为；
 * - 返回 `forgetDraft()`：提交成功或用户主动「丢弃草稿」时调用，同步清缓存
 *   并把当前值标记为已同步，避免组件尚未卸载时又被 effect 写回。
 *
 * `ref` / `value` / `isEmpty` 每次渲染都是新对象，故只按 key + 序列化值触发 effect，
 * 实际读写的永远是最新一份（latest ref）。
 */
export function useDraftSync<T>(params: {
  ref: DraftRef
  value: T
  /** 返回 true 表示「没有可缓存的输入」（与基线一致 / 正文空白） */
  isEmpty: (value: T) => boolean
  /** false 时完全不读写（如未登录、cid 未就绪） */
  enabled?: boolean
}): () => void {
  const { ref, value, isEmpty } = params
  const enabled = params.enabled ?? true
  const key = draftStorageKey(ref)
  const serialized = JSON.stringify(value)
  const latest = useRef({ ref, value, isEmpty, serialized })
  latest.current = { ref, value, isEmpty, serialized }
  const lastSynced = useRef({ key: '', serialized: '' })

  useEffect(() => {
    if (!enabled) return
    if (lastSynced.current.key === key && lastSynced.current.serialized === serialized) return
    lastSynced.current = { key, serialized }
    const cur = latest.current
    if (cur.isEmpty(cur.value)) clearDraft(cur.ref)
    else writeDraft(cur.ref, cur.value)
  }, [key, serialized, enabled])

  return useCallback(() => {
    const cur = latest.current
    clearDraft(cur.ref)
    lastSynced.current = { key, serialized: cur.serialized }
  }, [key])
}
