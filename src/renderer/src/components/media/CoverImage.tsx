import { useState } from 'react'
import { ImageOff } from 'lucide-react'

/**
 * v0.0.3：封面图——加载失败时显示灰底 + 占位图标（替换浏览器破图图标）。
 * className 沿用各封面容器样式（如 meta-card-cover / activity-card-cover），
 * 失败态渲染为 div 并叠加 .cover-fallback（flex 居中 + 图标）。
 */
export function CoverImage({
  src,
  className,
  alt
}: {
  src?: string
  className?: string
  alt?: string
}): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return (
      <div className={`cover-fallback ${className ?? ''}`} role="img" aria-label={alt ?? ''}>
        <ImageOff size={18} />
      </div>
    )
  }
  return (
    <img
      className={className}
      src={src}
      alt={alt ?? ''}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}
