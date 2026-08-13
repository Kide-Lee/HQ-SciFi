import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/prose/state'
import { useEditorStore } from '../stores/editor'

/**
 * v0.0.6：点击公式节点 → 打开公式弹窗（重编辑）。
 * 2026-08-14：改用 handleClickOn——handleClick 只回调位置号 pos，点击行内 atom
 * 右半侧时 posAtCoords 解析为节点之后的文本位置，nodeAt(pos) 取不到节点；
 * handleClickOn 额外回调节点本身与节点位置，可精确定位公式节点。
 */
export const mathClickPlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleClickOn(view, _pos, node, nodePos, event) {
          const target = event.target as HTMLElement | null
          const el = target?.closest('[data-type="math_inline"], [data-type="math_block"]')
          if (!el) return false
          if (node && (node.type.name === 'math_inline' || node.type.name === 'math_block')) {
            useEditorStore.getState().openMathModal(String(node.attrs.value ?? ''), nodePos)
          }
          // 返回 false：让 ProseMirror 正常选中节点（NodeSelection），不阻断默认行为
          return false
        }
      }
    })
)
