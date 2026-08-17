import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CloudUpload, Save, Send, ShieldCheck } from 'lucide-react'
import { useEditorStore } from '../stores/editor'
import { useDocsStore } from '../stores/docs'
import type { ArticleMeta } from '../../../shared/frontmatter'
import { PublishModal } from './PublishModal'

/** v0.0.6：字数统计——不计空格与标点符号（按 Unicode 码点） */
function countWords(text: string): number {
  return [...text.replace(/[\s\p{P}\p{S}]/gu, '')].length
}

interface EditorBarProps {
  /** 格式按钮组（milkdown 编辑工具栏），仅可视化模式传入；须在 MilkdownProvider 内渲染 */
  formatSlot?: ReactNode
}

/**
 * v0.0.6：编辑栏（并入编辑器内部——顶栏与编辑栏之间不再有独立横条）。
 * 可视化：保存/同步到草稿/发布/违禁词检测 + 格式按钮组 + 字数（状态徽标）+ 模式切换；
 * 源码模式：仅功能按钮一行（无格式按钮组）。
 * v0.0.6：元信息（类型/标签/活动/公开）改由发布表单（PublishModal）提供，不再常驻编辑栏。
 */
export function EditorBar({ formatSlot }: EditorBarProps): React.JSX.Element {
  const currentPath = useEditorStore((s) => s.currentPath)
  const content = useEditorStore((s) => s.content)
  const dirty = useEditorStore((s) => s.dirty)
  const busy = useEditorStore((s) => s.busy)
  const save = useEditorStore((s) => s.save)
  const push = useDocsStore((s) => s.push)
  const pushing = useDocsStore((s) => s.pushing)

  const [toast, setToast] = useState<string | null>(null)
  const [forbidMsg, setForbidMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [showPublish, setShowPublish] = useState(false)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)

  // 切换文档时重置违禁词检测结果
  useEffect(() => {
    setForbidMsg(null)
  }, [currentPath])

  // v0.0.7+：工具栏折行后，每行开头的分组隐藏左侧分割线。
  // CSS 无法感知折行位置，用测量实现：分组左边缘与工具栏左边缘重合（含尚未去边距的 8px）
  // 即为行首 → 加 .line-start；ResizeObserver 跟随工具栏尺寸变化（窗口/右栏宽度变化）重算
  useEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar) return
    const update = (): void => {
      const base = toolbar.getBoundingClientRect().left
      const groups = Array.from(toolbar.querySelectorAll<HTMLElement>(':scope > .md-toolbar-group'))
      for (const g of groups) {
        g.classList.toggle('line-start', g.getBoundingClientRect().left - base < 9)
      }
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(toolbar)
    return () => ro.disconnect()
  }, [])

  function showToast(msg: string): void {
    setToast(msg)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 3000)
  }

  /** 同步到草稿（不携带元数据；frontmatter 不再记录） */
  async function handleSyncDraft(): Promise<void> {
    if (!currentPath) return
    await save() // 先落盘，确保上传的是最新内容
    const res = await push(currentPath, true)
    if (!res) {
      showToast('操作失败')
      return
    }
    showToast(res.ok ? '已同步到草稿' : (res.error ?? '操作失败'))
  }

  /** 发布：元数据来自发布表单（PublishModal 确认后调用） */
  async function handlePublish(meta: ArticleMeta): Promise<void> {
    if (!currentPath) return
    setShowPublish(false)
    await save() // 先落盘，确保上传的是最新内容
    const res = await push(currentPath, false, meta)
    if (!res) {
      showToast('操作失败')
      return
    }
    showToast(res.ok ? '已提交发布' : (res.error ?? '操作失败'))
  }

  /** 违禁词检测：官方接口（hqContents/userTextBlockStatus，付费 5 能量币/次），先确认再检测 */
  async function handleCheckForbidden(): Promise<void> {
    const confirmRes = await window.hqsf.showMessageBox({
      type: 'question',
      title: '违禁词检测',
      message: '违禁词检测将消耗 5 能量币，是否继续？',
      buttons: ['取消', '继续'],
      cancelId: 0,
      defaultId: 1
    })
    if (!confirmRes.ok || confirmRes.data.response !== 1) return
    const fileName = (currentPath ?? '').split('/').pop()?.replace(/\.md$/i, '') ?? ''
    setForbidMsg(null)
    const res = await window.hqsf.checkForbidden(fileName, content)
    if (!res.ok) {
      setForbidMsg({ ok: false, text: res.error || '检测失败' })
      return
    }
    const msg = res.data.msg || '检测完成'
    setForbidMsg({ ok: msg.includes('无违规'), text: msg })
  }

  const pushingNow = pushing === currentPath
  // v0.0.6：字数（不计空格标点）；不足 3000 / 超过 33000 禁止发布（wordTip 仅用于发布按钮禁用，不再改变徽标样式/内容）
  const wordCount = countWords(content)
  const wordTip = wordCount < 3000 ? '字数不足' : wordCount > 33000 ? '字数太多' : null

  return (
    <div className="editor-toolbar-strip">
      <div className="et-row et-actions">
        {/* v0.0.6：统一容器——操作组与格式组同为 .md-toolbar 内的 .md-toolbar-group 兄弟，共享分割线规则 */}
        <div className="md-toolbar" ref={toolbarRef}>
        <div className="md-toolbar-group">
          {/* v0.0.6：编辑器最左面——保存/同步到草稿/发布/违禁词检测（图标按钮，统一为 .md-toolbar-group 分组；新建草稿在左栏 tree-toolbar） */}
          <button
            className="md-toolbar-btn"
            onClick={() => void save()}
            disabled={!dirty || busy}
            title="保存"
          >
            <Save size={14} />
          </button>
          <button
            className="md-toolbar-btn"
            onClick={() => void handleSyncDraft()}
            disabled={pushingNow || busy}
            title="同步到草稿"
          >
            <CloudUpload size={14} className={pushingNow ? 'sync-icon spin' : undefined} />
          </button>
          <button
            className="md-toolbar-btn"
            onClick={() => setShowPublish(true)}
            disabled={pushingNow || busy || wordTip !== null}
            title={
              wordTip
                ? `字数${wordTip === '字数不足' ? '不足 3000' : '超过 33000'}，禁止发布`
                : '发布'
            }
          >
            <Send size={14} />
          </button>
          <button
            className="md-toolbar-btn"
            onClick={() => void handleCheckForbidden()}
            title="违禁词检测"
          >
            <ShieldCheck size={14} />
          </button>
          {forbidMsg && (
            <span className={`forbid-result ${forbidMsg.ok ? 'ok' : 'bad'}`}>{forbidMsg.text}</span>
          )}
        </div>
        {/* v0.0.6：格式按钮组（仅可视化模式；milkdown 编辑工具栏）——与操作组同容器、同分割线规则 */}
        {formatSlot}
        </div>
      </div>

      {/* v0.0.6：发布表单（元信息在此填写，不再常驻编辑栏/写入 frontmatter） */}
      <PublishModal open={showPublish} onClose={() => setShowPublish(false)} onConfirm={(meta) => void handlePublish(meta)} />

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
