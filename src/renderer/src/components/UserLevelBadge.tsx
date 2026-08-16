import { userLevelInfo } from '../lib/sanitize'

/** 用户等级徽章（v0.0.10）：按 getLever 展示 Lv0~Lv7，使用应用风格等级配色 */
export function UserLevelBadge({ experience }: { experience?: unknown }): React.JSX.Element | null {
  const info = userLevelInfo(experience)
  if (!info) return null
  return (
    <span className="user-level-badge" style={{ backgroundColor: info.color }}>
      {info.label}
    </span>
  )
}
