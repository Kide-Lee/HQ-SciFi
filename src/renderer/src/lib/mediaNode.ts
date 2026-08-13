import { $command, $node } from '@milkdown/kit/utils'
import { mediaPlayerUrl } from './sanitize'

/**
 * v0.0.6：荒启媒体标签节点（音乐/视频）。
 * 荒启正文用方括号标签语法存储媒体（阅读端 expandMediaTags 展开为 iframe）：
 *   [music 163]ID[/music 163]、[music qq]ID[/music qq]、[video bilibili]BV[/video bilibili]
 * 直接以纯文本插入会被 milkdown 序列化转义方括号（\[music 163]…），故建模为原子节点：
 * 编辑器内显示标签原文；序列化走 htmlInline（remark 不转义 HTML 值）保证往返一致。
 * v0.0.8：可视化模式把合法媒体展开为真实播放器 iframe（点击「编辑」chip 打开弹窗重编辑），
 * 非法/未知 ID 回退显示标签原文。
 */

export const MEDIA_TAGS = ['music 163', 'music qq', 'video bilibili'] as const
export type MediaTag = (typeof MEDIA_TAGS)[number]

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
    const url = mediaPlayerUrl(tag, id)
    if (!url) {
      // 非法/未知媒体：回退标签原文（点击仍可打开弹窗修正）
      return [
        'span',
        { class: 'media-tag', 'data-media': tag, 'data-id': id, 'data-type': 'mediaTag', contenteditable: 'false' },
        `[${tag}]${id}[/${tag}]`
      ]
    }
    const isVideo = tag === 'video bilibili'
    return [
      'span',
      {
        class: `media-player${isVideo ? ' media-video' : ''}`,
        'data-media': tag,
        'data-id': id,
        'data-type': 'mediaTag',
        contenteditable: 'false',
        title: `[${tag}]${id}[/${tag}]`
      },
      [
        'iframe',
        {
          class: 'hqsf-media',
          src: url,
          ...(isVideo
            ? { width: '100%', height: '420', scrolling: 'no', frameborder: 'no', allowfullscreen: 'true', border: '0' }
            : { width: '330', height: tag === 'music qq' ? '66' : '86', frameborder: 'no', border: '0', marginwidth: '0', marginheight: '0' })
        }
      ],
      ['span', { class: 'media-edit-chip', 'data-media-edit': '', title: '编辑媒体' }, '编辑']
    ]
  },
  // 注意：parseMarkdown 仅作占位（NodeSchema 类型必填）——milkdown 的 parser 按 schema
  // 节点注册顺序用 `.find()` 找处理者，commonmark 的 text 节点 match 恒真且注册在先，
  // 文本节点永远轮不到这里（2026-08-14 实测）；正文标签 → 节点转换由 mediaParsePlugin
  // 在 ProseMirror 视图创建时完成（支持与正文混排的多个标签）。
  parseMarkdown: {
    match: (node) => (node as { type?: string }).type === 'mediaTag', // 仅占位：不存在该 mdast 类型
    runner: (state, node, nodeType) => {
      const n = node as { tag?: string; id?: string }
      state.addNode(nodeType, { tag: n.tag ?? 'music 163', id: n.id ?? '' })
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

/** 校验并规范化媒体 ID：音乐 = 纯数字；B 站视频 = 大写 BV 号（与阅读端展开正则一致） */
export function normalizeMediaInput(tag: MediaTag, raw: string): string | null {
  const v = raw.trim()
  if (tag === 'video bilibili') return /^BV[0-9A-Za-z]{6,20}$/.test(v) ? v : null
  return /^\d{3,20}$/.test(v) ? v : null
}
