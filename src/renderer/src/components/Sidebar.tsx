import { useEffect, useState } from 'react'
import {
  BookOpen,
  CalendarDays,
  ChevronRight,
  Layers,
  PenLine,
  RefreshCw,
  Settings,
  Sparkles
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { SECTION_LABELS, TopSection, useUiStore } from '../stores/ui'
import { useAuthStore } from '../stores/auth'
import { useDocsStore } from '../stores/docs'
import { useEditorStore } from '../stores/editor'
import { useReaderStore } from '../stores/reader'
import { sortActivities, activityPhase, ACTIVITY_PHASE_LABEL } from '../lib/activity'
import type { ArticleRow, MetaInfo, RemoteArticle } from '../../../shared/types'

const SECTIONS: TopSection[] = ['writing', 'recommend', 'serial', 'activity', 'library']

/** v0.0.3：左栏五个模块图标 */
const SECTION_ICONS: Record<TopSection, LucideIcon> = {
  writing: PenLine,
  recommend: Sparkles,
  serial: Layers,
  activity: CalendarDays,
  library: BookOpen
}

/** v0.0.3：左栏宽度约束（拖动调整） */
const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 380
const SIDEBAR_DEFAULT = 220

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
  const revealTarget = useUiStore((s) => s.revealTarget)
  const setRevealTarget = useUiStore((s) => s.setRevealTarget)

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
  const reviewTaskByCid = useReaderStore((s) => s.reviewTaskByCid)
  const loadReviewTasks = useReaderStore((s) => s.loadReviewTasks)

  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // v0.0.3：左栏折叠状态提升到 ui store（顶栏按钮切换，localStorage 持久化）
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('hqsf-sidebar-width'))
    return v >= SIDEBAR_MIN && v <= SIDEBAR_MAX ? v : SIDEBAR_DEFAULT
  })

  useEffect(() => {
    localStorage.setItem('hqsf-sidebar-width', String(sidebarWidth))
  }, [sidebarWidth])

  // v0.0.3：拖动左栏右缘调整宽度
  const [resizing, setResizing] = useState(false)
  function onSidebarResizeDown(e: React.MouseEvent): void {
    e.preventDefault()
    setResizing(true)
    const onMove = (ev: MouseEvent): void => {
      setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX)))
    }
    const onUp = (): void => {
      setResizing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  /** 作品库分类（metasList type=category 实测返回 mid，作为列表过滤参数） */
  const [libraryCats, setLibraryCats] = useState<Array<{ mid: number | string; name: string }>>([])
  /** 连载栏目：serial/collection 两组 metas */
  const [serialMetas, setSerialMetas] = useState<Record<string, MetaInfo[]>>({})
  /** 活动栏目：active metas（练笔期次） */
  const [activeMetas, setActiveMetas] = useState<MetaInfo[]>([])
  /** 活动树子项：mid → 该活动文章（selectContents 拉取，按标题排序） */
  const [activityArticles, setActivityArticles] = useState<Record<string, RemoteArticle[]>>({})
  /** 活动树子项加载中（懒加载标记） */
  const [activityLoading, setActivityLoading] = useState<Set<string>>(new Set())
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

  // v0.0.2：登录后全局拉取一次评审任务（活动红点计数 / 文章卡片 / 活动树标记共用；幂等）
  useEffect(() => {
    void loadReviewTasks()
  }, [loadReviewTasks])

  // v0.0.2：从文章标签跳转后，左栏定位到该文章标题（展开活动组 + 懒加载文章；
  // 高亮由 revealTarget.cid 判定，不依赖 selectedId——openList 会覆盖 selectedId）
  useEffect(() => {
    if (!revealTarget || revealTarget.section !== 'activity' || revealTarget.mid == null) return
    const midKey = String(revealTarget.mid)
    setExpanded((prev) => (prev.has(`active:${midKey}`) ? prev : new Set(prev).add(`active:${midKey}`)))
    // 懒加载该活动文章（与 toggleActivity 同一逻辑）
    if (!activityArticles[midKey] && !activityLoading.has(midKey)) {
      setActivityLoading((prev) => new Set(prev).add(midKey))
      void window.hqsf
        .listRemoteArticles({ mid: revealTarget.mid, limit: 100, order: 'created' })
        .then((res) => {
          setActivityLoading((prev) => {
            const next = new Set(prev)
            next.delete(midKey)
            return next
          })
          if (res.ok) {
            const sorted = [...res.data.items].sort((a, b) =>
              a.title.localeCompare(b.title, 'zh-Hans-CN')
            )
            setActivityArticles((prev) => ({ ...prev, [midKey]: sorted }))
          }
        })
        .catch(() => {
          setActivityLoading((prev) => {
            const next = new Set(prev)
            next.delete(midKey)
            return next
          })
        })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTarget?.section, revealTarget?.mid, revealTarget?.cid])

  // v0.0.2：定位目标文章节点渲染完成后滚动到它（revealTarget.cid 判定）
  useEffect(() => {
    const cid = revealTarget?.section === 'activity' ? revealTarget.cid : null
    if (!cid) return
    const el = document.querySelector(`[data-cid="${CSS.escape(cid)}"]`)
    el?.scrollIntoView({ block: 'nearest' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTarget?.section, revealTarget?.cid, activityArticles])

  // v0.0.2：用户打开其他文章（readingCid 变化）时清除不匹配的定位目标，避免旧文章残留高亮
  useEffect(() => {
    if (readingCid && revealTarget?.cid && readingCid !== revealTarget.cid) {
      setRevealTarget(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readingCid])

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
        if (res.ok) setActiveMetas(sortActivities(res.data))
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
  function handleOpenMeta(
    name: string,
    mid: number | string,
    phase?: 'ongoing' | 'reviewing' | 'ended',
    meta?: MetaInfo
  ): void {
    closeArticle()
    openList({ title: name, mid, activityPhase: phase, meta })
  }

  /** 活动树节点：展开/收起 + 打开活动列表 + 懒加载该活动文章（按标题排序） */
  function toggleActivity(m: MetaInfo): void {
    const midKey = String(m.mid)
    toggleExpand(`active:${midKey}`)
    handleOpenMeta(m.name, m.mid, activityPhase(m), m)
    if (!activityArticles[midKey] && !activityLoading.has(midKey)) {
      setActivityLoading((prev) => new Set(prev).add(midKey))
      void window.hqsf
        .listRemoteArticles({ mid: m.mid, limit: 100, order: 'created' })
        .then((res) => {
          setActivityLoading((prev) => {
            const next = new Set(prev)
            next.delete(midKey)
            return next
          })
          if (res.ok) {
            const sorted = [...res.data.items].sort((a, b) =>
              a.title.localeCompare(b.title, 'zh-Hans-CN')
            )
            setActivityArticles((prev) => ({ ...prev, [midKey]: sorted }))
          }
        })
        .catch(() => {
          setActivityLoading((prev) => {
            const next = new Set(prev)
            next.delete(midKey)
            return next
          })
        })
    }
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

  // v0.0.2：未完成评审任务数（活动按钮红点）
  const pendingTasks = Object.values(reviewTaskByCid).filter((s) => s === 0).length

  return (
    <aside
      className={`sidebar${collapsed ? ' collapsed' : ''}${resizing ? ' dragging' : ''}`}
      style={collapsed ? undefined : { width: sidebarWidth }}
    >
      {/* v0.0.3：右缘拖动分隔条（仅展开态） */}
      {!collapsed && <div className="sidebar-resizer" onMouseDown={onSidebarResizeDown} title="拖动调整左栏宽度" />}
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
          {SECTIONS.map((key) => {
            const Icon = SECTION_ICONS[key]
            return (
              <button
                key={key}
                className={`nav-item ${section === key ? 'active' : ''}`}
                onClick={() => {
                  closeArticle()
                  setSection(key)
                }}
                title={collapsed ? SECTION_LABELS[key] : undefined}
              >
                {/* v0.0.3：模块图标（折叠态仅显示图标） */}
                <span className="nav-item-label">
                  <Icon size={15} />
                  <span className="nav-label">{SECTION_LABELS[key]}</span>
                </span>
                {/* v0.0.2：活动按钮右侧红点 = 未完成评审任务数 */}
                {key === 'activity' && pendingTasks > 0 && (
                  <span className="nav-badge" title={`${pendingTasks} 个未完成评审任务`}>
                    {pendingTasks}
                  </span>
                )}
              </button>
            )
          })}
        </nav>
      </div>

      <div className="tree-area">
        {isWriting ? (
          <div className="writing-tree">
            <div className="tree-toolbar">
              <button className="sync-btn" disabled={pulling} onClick={() => void pull()} title="从荒启拉取草稿与状态">
                <RefreshCw size={13} className={`sync-icon${pulling ? ' spin' : ''}`} /> {pulling ? '同步中 …' : '同步'}
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
                打开目录
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
                <ChevronRight size={12} className={`caret${expanded.has('local') ? ' open' : ''}`} /> 本地存档
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
                  <ChevronRight size={12} className={`caret${expanded.has(key) ? ' open' : ''}`} />
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
                    <ChevronRight size={12} className={`caret${expanded.has(`serial:${g.type}`) ? ' open' : ''}`} /> {g.label}
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
            {activeMetas.length === 0 && !metasError && (
              <div className="tree-empty muted">（加载中 …）</div>
            )}
            {/* v0.0.2：活动树——可展开，子项为该活动文章（按标题排序）；进行中/评审中标记；阅读高亮；任务徽章 */}
            {activeMetas.map((m) => {
              const midKey = String(m.mid)
              const phase = activityPhase(m)
              const phaseLabel = ACTIVITY_PHASE_LABEL[phase]
              const articles = activityArticles[midKey] ?? []
              const loading = activityLoading.has(midKey)
              return (
                <div className="tree-group" key={m.mid}>
                  <button
                    className={`tree-group-title ${selectedId === m.name ? 'active' : ''}`}
                    onClick={() => toggleActivity(m)}
                    title={m.description || m.name}
                  >
                    <ChevronRight size={12} className={`caret${expanded.has(`active:${midKey}`) ? ' open' : ''}`} />
                    <span className="tree-group-label">{m.name}</span>
                    {/* v0.0.2：右侧容器整体靠右（count+状态徽章），无 count 时徽章也贴右 */}
                    <span className="tree-group-title-right">
                      {articles.length > 0 && <span className="count">{articles.length}</span>}
                      {phaseLabel && <span className={`activity-badge phase-${phase}`}>{phaseLabel}</span>}
                    </span>
                  </button>
                  {expanded.has(`active:${midKey}`) && (
                    <div className="tree-group-body">
                      {loading && <div className="tree-empty muted">（加载中 …）</div>}
                      {!loading && articles.length === 0 && (
                        <div className="tree-empty muted">（该活动暂无文章）</div>
                      )}
                      {articles.map((row) => {
                        const ts = reviewTaskByCid[row.cid]
                        const isActive =
                          readingCid === row.cid ||
                          selectedId === `active-article:${row.cid}` ||
                          (revealTarget?.section === 'activity' && revealTarget.cid === row.cid)
                        return (
                          <button
                            key={row.cid}
                            data-cid={row.cid}
                            className={`tree-node ${isActive ? 'active' : ''} ${ts === 0 ? 'task-todo' : ''}`}
                            onClick={() => {
                              setSelectedId(`active-article:${row.cid}`)
                              void openArticle(row.cid)
                            }}
                            title={row.title}
                          >
                            <span className="tree-node-text">{row.title}</span>
                            {ts === 0 && <span className="tree-task-badge todo">待评审</span>}
                            {ts === 1 && <span className="tree-task-badge done">已评审</span>}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
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
          <Settings size={14} /> <span>设置</span>
        </button>
      </div>
    </aside>
  )
}
