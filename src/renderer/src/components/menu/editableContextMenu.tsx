import { ClipboardPaste, Copy, Redo2, Scissors, TextSelect, Undo2 } from 'lucide-react'
import type { ContextMenuItem } from '../../stores/contextMenu'

/**
 * v1.1.12：可编辑元素（输入框 / 文本域 / contenteditable）的右键菜单回退。
 *
 * Electron 不提供默认右键菜单，若不兜底，发布表单、评论框、搜索框里鼠标右键
 * 既不能复制也不能粘贴（编辑器与阅读正文已有各自的菜单，见 EditorPane / ReaderView）。
 *
 * 这里全部用浏览器原生命令：cut/copy/undo/redo/selectAll 走 execCommand
 * （只有原生命令才会触发 input 事件，React 受控组件的 state 才能同步）；
 * 粘贴不能用 execCommand('paste')（Chromium 禁用），改由主进程读剪贴板 + insertText 插入。
 */

/** 支持文本编辑的 input type（button/checkbox 等不算可编辑） */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number'])

export function isEditableTarget(el: HTMLElement): boolean {
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type)
  return el.isContentEditable
}

function hasSelection(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const { selectionStart, selectionEnd } = el
    return selectionStart != null && selectionEnd != null && selectionEnd > selectionStart
  }
  const sel = window.getSelection()
  return !!sel && !sel.isCollapsed
}

/** 粘贴（主进程读剪贴板 → insertText，保住 React 受控输入的回流） */
async function pasteInto(el: HTMLElement): Promise<void> {
  const res = await window.hqsf.readClipboardText()
  if (!res.ok || !res.data) return
  el.focus()
  if (!document.execCommand('insertText', false, res.data)) {
    // 极端兜底（insertText 不被支持）：直接改 value 并广播 input 事件
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? el.value.length
      el.value = el.value.slice(0, start) + res.data + el.value.slice(end)
      el.selectionStart = el.selectionEnd = start + res.data.length
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }
}

/** 就地取菜单项；目标不是可编辑元素时返回 null（调用方不出菜单） */
export function buildEditableContextMenu(el: HTMLElement): ContextMenuItem[] | null {
  if (!isEditableTarget(el)) return null
  const selected = hasSelection(el)
  const exec = (cmd: string): void => {
    el.focus()
    document.execCommand(cmd)
  }
  return [
    { label: '撤销', icon: <Undo2 size={13} />, onSelect: () => exec('undo') },
    { label: '重做', icon: <Redo2 size={13} />, onSelect: () => exec('redo') },
    {
      label: '剪切',
      icon: <Scissors size={13} />,
      divided: true,
      disabled: !selected,
      onSelect: () => exec('cut')
    },
    { label: '复制', icon: <Copy size={13} />, disabled: !selected, onSelect: () => exec('copy') },
    { label: '粘贴', icon: <ClipboardPaste size={13} />, onSelect: () => void pasteInto(el) },
    { label: '全选', icon: <TextSelect size={13} />, onSelect: () => exec('selectAll') }
  ]
}
