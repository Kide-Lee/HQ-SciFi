import { useEffect, useState } from 'react'
import { normalizeMediaInput } from '../lib/mediaNode'
import { mediaPlayerUrl } from '../lib/sanitize'

interface VideoModalProps {
  open: boolean
  /** 当前 BV 号（编辑模式预填） */
  id: string
  /** 编辑目标节点位置（null=插入模式） */
  pos: number | null
  onClose: () => void
  /** 确认插入/保存（payload.id）；payload 为 null = 删除媒体（仅编辑模式） */
  onConfirm: (payload: { tag: 'video bilibili'; id: string } | null) => void
}

/**
 * v0.0.8：插入/编辑视频弹窗（独立于音乐弹窗）。
 * B 站 BV 号输入，实时校验并内嵌播放器 iframe 实时预览。
 * 替代 window.prompt（Electron 渲染进程不支持 prompt）。
 */
export function VideoModal({ open, id, pos, onClose, onConfirm }: VideoModalProps): React.JSX.Element | null {
  const [mediaId, setMediaId] = useState(id)

  // 打开时按当前 id 重置表单（编辑模式预填；插入模式为空）
  useEffect(() => {
    if (open) setMediaId(id)
  }, [open, id])

  const validId = normalizeMediaInput('video bilibili', mediaId)
  const previewUrl = mediaPlayerUrl('video bilibili', mediaId.trim())

  if (!open) return null

  return (
    <div className="publish-modal-backdrop" onClick={onClose}>
      <div className="publish-modal media-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="publish-modal-title">{pos != null ? '编辑视频' : '插入视频'}</h3>
        <input
          className="media-input"
          autoFocus
          value={mediaId}
          onChange={(e) => setMediaId(e.target.value)}
          placeholder="B 站视频 BV 号（如 BV1xx411c7mD）"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && validId) onConfirm({ tag: 'video bilibili', id: validId })
          }}
        />
        <div className="media-preview">
          {previewUrl ? (
            <iframe
              className="hqsf-media"
              src={previewUrl}
              title="视频预览"
              width="100%"
              height="420"
              scrolling="no"
              frameBorder="0"
              allowFullScreen
            />
          ) : (
            <span className="media-preview-empty muted">输入合法的 BV 号后在此预览</span>
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
            onClick={() => onConfirm({ tag: 'video bilibili', id: validId! })}
          >
            {pos != null ? '保存' : '插入'}
          </button>
        </div>
      </div>
    </div>
  )
}
