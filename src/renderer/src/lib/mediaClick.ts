import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/prose/state'
import { useEditorStore } from '../stores/editor'
import type { MediaTag } from './mediaNode'

/**
 * v0.0.8：点击媒体节点 → 打开媒体弹窗（重编辑/删除）。
 * 用 handleClickOn 而非 handleClick：handleClick 只回调点击解析出的位置号 pos，
 * 点击 atom 节点右半侧（编辑 chip 位于播放器右上角）时 posAtCoords 会把坐标解析为
 * 节点之后的文本位置，nodeAt(pos) 取不到媒体节点导致弹窗打不开（2026-08-14 CDP 实测）；
 * handleClickOn 额外回调节点本身与节点位置（inside），可精确定位 atom 节点。
 * 播放器 iframe 本身可交互（点击播放），不会冒泡到编辑器；点击「编辑」chip
 * 或播放器外框（含非法 ID 回退的标签原文）时打开弹窗。
 */
export const mediaClickPlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleClickOn(view, _pos, node, nodePos, event) {
          const target = event.target as HTMLElement | null
          if (!target?.closest('[data-type="mediaTag"]')) return false
          if (node && node.type.name === 'mediaTag') {
            useEditorStore
              .getState()
              .openMediaModal(node.attrs.tag as MediaTag, String(node.attrs.id), nodePos)
          }
          // 返回 false：让 ProseMirror 正常选中节点（NodeSelection），不阻断默认行为
          return false
        }
      }
    })
)
