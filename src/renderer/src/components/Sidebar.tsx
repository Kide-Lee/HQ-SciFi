import { useEffect, useState } from 'react'
import {
  BookOpen,
  CalendarDays,
  ChevronRight,
  CircleDollarSign,
  CloudDownload,
  FilePlus,
  FolderOpen,
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
import type { ArticleRow, LocalNode, MetaInfo, RemoteArticle } from '../../../shared/types'
import { PromptModal } from './PromptModal'
import { useUserStore } from '../stores/user'
import type { UserPageTab } from '../../../shared/types'

const SECTIONS: TopSection[] = ['writing', 'recommend', 'activity', 'serial', 'library']

/** v0.0.8：用户页左栏 tab（本人多「动态/收藏」） */
const USER_TABS_SELF: Array<{ key: UserPageTab; label: string }> = [
  { key: 'home', label: '主页' },
  { key: 'dynamic', label: '动态' },
  { key: 'marks', label: '收藏' },
  { key: 'fans', label: '粉丝' },
  { key: 'articles', label: '文章' },
  { key: 'reviews', label: '评审' },
  { key: 'comments', label: '评论' }
]

const USER_TABS_OTHER: Array<{ key: UserPageTab; label: string }> = [
  { key: 'home', label: '主页' },
  { key: 'fans', label: '粉丝' },
  { key: 'articles', label: '文章' },
  { key: 'reviews', label: '评审' },
  { key: 'comments', label: '评论' }
]

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

/** v0.0.6：按绝对路径在树中查找目录节点（找不到返回 null） */
function findDirNode(nodes: LocalNode[], dir: string): LocalNode | null {
  for (const n of nodes) {
    if (!n.isDir) continue
    if (n.path === dir) return n
    if (n.children) {
      const found = findDirNode(n.children, dir)
      if (found) return found
    }
  }
  return null
}

/**
 * v0.0.7：活动文章排序——待评审（评审任务 status=0）置顶，其余维持标题排序。
 * 渲染期执行而非加载期：评审任务可能晚于文章列表返回（loadReviewTasks 幂等异步），
 * 任务到达后经 store 订阅驱动本组件重渲染，排序随之自动生效。
 */
function sortActivityArticles(
  articles: RemoteArticle[],
  reviewTaskByCid: Record<string, number>
): RemoteArticle[] {
  const pendingRank = (cid: string): number => (reviewTaskByCid[cid] === 0 ? 0 : 1)
  return [...articles].sort((a, b) => {
    const ra = pendingRank(a.cid)
    const rb = pendingRank(b.cid)
    if (ra !== rb) return ra - rb
    return a.title.localeCompare(b.title, 'zh-Hans-CN')
  })
}

export function Sidebar(): React.JSX.Element {
  const section = useUiStore((s) => s.section)
  const selectedId = useUiStore((s) => s.selectedId)
  const setSection = useUiStore((s) => s.setSection)
  const setSelectedId = useUiStore((s) => s.setSelectedId)
  const openList = useUiStore((s) => s.openList)
  const revealTarget = useUiStore((s) => s.revealTarget)
  const setRevealTarget = useUiStore((s) => s.setRevealTarget)

  const session = useAuthStore((s) => s.session)
  const openLogin = useUiStore((s) => s.openLogin)
  const userPageUid = useUiStore((s) => s.userPageUid)
  const openUserPage = useUiStore((s) => s.openUserPage)
  const closeUserPage = useUiStore((s) => s.closeUserPage)
  const userTab = useUserStore((s) => s.tab)
  const setUserTab = useUserStore((s) => s.setTab)
  const articles = useDocsStore((s) => s.articles)
  const localTree = useDocsStore((s) => s.localTree)
  const refreshLocal = useDocsStore((s) => s.refreshLocal)
  const refreshArticles = useDocsStore((s) => s.refreshArticles)
  const pull = useDocsStore((s) => s.pull)
  const pulling = useDocsStore((s) => s.pulling)
  const lastPull = useDocsStore((s) => s.lastPull)
  const openDoc = useEditorStore((s) => s.open)
  const currentPath = useEditorStore((s) => s.currentPath)
  const currentDir = useEditorStore((s) => s.currentDir)
  const createDraft = useEditorStore((s) => s.createDraft)
  const openArticle = useReaderStore((s) => s.openArticle)
  const closeArticle = useReaderStore((s) => s.closeArticle)
  const readingCid = useReaderStore((s) => s.readingCid)
  const reviewTaskByCid = useReaderStore((s) => s.reviewTaskByCid)
  const loadReviewTasks = useReaderStore((s) => s.loadReviewTasks)
  // v0.0.7：「已评审」徽章数据——本人评审过该文章（登录/挂载时一次拉全）
  const myReviewedCids = useReaderStore((s) => s.myReviewedCids)
  const loadMyReviewed = useReaderStore((s) => s.loadMyReviewed)

  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // v0.0.3：左栏折叠状态提升到 ui store（顶栏按钮切换，localStorage 持久化）
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  // macOS：红绿灯（hiddenInset）悬浮在窗口左上角，左栏加 sidebar-mac 让顶部 36px 给红绿灯让位
  const [platform, setPlatform] = useState('')
  useEffect(() => {
    let alive = true
    void window.hqsf.getAppInfo().then((info) => {
      if (alive) setPlatform(info.platform)
    })
    return () => {
      alive = false
    }
  }, [])
  const isMac = platform === 'darwin'
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
  /** v0.0.8：左栏用户卡——本人介绍 / 签到状态 / 能量币 */
  const [ownIntro, setOwnIntro] = useState<string | null>(null)
  const [clocked, setClocked] = useState(false)
  const [clocking, setClocking] = useState(false)
  const [energy, setEnergy] = useState<number | null>(null)

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
    // v0.0.7：同时拉取本人评审集合（「已评审」徽章数据源；幂等）
    void loadMyReviewed()
  }, [loadReviewTasks, loadMyReviewed])

  // v0.0.8：登录后拉取本人资料（介绍）与签到/能量币状态（用户卡展示用）
  useEffect(() => {
    const rawUid = session?.userinfo?.uid ?? session?.userinfo?.id
    if (!session || rawUid == null) {
      setOwnIntro(null)
      setClocked(false)
      setEnergy(null)
      return
    }
    const uid = String(rawUid)
    let alive = true
    void window.hqsf.getUserProfile(uid).then((res) => {
      if (alive && res.ok) setOwnIntro(res.data.introduce ?? null)
    })
    void window.hqsf.getUserStats(uid).then((res) => {
      if (alive && res.ok && res.data) setClocked(res.data.isClock === 1)
    })
    void window.hqsf.getSelfStatus().then((res) => {
      if (alive && res.ok && res.data) setEnergy(res.data.assets)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.userinfo?.uid, session?.userinfo?.id])

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

  /** 打开本地文档：先退出文章阅读态（阅读中点击本地文档须切回编辑器），再打开 */
  async function handleOpenLocal(path: string): Promise<void> {
    closeArticle()
    setSelectedId(path)
    await openDoc(path)
  }

  /** 打开远端索引项：有本地文件 → 本地编辑；无本地文件（或被删除/失联）→ 按文章处理（阅读视图 + 编辑按钮） */
  async function handleOpenRemote(row: ArticleRow): Promise<void> {
    if (row.filePath) {
      // 实时校验文件存在：索引可能残留失效路径（文件被删除），此时也按文章处理
      const exists = await window.hqsf.fileExists(row.filePath)
      if (exists.ok && exists.data) {
        void handleOpenLocal(row.filePath)
        return
      }
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

  /** v0.0.6：tree-toolbar「新建草稿」——弹窗输入标题，在当前浏览目录内创建并打开编辑器 */
  const [newDraftOpen, setNewDraftOpen] = useState(false)
  async function handleNewDraft(title: string): Promise<void> {
    if (!title.trim()) return
    const dirNode = currentDir ? findDirNode(localTree, currentDir) : null
    const dirRel = currentDir ? (dirNode?.rel ?? '') : ''
    const path = await createDraft(title.trim(), dirRel)
    if (path) await refreshLocal() // 新文件已落盘：刷新本地目录树，让侧栏「本地存档」即时出现该草稿
  }

  /** v0.0.6：本地存档递归文件树（文件夹可展开/收起） */
  function renderLocalTree(nodes: LocalNode[], depth = 0): React.JSX.Element[] {
    return nodes.map((node) => {
      if (node.isDir) {
        const k = `local:${node.path}`
        const open = expanded.has(k)
        return (
          <div key={node.path} className="tree-dir-wrap">
            <button
              className={`tree-dir-entry${open ? ' open' : ''}`}
              onClick={() => toggleExpand(k)}
              title={node.path}
              style={{ paddingLeft: 22 + depth * 12 }}
            >
              {/* v0.0.6：展开箭头由 CSS 伪元素 ::before 绘制（不占流内宽度，目录名与文件名左边缘自然对齐） */}
              <span className="tree-dir-name">{node.name}</span>
            </button>
            {open && node.children && (
              <div className="tree-dir-children">{renderLocalTree(node.children, depth + 1)}</div>
            )}
          </div>
        )
      }
      return (
        <button
          key={node.path}
          className={`tree-node ${selectedId === node.path ? 'active' : ''}`}
          onClick={() => void handleOpenLocal(node.path)}
          title={node.path}
          style={{ paddingLeft: 22 + depth * 12 }}
        >
          {/* v0.0.6：文件名超宽省略号截断（复用 .tree-node-text 规则） */}
          <span className="tree-node-text">{node.name.replace(/\.md$/i, '')}</span>
        </button>
      )
    })
  }

  const isWriting = section === 'writing'

  /** v0.0.8：签到——成功后按钮消失，原位显示能量币 */
  async function handleClock(): Promise<void> {
    if (clocking) return
    setClocking(true)
    const res = await window.hqsf.clockIn()
    setClocking(false)
    if (res.ok && res.data.ok) {
      const r = res.data
      setClocked(true)
      if (r.assets != null) setEnergy(r.assets)
      alert(r.award != null ? `签到成功！获得 ${r.award} 能量币${r.addExp != null ? `、${r.addExp} 经验` : ''}` : '签到成功')
    } else {
      alert(res.ok ? res.data.error ?? '签到失败' : res.error)
    }
  }

  // v0.0.2：未完成评审任务数（活动按钮红点）
  const pendingTasks = Object.values(reviewTaskByCid).filter((s) => s === 0).length

  return (
    <aside
      className={`sidebar${collapsed ? ' collapsed' : ''}${resizing ? ' dragging' : ''}${isMac ? ' sidebar-mac' : ''}`}
      style={collapsed ? undefined : { width: sidebarWidth }}
    >
      {/* v0.0.3：右缘拖动分隔条（仅展开态） */}
      {!collapsed && <div className="sidebar-resizer" onMouseDown={onSidebarResizeDown} title="拖动调整左栏宽度" />}
      <div className="sidebar-top">
        <div className="user-card-col">
          <div className="user-card">
            {session ? (
              <>
                <button
                  className="avatar user-card-avatar-btn"
                  onClick={() => {
                    const v = uidValue
                    if (v != null && String(v) !== '') openUserPage(String(v))
                  }}
                  title="查看我的主页"
                >
                  {avatar ? (
                    <img className="avatar-img" src={String(avatar)} alt="" referrerPolicy="no-referrer" />
                  ) : (
                    nickname.slice(0, 1)
                  )}
                </button>
                <div className="user-meta">
                  <div className="nickname">{nickname}</div>
                  <div className="intro">{uid}</div>
                </div>
                {/* v0.0.8：退出按钮移除；原位置显示签到按钮，签到完成后消失并显示能量币 */}
                <div className="user-card-side">
                  {clocked ? (
                    <span className="user-energy" title="能量币">
                      <CircleDollarSign size={13} /> {energy ?? 0}
                    </span>
                  ) : (
                    <button className="sign-btn" disabled={clocking} onClick={() => void handleClock()} title="签到">
                      {clocking ? '签到中' : '签到'}
                    </button>
                  )}
                </div>
              </>
            ) : (
              /* v0.0.6：未登录也可浏览/写作，用户卡变「点击登录」入口（登录为覆盖层模态） */
              <button className="user-card-login" onClick={openLogin} title="登录后启用同步、发布与评审">
                <div className="avatar">?</div>
                <div className="user-meta">
                  <div className="nickname">未登录</div>
                  <div className="intro">点击登录，启用同步与发布</div>
                </div>
              </button>
            )}
          </div>
          {/* v0.0.8：个人介绍显示在左栏用户信息下方 */}
          {session && ownIntro ? <div className="user-card-intro">{ownIntro}</div> : null}
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
                  closeUserPage()
                  // v0.0.6：点击「写作」回到写作首页（关闭当前打开的编辑器文档）
                  if (key === 'writing') void useEditorStore.getState().close()
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
        {userPageUid ? (
          <div className="tree-area-inner">
            {(uidValue != null && String(uidValue) === userPageUid ? USER_TABS_SELF : USER_TABS_OTHER).map((t) => (
              <button
                key={t.key}
                className={`tree-node ${userTab === t.key ? 'active' : ''}`}
                onClick={() => setUserTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
        ) : (
        <>
        {isWriting ? (
          <div className="writing-tree">
            <div className="tree-toolbar">
              {/* v0.0.6：tree-toolbar 三个无边框图标按钮（新建草稿/打开目录/同步），flex 分散布局 */}
              <button
                className="tree-tool-btn"
                onClick={() => setNewDraftOpen(true)}
                title="新建本地草稿"
              >
                <FilePlus size={14} />
              </button>
              <button
                className="tree-tool-btn"
                onClick={() => {
                  void window.hqsf.openDocsDir().then((res) => {
                    if (!res.ok) alert(`打开存档目录失败: ${res.error}`)
                  })
                }}
                title="在系统文件管理器中打开本地存档目录"
              >
                <FolderOpen size={14} />
              </button>
              <button
                className="tree-tool-btn"
                disabled={pulling}
                onClick={() => void pull()}
                title={pulling ? '正在从云端下载草稿与状态…' : '从云端下载草稿与状态'}
              >
                {/* v0.0.8.6：同步中图标切换为旋转的「同步」图标，结束恢复「云端下载」 */}
                {pulling ? (
                  <RefreshCw size={14} className="sync-icon spin" />
                ) : (
                  <CloudDownload size={14} className="sync-icon" />
                )}
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
                  {/* v0.0.6：本地存档递归文件树（文件夹可展开；.image 已在主进程过滤） */}
                  {renderLocalTree(localTree)}
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
                    {groups[key].map((row) => {
                      // v0.0.7：我的作品徽章——待评审（评审任务）/ 已评审（任务完成或本人评审过）
                      const ts = reviewTaskByCid[row.cid]
                      const reviewed = myReviewedCids[row.cid] === true
                      return (
                        <button
                          key={row.cid}
                          className={`tree-node ${selectedId === `remote:${row.cid}` ? 'active' : ''}`}
                          onClick={() => handleOpenRemote(row)}
                          title={row.filePath || `${label}（无本地文件）`}
                        >
                          <span className="tree-node-text">{row.title}</span>
                          {ts === 0 && <span className="tree-task-badge todo">待评审</span>}
                          {(ts === 1 || reviewed) && <span className="tree-task-badge done">已评审</span>}
                        </button>
                      )
                    })}
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
            {/* v0.0.7：活动树——可展开，子项为该活动文章（待评审置顶，组内按标题）；进行中/评审中标记；阅读高亮；任务徽章 */}
            {activeMetas.map((m) => {
              const midKey = String(m.mid)
              const phase = activityPhase(m)
              const phaseLabel = ACTIVITY_PHASE_LABEL[phase]
              const articles = sortActivityArticles(activityArticles[midKey] ?? [], reviewTaskByCid)
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
                        const reviewed = myReviewedCids[row.cid] === true
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
                            {(ts === 1 || reviewed) && <span className="tree-task-badge done">已评审</span>}
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
        </>
        )}
      </div>

      <div className="sidebar-bottom">
        <button className="settings-btn" title="设置（颜色/字号/字体）">
          <Settings size={14} /> <span>设置</span>
        </button>
      </div>

      {/* v0.0.8：新建草稿弹窗（替代 window.prompt，Electron 渲染进程不支持） */}
      <PromptModal
        open={newDraftOpen}
        title="新建草稿"
        placeholder="新草稿标题"
        onClose={() => setNewDraftOpen(false)}
        onConfirm={(title) => {
          setNewDraftOpen(false)
          void handleNewDraft(title)
        }}
      />
    </aside>
  )
}
