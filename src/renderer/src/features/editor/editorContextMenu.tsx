import { ClipboardPaste, ClipboardType, Copy, ExternalLink, Link2, Scissors, TextSelect, Unlink } from 'lucide-react'
import { selectAll as cmSelectAll } from '@codemirror/commands'
import type { EditorView as CMEditorView } from '@codemirror/view'
import { selectAll as pmSelectAll } from '@milkdown/kit/prose/commands'
import type { EditorView as PMEditorView } from '@milkdown/prose/view'
import { findLinkInLine } from '../../lib/mdLink'
import type { ContextMenuItem } from '../../components/menu/ContextMenu'

/**
 * v1.1.12：编辑器右键菜单（可视化 / 源码两种模式共用）。
 *
 * 只放「没有按钮入口」的操作——剪切/复制/粘贴（含纯文本粘贴）/全选，以及光标下链接的
 * 打开/复制地址/移除。撤销/重做走快捷键与工具栏按钮，格式、插入媒体、保存/同步/发布等
 * 已有工具栏或编辑栏按钮，一律不进右键菜单（避免按钮的镜像菜单）。
 */

/** 链接信息（WYSIWYG 用 ProseMirror 位置，源码模式用行内范围） */
interface LinkInfo {
  href: string
  from: number
  to: number
}

/** 源码模式下 `[label](url)` 命中信息 */
interface SourceLink extends LinkInfo {
  /** 链接文字（移除链接时保留）；裸 URL 为 null */
  label: string | null
}

/** 外链一律交系统浏览器（主进程 setWindowOpenHandler 拦截 window.open 并 deny） */
function openExternal(href: string): void {
  window.open(href, '_blank')
}

function isHttp(href: string): boolean {
  return /^https?:\/\//i.test(href)
}

/** 读取系统剪贴板文本（Chromium 禁用 execCommand('paste')，必须走主进程） */
async function readClipboard(): Promise<string | null> {
  const res = await window.hqsf.readClipboardText()
  if (!res.ok || !res.data) return null
  return res.data
}

/**
 * 构造编辑器右键菜单项；右键不在任一编辑器内时返回 null（不出菜单）。
 * @param views 当前两种模式的 EditorView 句柄（EditorPane 持有，切换模式即失效的那个为 null）
 */
export function buildEditorContextMenu(
  e: React.MouseEvent,
  views: { pm: PMEditorView | null; cm: CMEditorView | null }
): ContextMenuItem[] | null {
  const el = e.target instanceof HTMLElement ? e.target : null
  if (!el) return null
  if (views.cm && el.closest('.cm-host')) return sourceMenu(views.cm, e)
  if (views.pm && el.closest('.md-editor-host')) return wysiwygMenu(views.pm, e)
  return null
}

/* ===== 可视化模式（Milkdown / ProseMirror） ===== */

function wysiwygMenu(view: PMEditorView, e: React.MouseEvent): ContextMenuItem[] {
  const sel = view.state.selection
  const hasSelection = !sel.empty
  const selectedText = hasSelection ? view.state.doc.textBetween(sel.from, sel.to, '\n') : ''

  const items: ContextMenuItem[] = [
    {
      label: '剪切',
      icon: <Scissors size={13} />,
      disabled: !hasSelection,
      onSelect: () => {
        void window.hqsf.copyText(selectedText)
        view.dispatch(view.state.tr.deleteSelection())
        view.focus()
      }
    },
    {
      label: '复制',
      icon: <Copy size={13} />,
      disabled: !hasSelection,
      onSelect: () => void window.hqsf.copyText(selectedText)
    },
    { label: '粘贴', icon: <ClipboardPaste size={13} />, onSelect: () => void pasteIntoWysiwyg(view, false) },
    {
      label: '纯文本粘贴',
      icon: <ClipboardType size={13} />,
      onSelect: () => void pasteIntoWysiwyg(view, true)
    },
    {
      label: '全选',
      icon: <TextSelect size={13} />,
      onSelect: () => {
        pmSelectAll(view.state, view.dispatch)
        view.focus()
      }
    }
  ]

  const link = linkInWysiwyg(view, e)
  if (link) {
    const linkItems: ContextMenuItem[] = []
    if (isHttp(link.href)) {
      linkItems.push({ label: '打开链接', icon: <ExternalLink size={13} />, onSelect: () => openExternal(link.href) })
    }
    linkItems.push({
      label: '复制链接地址',
      icon: <Link2 size={13} />,
      onSelect: () => void window.hqsf.copyText(link.href)
    })
    linkItems.push({ label: '移除链接', icon: <Unlink size={13} />, onSelect: () => removeLinkInWysiwyg(view, link) })
    linkItems[0].divided = true
    items.push(...linkItems)
  }
  return items
}

/** 右键处是否为链接（Milkdown 把链接渲染为 <a href>，直接读 DOM 最稳） */
function linkInWysiwyg(view: PMEditorView, e: React.MouseEvent): LinkInfo | null {
  const el = e.target instanceof HTMLElement ? e.target.closest('a[href]') : null
  if (!el) return null
  const href = el.getAttribute('href') ?? ''
  if (!href) return null
  try {
    const from = view.posAtDOM(el, 0)
    const first = el.firstChild
    const to =
      first && first.nodeType === 3
        ? view.posAtDOM(first, (first.nodeValue ?? '').length)
        : view.posAtDOM(el, el.childNodes.length)
    return { href, from, to: to > from ? to : from }
  } catch {
    // DOM 已脱离视图（例如清理中的重渲染）：只给打开/复制，不给移除
    return { href, from: -1, to: -1 }
  }
}

function removeLinkInWysiwyg(view: PMEditorView, link: LinkInfo): void {
  const mark = view.state.schema.marks.link
  if (!mark || link.from < 0 || link.to <= link.from) return
  view.dispatch(view.state.tr.removeMark(link.from, link.to, mark))
  view.focus()
}

/**
 * 粘贴到可视化模式。
 * `plainOnly=false`（菜单「粘贴」）：优先用剪贴板 HTML 还原格式（加粗/链接/列表），
 * 无 HTML 时退化为纯文本；`plainOnly=true`（菜单「纯文本粘贴」）：只插文本。
 * 两条路径都交给 ProseMirror 自己的解析逻辑（换行拆段落、schema 校验）。
 */
async function pasteIntoWysiwyg(view: PMEditorView, plainOnly: boolean): Promise<void> {
  const [textRes, htmlRes] = await Promise.all([
    window.hqsf.readClipboardText(),
    plainOnly ? Promise.resolve(null) : window.hqsf.readClipboardHtml()
  ])
  const text = textRes.ok ? (textRes.data ?? '') : ''
  const html = htmlRes && htmlRes.ok ? (htmlRes.data ?? '') : ''
  view.focus()
  if (html && view.pasteHTML(html)) return
  if (text && !view.pasteText(text)) view.dispatch(view.state.tr.insertText(text))
}

/* ===== 源码模式（CodeMirror） ===== */

function sourceMenu(view: CMEditorView, e: React.MouseEvent): ContextMenuItem[] {
  const sel = view.state.selection.main
  const hasSelection = sel.from !== sel.to
  const selectedText = hasSelection ? view.state.sliceDoc(sel.from, sel.to) : ''

  const items: ContextMenuItem[] = [
    {
      label: '剪切',
      icon: <Scissors size={13} />,
      disabled: !hasSelection,
      onSelect: () => {
        void window.hqsf.copyText(selectedText)
        view.dispatch({ changes: { from: sel.from, to: sel.to, insert: '' } })
        view.focus()
      }
    },
    {
      label: '复制',
      icon: <Copy size={13} />,
      disabled: !hasSelection,
      onSelect: () => void window.hqsf.copyText(selectedText)
    },
    // 源码模式本身就是纯文本，不再分出「纯文本粘贴」（两项会完全同义）
    { label: '粘贴', icon: <ClipboardPaste size={13} />, onSelect: () => void pasteIntoSource(view) },
    {
      label: '全选',
      icon: <TextSelect size={13} />,
      onSelect: () => {
        cmSelectAll(view)
        view.focus()
      }
    }
  ]

  const link = linkInSource(view, e)
  if (link) {
    const linkItems: ContextMenuItem[] = []
    if (isHttp(link.href)) {
      linkItems.push({ label: '打开链接', icon: <ExternalLink size={13} />, onSelect: () => openExternal(link.href) })
    }
    linkItems.push({
      label: '复制链接地址',
      icon: <Link2 size={13} />,
      onSelect: () => void window.hqsf.copyText(link.href)
    })
    if (link.label != null) {
      const range = { from: link.from, to: link.to }
      linkItems.push({
        label: '移除链接',
        icon: <Unlink size={13} />,
        // 源码模式下「移除」= 去掉链接语法保留文字
        onSelect: () => {
          view.dispatch({ changes: { ...range, insert: link.label ?? '' } })
          view.focus()
        }
      })
    }
    linkItems[0].divided = true
    items.push(...linkItems)
  }
  return items
}

/** 源码模式：在右键所在行查找 `[label](url)` 或裸 URL */
function linkInSource(view: CMEditorView, e: React.MouseEvent): SourceLink | null {
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head
  const line = view.state.doc.lineAt(pos)
  const hit = findLinkInLine(line.text, pos - line.from)
  if (!hit) return null
  return { href: hit.href, from: line.from + hit.start, to: line.from + hit.end, label: hit.label }
}

/** 粘贴到源码模式：CodeMirror 原生处理换行 */
async function pasteIntoSource(view: CMEditorView): Promise<void> {
  const text = await readClipboard()
  if (text == null) return
  view.focus()
  view.dispatch(view.state.replaceSelection(text))
}
