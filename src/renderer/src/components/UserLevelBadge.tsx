import { userLevelInfo } from '../lib/sanitize'

/** 用户等级徽章（v0.0.10）：对齐官网 getLever 的 Lv0~Lv7 展示 */
export function UserLevelBadge({ experience }: { experience?: unknown }): React.JSX.Element | null {
  const info = userLevelInfo(experience)
  if (!info) return null
  return (
    <span className="user-level-badge" style={{ backgroundColor: info.color }}>
      {info.label}
    </span>
  )
}
