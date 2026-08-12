import { create } from 'zustand'
import { parseFrontmatter, withFrontmatter, type ArticleMeta } from '../../../shared/frontmatter'

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
  meta: ArticleMeta
  /** v0.0.6：编辑模式——所见即所得 / 分屏预览 SV（提升到 store 供顶栏感知右栏 tab） */
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
  /** 更新元数据（类型/标签/活动/公开），标记未保存 */
  setMeta: (patch: Partial<ArticleMeta>) => void
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
        // 同文档：若未保存则保留内存内容（防止磁盘内容覆盖未保存修改），否则无需重载
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

    setMeta: (patch) => {
      set((s) => ({ meta: { ...s.meta, ...patch }, dirty: true }))
      scheduleSave()
    },

    setMode: (mode) => set({ mode }),

    save: async () => {
      const { currentPath, content, meta, dirty } = get()
      if (!currentPath || !dirty) return
      set({ busy: true, error: null })
      // 落盘 = frontmatter 元数据 + 正文拼合
      const res = await window.hqsf.writeLocalFile(currentPath, withFrontmatter(meta, content))
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
    },

    setCurrentDir: (currentDir) => set({ currentDir }),
    externalContent: null,
    applyExternalContent: (md) => set((s) => ({ externalContent: { md, seq: (s.externalContent?.seq ?? 0) + 1 } }))
  }
})
