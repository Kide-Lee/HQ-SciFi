/**
 * v1.1.12：未提交草稿的恢复提示条。
 *
 * 仅在「挂载时从缓存恢复出了内容」这一意外场景出现（用户自己正在输入时不会冒出来）：
 * 在输入框上方说明内容来自上次未提交的草稿，并给一个一次性的「丢弃草稿」入口。
 */
export function DraftRestoredHint({ onDiscard }: { onDiscard: () => void }): React.JSX.Element {
  return (
    <div className="draft-restored-hint">
      <span>已恢复上次未提交的草稿</span>
      <button type="button" className="draft-discard" onClick={onDiscard}>
        丢弃草稿
      </button>
    </div>
  )
}
