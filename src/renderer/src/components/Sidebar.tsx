import { useEffect, useState } from 'react'
import { SECTION_LABELS, TopSection, useUiStore } from '../stores/ui'
import { useAuthStore } from '../stores/auth'
import { useDocsStore } from '../stores/docs'
import { useEditorStore } from '../stores/editor'
import type { ArticleRow } from '../../../shared/types'

const SECTIONS: TopSection[] = ['writing', 'recommend', 'serial', 'activity', 'library']

const SECTION_TREE: Record<Exclude<TopSection, 'writing'>, string[]> = {
  recommend: ['AI模型', '精选'],
  serial: ['合集', '连载'],
  activity: ['荒启练笔第二十四期', '荒启练笔第二十三期', '荒启练笔第二十二期', '……'],
  library: ['原创作品', '科幻杂谈', '官方公告', '外文翻译']
}

/** 远端四态分组定义 */
const REMOTE_GROUPS: Array<{ key: ArticleRow['type']; label: string }> = [
  { key: 'post_draft', label: '草稿' },
  { key: 'waiting', label: '待审核' },
  { key: 'post', label: '已发布' },
  { key: 'reject', label: '已拒绝' }
]

export function Sidebar(): React.JSX.Element {
  const section = useUiStore((s) => s.section)
  const selectedId = useUiStore((s) => s.selectedId)
  const setSection = useUiStore((s) => s.setSection)
  const setSelectedId = useUiStore((s) => s.setSelectedId)

  const session = useAuthStore((s) => s.session)
  const logout = useAuthStore((s) => s.logout)
  const articles = useDocsStore((s) => s.articles)
  const localTree = useDocsStore((s) => s.localTree)
  const refreshLocal = useDocsStore((s) => s.refreshLocal)
  const refreshArticles = useDocsStore((s) => s.refreshArticles)
  const pull = useDocsStore((s) => s.pull)
  const pulling = useDocsStore((s) => s.pulling)
  const lastPull = useDocsStore((s) => s.lastPull)
  const openDoc = useEditorStore((s) => s.open)
  const currentPath = useEditorStore((s) => s.currentPath)

  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    void refreshLocal()
    void refreshArticles()
  }, [refreshLocal, refreshArticles])

  async function handleOpenLocal(path: string): Promise<void> {
    setSelectedId(path)
    await openDoc(path)
  }

  function handleOpenRemote(row: ArticleRow): void {
    if (row.filePath) {
      void handleOpenLocal(row.filePath)
      return
    }
    setSelectedId(`remote:${row.cid}`)
    // M1 无本地文件的远端文章（待审核/已发布/已拒绝）阅读视图 M2 接入
    alert(`「${row.title}」的阅读视图将在 M2 接入`)
  }

  const nickname = String(session?.userinfo?.nickname ?? session?.userinfo?.nick ?? '用户')
  const uid = session?.userinfo?.uid ? `UID ${String(session.userinfo.uid)}` : '已登录'

  const groups: Record<string, ArticleRow[]> = {
    post_draft: [],
    waiting: [],
    post: [],
    reject: []
  }
  for (const a of articles) if (groups[a.type]) groups[a.type].push(a)

  function toggleExpand(key: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const isWriting = section === 'writing'

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="user-card">
          <div className="avatar">{nickname.slice(0, 1)}</div>
          <div className="user-meta">
            <div className="nickname">{nickname}</div>
            <div className="intro">{uid}</div>
          </div>
          <button className="logout-btn" title="退出登录" onClick={() => void logout()}>
            退出
          </button>
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
        {isWriting ? (
          <div className="writing-tree">
            <div className="tree-toolbar">
              <button className="sync-btn" disabled={pulling} onClick={() => void pull()} title="从荒启拉取草稿与状态">
                {pulling ? '同步中 …' : '⇅ 同步'}
              </button>
              {lastPull && (
                <span className="sync-summary" title={lastPull.errors.join('\n') || undefined}>
                  拉取 {lastPull.pulled} · 冲突 {lastPull.conflicts}
                  {lastPull.errors.length > 0 ? ` · ${lastPull.errors.length} 处失败` : ''}
                </span>
              )}
            </div>

            {/* 本地存档 */}
            <div className="tree-group">
              <button className="tree-group-title" onClick={() => toggleExpand('local')}>
                <span className="caret">{expanded.has('local') ? '▾' : '▸'}</span> 本地存档
              </button>
              {expanded.has('local') && (
                <div className="tree-group-body">
                  {localTree.length === 0 && <div className="tree-empty muted">（空目录，点「+ 新建草稿」开始）</div>}
                  {localTree.map((node) =>
                    node.isDir ? (
                      <div key={node.path} className="tree-dir">{node.name}</div>
                    ) : (
                      <button
                        key={node.path}
                        className={`tree-node ${currentPath === node.path ? 'active' : ''}`}
                        onClick={() => void handleOpenLocal(node.path)}
                        title={node.path}
                      >
                        {node.name.replace(/\.md$/i, '')}
                      </button>
                    )
                  )}
                </div>
              )}
            </div>

            {/* 远端四态 */}
            {REMOTE_GROUPS.map(({ key, label }) => (
              <div className="tree-group" key={key}>
                <button className="tree-group-title" onClick={() => toggleExpand(key)}>
                  <span className="caret">{expanded.has(key) ? '▾' : '▸'}</span>
                  {label}
                  {groups[key].length > 0 && <span className="count">{groups[key].length}</span>}
                </button>
                {expanded.has(key) && (
                  <div className="tree-group-body">
                    {groups[key].length === 0 && <div className="tree-empty muted">（暂无）</div>}
                    {groups[key].map((row) => (
                      <button
                        key={row.cid}
                        className={`tree-node ${selectedId === `remote:${row.cid}` ? 'active' : ''}`}
                        onClick={() => handleOpenRemote(row)}
                        title={row.filePath || `${label}（无本地文件）`}
                      >
                        {row.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          SECTION_TREE[section as Exclude<TopSection, 'writing'>].map((node) => (
            <button
              key={node}
              className={`tree-node ${selectedId === node ? 'active' : ''}`}
              onClick={() => setSelectedId(node)}
            >
              {node}
            </button>
          ))
        )}
      </div>

      <div className="sidebar-bottom">
        <button className="settings-btn" title="设置（颜色/字号/字体）">
          ⚙ 设置
        </button>
      </div>
    </aside>
  )
}
