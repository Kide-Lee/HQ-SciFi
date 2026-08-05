import { useEffect, useState } from 'react'
import { SECTION_LABELS, TopSection, useUiStore } from '../stores/ui'
import { useAuthStore } from '../stores/auth'
import { useDocsStore } from '../stores/docs'
import { useEditorStore } from '../stores/editor'
import { useReaderStore } from '../stores/reader'
import type { ArticleRow, MetaInfo } from '../../../shared/types'

const SECTIONS: TopSection[] = ['writing', 'recommend', 'serial', 'activity', 'library']

/** 作品库分类节点（M2 动态拉取 metasList type=category 后填充） */
const LIBRARY_DEFAULT = ['原创作品', '科幻杂谈', '官方公告', '外文翻译']

/** 推荐栏目：固定子节点（精选=choiceList / AI模型=gptList） */
const RECOMMEND_NODES = [
  { key: 'choice', label: '精选' },
  { key: 'gpt', label: 'AI模型' }
] as const

/** 连载栏目：两组 metas（serial=连载 / collection=合集） */
const SERIAL_GROUPS: Array<{ type: string; label: string }> = [
  { type: 'serial', label: '连载' },
  { type: 'collection', label: '合集' }
]

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
  const openList = useUiStore((s) => s.openList)

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
  const openArticle = useReaderStore((s) => s.openArticle)
  const closeArticle = useReaderStore((s) => s.closeArticle)
  const readingCid = useReaderStore((s) => s.readingCid)

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /** 作品库分类（metasList type=category 实测返回 mid，作为列表过滤参数） */
  const [libraryCats, setLibraryCats] = useState<Array<{ mid: number | string; name: string }>>([])
  /** 连载栏目：serial/collection 两组 metas */
  const [serialMetas, setSerialMetas] = useState<Record<string, MetaInfo[]>>({})
  /** 活动栏目：active metas（练笔期次） */
  const [activeMetas, setActiveMetas] = useState<MetaInfo[]>([])
  /** metas 拉取失败标记（避免反复重试） */
  const [metasError, setMetasError] = useState<string | null>(null)

  // 打开/新建本地文档时自动展开「本地存档」组，确保当前文件在树中可见
  useEffect(() => {
    if (currentPath) {
      setExpanded((prev) => (prev.has('local') ? prev : new Set(prev).add('local')))
    }
  }, [currentPath])

  useEffect(() => {
    void refreshLocal()
    void refreshArticles()
  }, [refreshLocal, refreshArticles])

  // 首次进入作品库时拉真实分类列表（含 mid）
  useEffect(() => {
    if (section === 'library' && libraryCats.length === 0) {
      void window.hqsf.listCategories().then((res) => {
        if (res.ok && res.data.length > 0) {
          setLibraryCats(res.data.map((c) => ({ mid: c.mid, name: c.name })))
        }
      })
    }
  }, [section, libraryCats.length])

  // 切换栏目时重置 metas 拉取错误（避免一个栏目的失败阻塞另一个栏目）
  useEffect(() => {
    setMetasError(null)
  }, [section])

  // 首次进入连载/活动栏目时拉 metas（serial+collection / active），失败提示一次
  useEffect(() => {
    if (section === 'serial' && Object.keys(serialMetas).length === 0 && !metasError) {
      void Promise.all(
        SERIAL_GROUPS.map((g) =>
          window.hqsf.listMetas(g.type).then((res) => ({ type: g.type, res }))
        )
      ).then((results) => {
        const next: Record<string, MetaInfo[]> = {}
        let failed: string | null = null
        for (const { type, res } of results) {
          if (res.ok) next[type] = res.data
          else failed = res.error
        }
        setSerialMetas(next)
        if (failed) setMetasError(failed)
      })
    }
    if (section === 'activity' && activeMetas.length === 0 && !metasError) {
      void window.hqsf.listMetas('active').then((res) => {
        if (res.ok) setActiveMetas(res.data)
        else setMetasError(res.error)
      })
    }
  }, [section, serialMetas, activeMetas, metasError])

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
    void openArticle(row.cid)
  }

  /** 打开作品库分类列表 */
  function handleOpenLibraryCat(name: string, mid?: number | string): void {
    closeArticle()
    openList({ title: name, ...(mid != null ? { mid } : { searchParams: { type: 'post' } }) })
  }

  /** 打开连载/活动/题材等 metas 栏目文章列表（mid 走 selectContents） */
  function handleOpenMeta(name: string, mid: number | string): void {
    closeArticle()
    openList({ title: name, mid })
  }

  /** 打开推荐子节点：精选（choiceList）/ AI模型（gpt 卡片） */
  function handleOpenRecommend(key: 'choice' | 'gpt'): void {
    closeArticle()
    if (key === 'choice') openList({ title: '精选', choice: true })
    else openList({ title: 'AI模型', kind: 'gpt' })
  }

  const info = session?.userinfo ?? {}
  // 字段名以荒启实测为准，做多形态容错（昵称/头像/uid）
  const nickname = String(
    info.nickname ?? info.nick ?? info.nickName ?? info.userName ?? info.name ?? '用户'
  )
  const uidValue = info.uid ?? info.id ?? info.userId
  const uid = uidValue != null ? `UID ${String(uidValue)}` : '已登录'
  const avatar = info.avatar ?? info.headImg ?? info.headImgUrl ?? info.avatarUrl

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
          <div className="avatar">
            {avatar ? (
              <img className="avatar-img" src={String(avatar)} alt="" referrerPolicy="no-referrer" />
            ) : (
              nickname.slice(0, 1)
            )}
          </div>
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
              onClick={() => {
                closeArticle()
                setSection(key)
              }}
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
              <button
                className="sync-btn"
                onClick={() => {
                  void window.hqsf.openDocsDir().then((res) => {
                    if (!res.ok) alert(`打开存档目录失败: ${res.error}`)
                  })
                }}
                title="在系统文件管理器中打开本地存档目录"
              >
                📂 打开目录
              </button>
            </div>
            {lastPull && (
              <div className="sync-summary">
                拉取 {lastPull.pulled} · 冲突 {lastPull.conflicts}
                {lastPull.errors.length > 0
                  ? ` · 失败 ${lastPull.errors.length} 处（详情见编辑器顶部）`
                  : ''}
              </div>
            )}

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
        ) : section === 'recommend' ? (
          RECOMMEND_NODES.map((node) => (
            <button
              key={node.key}
              className={`tree-node ${selectedId === node.label ? 'active' : ''}`}
              onClick={() => handleOpenRecommend(node.key)}
            >
              {node.label}
            </button>
          ))
        ) : section === 'serial' ? (
          <div className="tree-area-inner">
            {metasError && <div className="tree-empty muted">栏目加载失败：{metasError}</div>}
            {SERIAL_GROUPS.map((g) => {
              const metas = serialMetas[g.type]
              const has = metas && metas.length > 0
              return (
                <div className="tree-group" key={g.type}>
                  <button
                    className="tree-group-title"
                    onClick={() => toggleExpand(`serial:${g.type}`)}
                  >
                    <span className="caret">{expanded.has(`serial:${g.type}`) ? '▾' : '▸'}</span> {g.label}
                    {has && <span className="count">{metas!.length}</span>}
                  </button>
                  {expanded.has(`serial:${g.type}`) && (
                    <div className="tree-group-body">
                      {!has && <div className="tree-empty muted">（加载中 …）</div>}
                      {has &&
                        metas!.map((m) => (
                          <button
                            key={m.mid}
                            className={`tree-node ${selectedId === m.name ? 'active' : ''}`}
                            onClick={() => handleOpenMeta(m.name, m.mid)}
                            title={m.description || m.name}
                          >
                            {m.name}
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : section === 'activity' ? (
          <div className="tree-area-inner">
            {metasError && <div className="tree-empty muted">栏目加载失败：{metasError}</div>}
            <div className="tree-group">
              <button
                className="tree-group-title"
                onClick={() => toggleExpand('activity')}
              >
                <span className="caret">{expanded.has('activity') ? '▾' : '▸'}</span> 练笔活动
                {activeMetas.length > 0 && <span className="count">{activeMetas.length}</span>}
              </button>
              {expanded.has('activity') && (
                <div className="tree-group-body">
                  {activeMetas.length === 0 && <div className="tree-empty muted">（加载中 …）</div>}
                  {activeMetas.map((m) => (
                    <button
                      key={m.mid}
                      className={`tree-node ${selectedId === m.name ? 'active' : ''}`}
                      onClick={() => handleOpenMeta(m.name, m.mid)}
                      title={m.description || m.name}
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          (libraryCats.length > 0
            ? libraryCats.map((c) => ({ mid: c.mid as number | string | undefined, name: c.name }))
            : LIBRARY_DEFAULT.map((n) => ({ mid: undefined, name: n }))
          ).map((cat) => (
            <button
              key={cat.name}
              className={`tree-node ${selectedId === cat.name ? 'active' : ''}`}
              onClick={() => handleOpenLibraryCat(cat.name, cat.mid)}
            >
              {cat.name}
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
