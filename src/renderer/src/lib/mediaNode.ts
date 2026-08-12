import { $command, $node } from '@milkdown/kit/utils'

/**
 * v0.0.6：荒启媒体标签节点（音乐/视频）。
 * 荒启正文用方括号标签语法存储媒体（阅读端 expandMediaTags 展开为 iframe）：
 *   [music 163]ID[/music 163]、[music qq]ID[/music qq]、[video bilibili]BV[/video bilibili]
 * 直接以纯文本插入会被 milkdown 序列化转义方括号（\[music 163]…），故建模为原子节点：
 * 编辑器内显示标签原文；序列化走 htmlInline（remark 不转义 HTML 值）保证往返一致。
 */

export const MEDIA_TAGS = ['music 163', 'music qq', 'video bilibili'] as const
export type MediaTag = (typeof MEDIA_TAGS)[number]

const MEDIA_RE = /^\[(music 163|music qq|video bilibili)\]([^\]]+)\[\/(?:music 163|music qq|video bilibili)\]$/

/** 媒体节点 schema */
export const mediaNode = $node('mediaTag', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  attrs: {
    tag: { default: 'music 163' },
    id: { default: '' }
  },
  parseDOM: [
    {
      tag: 'span[data-media]',
      getAttrs: (dom) => {
        const el = dom as HTMLElement
        return { tag: el.dataset.media, id: el.dataset.id ?? '' }
      }
    }
  ],
  toDOM: (node) => {
    const tag = node.attrs.tag as MediaTag
    const id = node.attrs.id as string
    return ['span', { class: 'media-tag', 'data-media': tag, 'data-id': id }, `[${tag}]${id}[/${tag}]`]
  },
  parseMarkdown: {
    match: (node) => node.type === 'text' && MEDIA_RE.test(String(node.value ?? '')),
    runner: (state, node, nodeType) => {
      const m = MEDIA_RE.exec(String(node.value ?? ''))
      if (m) state.addNode(nodeType, { tag: m[1], id: m[2] })
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'mediaTag',
    runner: (state, node) => {
      const tag = node.attrs.tag as MediaTag
      const id = node.attrs.id as string
      // mdast html 节点值原样输出（remark 不转义），保证 [music 163] 等标签不被 milkdown 转义
      state.addNode('html', undefined, `[${tag}]${id}[/${tag}]`)
    }
  }
}))

/** 插入媒体节点命令（工具栏：音乐/视频按钮） */
export const insertMediaCommand = $command(
  'InsertMedia',
  (ctx) =>
    (payload: { tag: MediaTag; id: string } = { tag: 'music 163', id: '' }) =>
    (state, dispatch): boolean => {
      if (!dispatch) return false
      const nodeType = mediaNode.type(ctx)
      const node = nodeType.create({ tag: payload.tag, id: payload.id })
      // 插入媒体为独立操作：清空残留 storedMarks（避免 kaiti 等输入 mark 包裹媒体节点）
      const tr = state.tr.replaceSelectionWith(node).setStoredMarks([])
      dispatch(tr)
      return true
    }
)

/** 校验并规范化媒体 ID：音乐 = 纯数字；B 站视频 = BV 号 */
export function normalizeMediaInput(tag: MediaTag, raw: string): string | null {
  const v = raw.trim()
  if (tag === 'video bilibili') return /^BV[0-9A-Za-z]{6,20}$/i.test(v) ? v : null
  return /^\d{3,20}$/.test(v) ? v : null
}
