import { create } from 'zustand'
import type { ArticleRow, LocalNode, PullResult, PushResult } from '../../../shared/types'
import type { ArticleMeta } from '../../../shared/frontmatter'
import { useEditorStore } from './editor'

interface DocsState {
  /** 四态索引（SQLite，远端元数据 + 本地文件关联） */
  articles: ArticleRow[]
  /** 本地存档目录树 */
  localTree: LocalNode[]
  /** 上次全量拉取结果（用于展示同步摘要） */
  lastPull: PullResult | null
  /** 拉取进行中 */
  pulling: boolean
  /** 推送进行中（同步到草稿/发布） */
  pushing: string | null
  error: string | null
  refreshLocal: () => Promise<void>
  refreshArticles: () => Promise<void>
  pull: () => Promise<void>
  /** v0.0.6：push 携带可选元数据（发布表单提供；同步到草稿不传） */
  push: (filePath: string, isDraft: boolean, meta?: ArticleMeta) => Promise<PushResult | null>
  /** v0.0.6：删除本地文章文件（成功后刷新目录树） */
  deleteLocal: (path: string) => Promise<boolean>
  clearError: () => void
}

export const useDocsStore = create<DocsState>((set, get) => ({
  articles: [],
  localTree: [],
  lastPull: null,
  pulling: false,
  pushing: null,
  error: null,

  refreshLocal: async () => {
    const res = await window.hqsf.listLocalDocs()
    if (res.ok) set({ localTree: res.data })
    else set({ error: res.error })
  },

  refreshArticles: async () => {
    const res = await window.hqsf.listArticles()
    if (res.ok) set({ articles: res.data })
    else set({ error: res.error })
  },

  pull: async () => {
    if (get().pulling) return
    // 先落盘当前编辑器内容，避免远端拉取覆盖磁盘后内存 stale 内容回写吞掉远端更新
    const ed = useEditorStore.getState()
    if (ed.currentPath && ed.dirty) await ed.save()
    set({ pulling: true, error: null })
    const res = await window.hqsf.syncPull()
    if (res.ok) {
      set({ lastPull: res.data, pulling: false })
      await Promise.all([get().refreshLocal(), get().refreshArticles()])
    } else {
      set({ error: res.error, pulling: false })
    }
  },

  push: async (filePath, isDraft, meta?) => {
    if (get().pushing) return null
    set({ pushing: filePath, error: null })
    const res = await window.hqsf.syncPush(filePath, isDraft, meta)
    set({ pushing: null })
    if (!res.ok) {
      set({ error: res.error })
      return null
    }
    // 推送成功：刷新索引；若推送的是当前编辑文档，同步其关联状态徽标
    await get().refreshArticles()
    if (res.data.ok && res.data.cid && useEditorStore.getState().currentPath === filePath) {
      useEditorStore.setState({ synced: true })
    }
    return res.data
  },

  clearError: () => set({ error: null }),

  deleteLocal: async (path) => {
    const res = await window.hqsf.deleteLocalDoc(path)
    if (res.ok) {
      await get().refreshLocal()
      // 删除的恰是当前编辑文档时关闭编辑器
      if (useEditorStore.getState().currentPath === path) await useEditorStore.getState().close()
      return true
    }
    set({ error: res.error })
    return false
  }
}))
