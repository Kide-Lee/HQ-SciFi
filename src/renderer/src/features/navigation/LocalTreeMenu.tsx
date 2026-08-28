import { useEffect, useRef } from 'react'
import { FolderInput, Pencil } from 'lucide-react'

export interface TreeMenuNode {
  rel: string
  name: string
  isDir: boolean
}

interface LocalTreeMenuProps {
  x: number
  y: number
  node: TreeMenuNode
  onRename: () => void
  onMove: () => void
  onClose: () => void
}

/** 本地文件树右键菜单（重命名/移动入口） */
export function LocalTreeMenu({ x, y, node, onRename, onMove, onClose }: LocalTreeMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [onClose])

  return (
    <div
      ref={ref}
      className="tree-context-menu"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="tree-context-title">{node.name}</div>
      <button className="tree-context-item" onClick={() => { onClose(); onRename() }}>
        <Pencil size={13} /> 重命名
      </button>
      <button className="tree-context-item" onClick={() => { onClose(); onMove() }}>
        <FolderInput size={13} /> 移动
      </button>
    </div>
  )
}
