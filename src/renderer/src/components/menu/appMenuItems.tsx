import { RefreshCw, Wrench } from 'lucide-react'
import type { ContextMenuItem } from '../../stores/contextMenu'
import { useEditorStore } from '../../stores/editor'

/**
 * v1.1.12：所有右键菜单末尾统一追加的系统项——刷新（整页重载）与开发者工具。
 * 由 ContextMenuHost 统一追加，调用方不要自己加（避免各菜单不一致或重复）。
 */

/** 刷新前先把编辑器里未落盘的改动写盘，否则整页重载会丢掉最后几次输入 */
async function refreshApp(): Promise<void> {
  const ed = useEditorStore.getState()
  if (ed.currentPath && ed.dirty) {
    try {
      await ed.save()
    } catch {
      // 落盘失败也继续刷新（用户明确要的是重新加载界面）
    }
  }
  location.reload()
}

export function appMenuItems(): ContextMenuItem[] {
  return [
    { label: '刷新', icon: <RefreshCw size={13} />, divided: true, onSelect: () => void refreshApp() },
    { label: '开发者工具', icon: <Wrench size={13} />, onSelect: () => void window.hqsf.toggleDevTools() }
  ]
}
