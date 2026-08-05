import { SECTION_LABELS, TopSection, useUiStore } from '../stores/ui'

/** 各栏目下部分的文件树静态定义（M0 占位，后续接真实数据） */
const TREE: Record<TopSection, string[]> = {
  writing: ['本地存档', '已发布', '待审核', '已拒绝'],
  recommend: ['AI模型', '精选'],
  serial: ['合集', '连载'],
  activity: ['荒启练笔第二十四期', '荒启练笔第二十三期', '荒启练笔第二十二期', '……'],
  library: ['原创作品', '科幻杂谈', '官方公告', '外文翻译']
}

const SECTIONS: TopSection[] = ['writing', 'recommend', 'serial', 'activity', 'library']

export function Sidebar(): React.JSX.Element {
  const section = useUiStore((s) => s.section)
  const selectedId = useUiStore((s) => s.selectedId)
  const setSection = useUiStore((s) => s.setSection)
  const setSelectedId = useUiStore((s) => s.setSelectedId)

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        {/* 用户区（M0 未登录占位） */}
        <div className="user-card">
          <div className="avatar">未</div>
          <div className="user-meta">
            <div className="nickname">未登录</div>
            <div className="intro">登录后同步草稿与作品</div>
          </div>
        </div>

        <nav className="nav-sections">
          {SECTIONS.map((key) => (
            <button
              key={key}
              className={`nav-item ${section === key ? 'active' : ''}`}
              onClick={() => setSection(key)}
            >
              {SECTION_LABELS[key]}
            </button>
          ))}
        </nav>
      </div>

      <div className="tree-area">
        {TREE[section].map((node) => (
          <button
            key={node}
            className={`tree-node ${selectedId === node ? 'active' : ''}`}
            onClick={() => setSelectedId(node)}
          >
            {node}
          </button>
        ))}
      </div>

      <div className="sidebar-bottom">
        <button className="settings-btn" title="设置（颜色/字号/字体）">
          ⚙ 设置
        </button>
      </div>
    </aside>
  )
}
