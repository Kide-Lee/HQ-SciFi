import { toggleMark } from '@milkdown/kit/prose/commands'
import { $command, $markSchema } from '@milkdown/kit/utils'
import { KAITI_OPEN, KAITI_CLOSE } from '../../../shared/kaiti'

/**
 * v0.0.6：楷体 mark——替代原「斜体」按钮（design.md v0.0.6 样式改进）。
 * 编辑器内以 <span class="kaiti"> 渲染；md 序列化为相同 HTML（开/闭标签包夹文本）；
 * markdown-it（预览/上传）通过白名单规则放行该 span（见 mdPreview.ts / md2html.ts）。
 */

/** 楷体 mark schema */
export const kaitiSchema = $markSchema('kaiti', () => ({
  parseDOM: [{ tag: 'span.kaiti' }],
  toDOM: () => ['span', { class: 'kaiti' }, 0],
  parseMarkdown: {
    match: (node) =>
      node.type === 'html' && (node.value === KAITI_OPEN || node.value === KAITI_CLOSE),
    runner: (state, node, markType) => {
      if (node.value === KAITI_OPEN) state.openMark(markType)
      else state.closeMark(markType)
    }
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'kaiti',
    // 返回 true：阻止文本节点默认渲染，自行输出 开标签 + 文本 + 闭标签；
    // 非文本节点（媒体节点等）不在此处理，交还默认序列化
    runner: (state, _mark, node) => {
      if (!node.isText) return false
      state.addNode('html', undefined, KAITI_OPEN)
      state.addNode('text', undefined, node.text)
      state.addNode('html', undefined, KAITI_CLOSE)
      return true
    }
  }
}))

/** 切换楷体 mark 的命令（工具栏按钮直接调用 toggleKaitiCommand.run()） */
export const toggleKaitiCommand = $command('ToggleKaiti', (ctx) => () => {
  return toggleMark(kaitiSchema.type(ctx))
})
