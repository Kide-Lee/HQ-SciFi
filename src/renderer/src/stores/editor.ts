import { create } from 'zustand'
import { parseFrontmatter, type ArticleMeta } from '../../../shared/frontmatter'
import { useUiStore } from './ui'
import type { MediaTag } from '../lib/mediaNode'

/** v0.0.6：从 md 正文提取标题目录（h1-h6） */
export function extractToc(md: string): Array<{ idx: number; level: number; text: string }> {
  const items: Array<{ idx: number; level: number; text: string }> = []
  const re = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(md))) {
    const text = m[2].trim()
    if (!text) continue
    items.push({ idx: items.length, level: m[1].length, text })
  }
  return items
}

interface EditorState {
  /** 当前打开的本地文件绝对路径 */
  currentPath: string | null
  /** v0.0.6：写作首页当前浏览目录（绝对路径；'' = 存档根） */
  currentDir: string
  /** 正文（不含 frontmatter；落盘时与 meta 拼合） */
  content: string
  /** 文章元数据（frontmatter：类型/标签/活动/公开） */
  /** v0.0.6：frontmatter 元数据仅兼容旧文档读取（不再写入/编辑） */
  meta: ArticleMeta
  /** v0.0.6：编辑模式——可视化 / 源码模式 SV（提升到 store 供顶栏感知右栏 tab） */
  mode: 'wysiwyg' | 'split'
  /** v0.0.6：正文标题目录（右栏「目录」tab 与顶栏按钮显示判断用） */
  toc: Array<{ idx: number; level: number; text: string }>
  /** 与磁盘内容不一致（待保存） */
  dirty: boolean
  /** 是否已关联远端（有 cid） */
  synced: boolean
  /** 保存/加载进行中 */
  busy: boolean
  error: string | null
  open: (path: string) => Promise<void>
  update: (content: string) => void
  /** v0.0.8：强制从磁盘重载当前打开的文档（远端「编辑」拉取覆盖本地后使用；丢弃未保存修改） */
  reload: () => Promise<void>
  /** 更新元数据（类型/标签/活动/公开），标记未保存 */
  /** v0.0.6：元数据改由发布表单提供，移除 setMeta（本地 frontmatter 不再记录） */
  setMode: (mode: 'wysiwyg' | 'split') => void
  save: () => Promise<void>
  /** 新建本地草稿并打开，返回文件路径 */
  createDraft: (title: string, dirRel?: string) => Promise<string | null>
  close: () => Promise<void>
  /** v0.0.6：切换写作首页浏览目录 */
  setCurrentDir: (dir: string) => void
  /**
   * v0.0.6+：外部注入内容（搜索替换用）。
   * MilkdownEditor 订阅 seq 变化并替换整个 doc；替换后经 onChange 回流 content 保持一致。
   */
  externalContent: { md: string; seq: number } | null
  applyExternalContent: (md: string) => void
  /**
   * v0.0.6：公式编辑弹窗状态——open 是否打开、value 当前 LaTeX、pos 编辑目标节点位置（null=插入新模式）。
   * 由 MilkdownToolbar「公式」按钮打开（插入）；由 MilkdownEditor 监听 NodeSelection 打开（编辑）。
   */
  mathModal: { open: boolean; value: string; pos: number | null }
  openMathModal: (value: string, pos: number | null) => void
  closeMathModal: () => void
  /**
   * v0.0.8：媒体（音乐/视频）插入/编辑弹窗状态——tag 当前媒体类型、id 当前值、
   * pos 编辑目标节点位置（null=插入新模式）。由工具栏按钮打开（插入）；由媒体节点点击打开（编辑）。
   */
  mediaModal: { open: boolean; tag: MediaTag; id: string; pos: number | null }
  openMediaModal: (tag: MediaTag, id: string, pos: number | null) => void
  closeMediaModal: () => void
}

/** 本地即时保存防抖（ms） */
const SAVE_DEBOUNCE = 800

export const useEditorStore = create<EditorState>((set, get) => {
  let timer: ReturnType<typeof setTimeout> | null = null

  function scheduleSave(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void get().save()
    }, SAVE_DEBOUNCE)
  }

  return {
    currentPath: null,
    currentDir: '',
    content: '',
    meta: {},
    mode: 'wysiwyg',
    toc: [],
    dirty: false,
    synced: false,
    busy: false,
    error: null,

    open: async (path) => {
      const { currentPath, dirty } = get()
      if (currentPath === path) {
        // 同文档：若未保存则保留内存内容（防止磁盘内容覆盖未保存修改），否则无需重载；
        // 重开同文档（如从文章阅读态切回）时选中态跟随，避免侧栏高亮残留
        useUiStore.getState().setSelectedId(path)
        return
      }
      // 切换文档前先落盘当前未保存修改，避免防抖窗口内丢内容
      if (currentPath && dirty) {
        await get().save()
      }
      set({ busy: true, error: null })
      const res = await window.hqsf.readLocalFile(path)
      if (res.ok) {
        const { meta, body } = parseFrontmatter(res.data)
        set({ currentPath: path, content: body, meta, dirty: false, busy: false, toc: extractToc(body) })
        // 侧栏选中跟随打开的文档（本地树高亮以 selectedId 为唯一来源）
        useUiStore.getState().setSelectedId(path)
        // 关联状态由索引刷新确定：读取文章索引中的该文件记录
        const arts = await window.hqsf.listArticles()
        if (arts.ok) {
          const row = arts.data.find((a) => a.filePath === path)
          set({ synced: !!row?.cid })
        }
      } else {
        set({ busy: false, error: res.error })
      }
    },

    update: (content) => {
      set({ content, dirty: true, toc: extractToc(content) })
      scheduleSave()
    },

    reload: async () => {
      const { currentPath } = get()
      if (!currentPath) return
      set({ busy: true, error: null })
      const res = await window.hqsf.readLocalFile(currentPath)
      if (res.ok) {
        const { meta, body } = parseFrontmatter(res.data)
        set({ content: body, meta, dirty: false, busy: false, toc: extractToc(body) })
      } else {
        set({ busy: false, error: res.error })
      }
    },

    setMode: (mode) => set({ mode }),

    save: async () => {
      const { currentPath, content, dirty } = get()
      if (!currentPath || !dirty) return
      set({ busy: true, error: null })
      // v0.0.6：落盘仅正文（frontmatter 不再记录元数据；旧文档的 frontmatter 首次保存后被移除）
      const res = await window.hqsf.writeLocalFile(currentPath, content)
      if (res.ok) set({ dirty: false, busy: false })
      else set({ busy: false, error: res.error })
    },

    createDraft: async (title, dirRel) => {
      set({ busy: true, error: null })
      const res = await window.hqsf.createLocalDraft(title, `# ${title}\n\n`, dirRel)
      if (res.ok) {
        set({
          currentPath: res.data,
          content: `# ${title}\n\n`,
          meta: {},
          mode: 'wysiwyg',
          toc: extractToc(`# ${title}\n\n`),
          dirty: false,
          synced: false,
          busy: false
        })
        // 侧栏选中跟随新建的草稿
        useUiStore.getState().setSelectedId(res.data)
        return res.data
      }
      set({ busy: false, error: res.error })
      return null
    },

    close: async () => {
      // 关闭前落盘未保存修改
      if (get().dirty) await get().save()
      if (timer) clearTimeout(timer)
      set({ currentPath: null, content: '', meta: {}, dirty: false, synced: false, error: null, toc: [] })
      // 关闭文档后清除侧栏选中（本地树高亮以 selectedId 为唯一来源）
      useUiStore.getState().setSelectedId(null)
    },

    setCurrentDir: (currentDir) => set({ currentDir }),
    externalContent: null,
    applyExternalContent: (md) => set((s) => ({ externalContent: { md, seq: (s.externalContent?.seq ?? 0) + 1 } })),
    mathModal: { open: false, value: '', pos: null },
    openMathModal: (value, pos) => set({ mathModal: { open: true, value, pos } }),
    closeMathModal: () => set((s) => ({ mathModal: { ...s.mathModal, open: false } })),
    mediaModal: { open: false, tag: 'music 163', id: '', pos: null },
    openMediaModal: (tag, id, pos) => set({ mediaModal: { open: true, tag, id, pos } }),
    closeMediaModal: () => set((s) => ({ mediaModal: { ...s.mediaModal, open: false } }))
  }
})
