import { useEffect, useState } from 'react'
import { normalizeMediaInput } from '../lib/mediaNode'
import { mediaPlayerUrl } from '../lib/sanitize'

interface MusicModalProps {
  open: boolean
  /** 当前平台标签（music 163=网易云 / music qq=QQ 音乐）；插入模式由工具栏预设，编辑模式来自节点 */
  tag: 'music 163' | 'music qq'
  /** 当前歌曲/歌单 ID（编辑模式预填） */
  id: string
  /** 编辑目标节点位置（null=插入模式） */
  pos: number | null
  onClose: () => void
  /** 确认插入/保存（payload.tag/id）；payload 为 null = 删除媒体（仅编辑模式） */
  onConfirm: (payload: { tag: 'music 163' | 'music qq'; id: string } | null) => void
}

/**
 * v0.0.8：插入/编辑音乐弹窗（独立于视频弹窗）。
 * 网易云 / QQ 音乐平台切换 + 歌曲/歌单 ID 输入，实时校验并内嵌播放器 iframe 实时预览。
 * 替代 window.prompt（Electron 渲染进程不支持 prompt）。
 */
export function MusicModal({ open, tag, id, pos, onClose, onConfirm }: MusicModalProps): React.JSX.Element | null {
  const [platform, setPlatform] = useState<'163' | 'qq'>(tag === 'music qq' ? 'qq' : '163')
  const [mediaId, setMediaId] = useState(id)

  // 打开时按当前 tag/id 重置表单（编辑模式预填；插入模式用工具栏预设）
  useEffect(() => {
    if (!open) return
    setPlatform(tag === 'music qq' ? 'qq' : '163')
    setMediaId(id)
  }, [open, tag, id])

  const currentTag: 'music 163' | 'music qq' = platform === 'qq' ? 'music qq' : 'music 163'
  const validId = normalizeMediaInput(currentTag, mediaId)
  const previewUrl = mediaPlayerUrl(currentTag, mediaId.trim())

  if (!open) return null

  return (
    <div className="publish-modal-backdrop" onClick={onClose}>
      <div className="publish-modal media-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="publish-modal-title">{pos != null ? '编辑音乐' : '插入音乐'}</h3>
        <div className="media-seg">
          {(
            [
              ['163', '网易云音乐'],
              ['qq', 'QQ 音乐']
            ] as const
          ).map(([p, label]) => (
            <button
              key={p}
              type="button"
              className={`media-seg-btn${platform === p ? ' active' : ''}`}
              onClick={() => setPlatform(p)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          className="media-input"
          autoFocus
          value={mediaId}
          onChange={(e) => setMediaId(e.target.value)}
          placeholder="歌曲/歌单 ID（纯数字，如 29764595）"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && validId) onConfirm({ tag: currentTag, id: validId })
          }}
        />
        <div className="media-preview">
          {previewUrl ? (
            <iframe
              className="hqsf-media"
              src={previewUrl}
              title="音乐预览"
              width="330"
              height={currentTag === 'music qq' ? '66' : '86'}
              frameBorder="0"
            />
          ) : (
            <span className="media-preview-empty muted">输入合法的歌曲/歌单 ID 后在此预览</span>
          )}
        </div>
        <div className="publish-modal-actions">
          <button type="button" className="toolbar-btn" onClick={onClose}>
            取消
          </button>
          {pos != null && (
            <button type="button" className="toolbar-btn media-delete" onClick={() => onConfirm(null)}>
              删除
            </button>
          )}
          <button
            type="button"
            className="toolbar-btn primary"
            disabled={!validId}
            onClick={() => onConfirm({ tag: currentTag, id: validId! })}
          >
            {pos != null ? '保存' : '插入'}
          </button>
        </div>
      </div>
    </div>
  )
}
