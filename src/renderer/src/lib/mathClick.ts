import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/prose/state'
import { useEditorStore } from '../stores/editor'

/**
 * v0.0.6：点击公式节点 → 打开公式弹窗（重编辑）。
 * 用 prosemirror handleClick（每次点击都触发，即使选中状态未变），
 * pos 参数直接定位节点（不用 posAtDOM，atom 节点的 DOM 定位有偏移）。
 */
export const mathClickPlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleClick(view, pos, event) {
          const target = event.target as HTMLElement | null
          const el = target?.closest('[data-type="math_inline"], [data-type="math_block"]')
          if (!el) return false
          const node = view.state.doc.nodeAt(pos)
          if (node && (node.type.name === 'math_inline' || node.type.name === 'math_block')) {
            useEditorStore.getState().openMathModal(String(node.attrs.value ?? ''), pos)
          }
          // 返回 false：让 ProseMirror 正常选中节点（NodeSelection），不阻断默认行为
          return false
        }
      }
    })
)
