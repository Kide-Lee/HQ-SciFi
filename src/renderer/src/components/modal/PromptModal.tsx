import { useEffect, useState } from 'react'

interface PromptModalProps {
  open: boolean
  /** 弹窗标题（如「新建草稿」「插入链接」） */
  title: string
  placeholder?: string
  /** 初始值（编辑场景可预填） */
  initial?: string
  /** 校验：返回错误文案则禁止确定（返回 null 通过） */
  validate?: (value: string) => string | null
  onClose: () => void
  onConfirm: (value: string) => void
}

/**
 * v0.0.8：单输入文本弹窗——替代 window.prompt（Electron 渲染进程不支持 prompt）。
 * 用于侧栏「新建草稿」标题、编辑器「插入链接」地址等单行输入场景；
 * 复用发布/媒体弹窗的 backdrop 与按钮样式，Enter 确认、自动聚焦。
 */
export function PromptModal({
  open,
  title,
  placeholder,
  initial,
  validate,
  onClose,
  onConfirm
}: PromptModalProps): React.JSX.Element | null {
  const [value, setValue] = useState(initial ?? '')

  // 打开时重置为初始值（编辑场景预填；插入场景为空）
  useEffect(() => {
    if (open) setValue(initial ?? '')
  }, [open, initial])

  if (!open) return null

  const trimmed = value.trim()
  const error = validate ? validate(trimmed) : null
  const confirm = (): void => {
    if (!trimmed || error) return
    onConfirm(trimmed)
  }

  return (
    <div className="publish-modal-backdrop" onClick={onClose}>
      <div className="publish-modal prompt-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="publish-modal-title">{title}</h3>
        <input
          className="prompt-input"
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') confirm()
          }}
        />
        {error && <div className="prompt-error">{error}</div>}
        <div className="publish-modal-actions">
          <button type="button" className="toolbar-btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="toolbar-btn primary"
            disabled={!trimmed || !!error}
            onClick={confirm}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
