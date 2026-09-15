import { useEffect, useMemo, useRef, useState } from 'react'
import { REVIEW_ORDERS, useReaderStore } from '../../stores/reader'
import { useAuthStore } from '../../stores/auth'
import { useUiStore } from '../../stores/ui'
import { useDocsStore } from '../../stores/docs'
import { activityPhase, type ActivityPhase } from '../../lib/activity'
import { getActivePhaseCache, setActivePhaseCache } from './activityCache'
import { anonymousAuthorDisplayName, cachedImageUrl, formatSize, formatTs, expandMediaTags, sanitizeHtml, scoreColor, userAvatarUrl, userDisplayName } from '../../lib/sanitize'
import { ErrorBanner } from '../../components/ErrorBanner'
import { CommentSection, CommentCard, ridOf, flatSubs } from '../../components/ReaderComments'
import { ReaderInteractions } from '../../components/ReaderInteractions'
import { RightPanel, type RightTab } from '../panel/RightPanel'
import { SearchPanel } from '../panel/SearchPanel'
import { SkeletonReader } from '../../components/Skeletons'
import { UserLevelBadge } from '../../components/UserLevelBadge'
import { buildRegex } from '../../lib/searchText'
import { clearSearchMarks, jumpToSearchMark, setActiveSearchMark, wrapSearchMatches } from '../../lib/searchJump'
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Copy, Eye, EyeOff, FileDown, Link2, MessageCircle, PenLine, Quote, X } from 'lucide-react'
import type { ArticleDetail, ArticleType, CommentItem, MetaRef, ReviewItem, ReviewPayload } from '../../../../shared/types'
import { useContextMenu, type ContextMenuItem } from '../../components/menu/ContextMenu'
import { h5ArticleUrl } from '../../lib/articleUrl'
import { readSelection } from '../../lib/selection'


/** 从详情/用户信息里提取作者展示名（与侧栏同样的多字段容错） */
function authorName(detail: ArticleDetail): string {
  return userDisplayName(detail.userJson, '佚名')
}

/** 从详情/用户信息里提取作者头像 URL（http(s) 走缓存协议） */
function authorAvatar(detail: ArticleDetail): string | undefined {
  const url = userAvatarUrl(detail.userJson)
  return url ? cachedImageUrl(url) : undefined
}

/**
 * v0.0.2：文章归属标签——标记它属于什么活动/分类/合集，点击跳转到对应栏目列表。
 * 详情/列表条目的 active/category/collection 数组含 name+mid（2026-08-08 实测）。
 */
function BelongTags({ detail }: { detail: ArticleDetail }): React.JSX.Element | null {
  const openList = useUiStore((s) => s.openList)
  const setSection = useUiStore((s) => s.setSection)
  const setRevealTarget = useUiStore((s) => s.setRevealTarget)
  const closeArticle = useReaderStore((s) => s.closeArticle)

  const items = useMemo(() => {
    const out: Array<{ kind: 'active' | 'category' | 'collection'; label: string; ref: MetaRef }> = []
    const act = detail.active?.[0]
    if (act && act.mid !== '' && act.name) out.push({ kind: 'active', label: '活动', ref: act })
    const cat = detail.category?.[0]
    if (cat && cat.mid !== '' && cat.name) out.push({ kind: 'category', label: '分类', ref: cat })
    const col = detail.collection?.[0]
    if (col && col.mid !== '' && col.name) out.push({ kind: 'collection', label: '合集', ref: col })
    return out
  }, [detail])

  if (items.length === 0) return null

  function openBelong(item: { kind: string; label: string; ref: MetaRef }): void {
    // 退出阅读态，否则 MainArea 会继续渲染 ReaderView（readingCid 优先于 listContext）
    closeArticle()
    // v0.0.2：左栏同步切换到对应栏目（活动/作品库/连载），并高亮目标节点
    const sectionMap: Record<string, 'activity' | 'library' | 'serial'> = {
      active: 'activity',
      category: 'library',
      collection: 'serial'
    }
    setSection(sectionMap[item.kind] ?? 'library')
    if (item.kind === 'active') {
      // v0.0.2：左栏定位到该文章标题（展开活动树 + 高亮文章节点）
      setRevealTarget({ section: 'activity', mid: item.ref.mid, cid: detail.cid })
      // 活动列表需要 phase 决定评分榜隔离；先查一次 activeStatus（缓存）
      const midKey = String(item.ref.mid)
      if (getActivePhaseCache()) {
        openList({ title: item.ref.name!, mid: item.ref.mid, activityPhase: getActivePhaseCache()?.[midKey] })
        return
      }
      void window.hqsf.listMetas('active').then((res) => {
        if (!res.ok) {
          // v0.0.8：查询失败无法确认活动状态 → 按保守处理：仍打开列表，但强制隐藏评分榜
          //（进行中/评审中的活动文章无评分，任何情况下都不能出现在评分榜里）
          openList({ title: item.ref.name!, mid: item.ref.mid, hideScoreboard: true })
          return
        }
        const cache: Record<string, ActivityPhase> = {}
        for (const m of res.data) cache[String(m.mid)] = activityPhase(m)
        setActivePhaseCache(cache)
        openList({ title: item.ref.name!, mid: item.ref.mid, activityPhase: cache[midKey] })
      })
      return
    }
    openList({ title: item.ref.name!, mid: item.ref.mid })
  }

  return (
    <div className="reader-belong">
      {items.map((it) => (
        <button key={it.kind + String(it.ref.mid)} className="belong-tag" onClick={() => openBelong(it)} title={`打开「${it.ref.name}」`}>
          {it.label} · {it.ref.name}
        </button>
      ))}
    </div>
  )
}

/** 阅读视图：远端文章 HTML 正文 + 元信息；右栏（目录/评论/评审/搜索）挂在右侧（v0.0.7：可拖动分栏由通用 RightPanel 内置） */
import { ReviewPanel } from './ReviewPanel'

export function ReaderView(): React.JSX.Element {
  const detail = useReaderStore((s) => s.detail)
  const detailLoading = useReaderStore((s) => s.detailLoading)
  const detailError = useReaderStore((s) => s.detailError)
  const closeArticle = useReaderStore((s) => s.closeArticle)
  const session = useAuthStore((s) => s.session)

  // v0.0.3：右栏（目录/评论/评审/搜索）展开与 tab 由 ui store 管理（顶栏「展开右栏」按钮切换；v0.0.6+ 全局单份）
  const panelOpen = useUiStore((s) => s.panelOpen)
  const panelTab = useUiStore((s) => s.panelTab)
  const openUserPage = useUiStore((s) => s.openUserPage)
  // v0.0.7+：搜索词/正则/活动序号（与 SearchPanel 共享，驱动正文高亮）
  const searchQuery = useUiStore((s) => s.searchQuery)
  const searchRegex = useUiStore((s) => s.searchRegex)
  const searchActive = useUiStore((s) => s.searchActive)

  const safeHtml = useMemo(() => (detail ? expandMediaTags(sanitizeHtml(detail.text)) : ''), [detail])
  // v0.0.6：稳定引用（详见 article dangerouslySetInnerHTML 注释）——右栏/边栏操作 re-render 时
  // 不重写正文 innerHTML，正文内音乐 iframe 等保持不中断
  const bodyHtml = useMemo(() => ({ __html: safeHtml }), [safeHtml])
  const bodyRef = useRef<HTMLElement | null>(null)

  /** 导言：详情 introduction 优先；缺省时从当前列表缓存匹配同 cid 条目（列表接口实测含 introduction） */
  const intro = useMemo(() => {
    if (!detail) return ''
    const own = detail.introduction?.trim()
    if (own) return own
    const cached = useReaderStore.getState().list.find((it) => it.cid === detail.cid)
    return cached?.introduction?.trim() ?? ''
  }, [detail])

  /** 目录：正文注入后提取 h1-h6 标题（≥2 个才显示）。
   *  注意：React 对 dangerouslySetInnerHTML 每次提交都会重写 innerHTML，effect 捕获的节点会被
   *  detached，因此跳转时实时查询标题元素（索引与 toc 生成时一致，正文会话内稳定）。 */
  const [toc, setToc] = useState<Array<{ idx: number; level: number; text: string }>>([])
  // v0.0.6+：正文纯文本（搜索源；与正文 DOM 顺序一致，跳转按同索引定位）
  const [bodyText, setBodyText] = useState('')
  useEffect(() => {
    const body = bodyRef.current
    if (!body) {
      setToc([])
      setBodyText('')
      return
    }
    setBodyText(body.textContent ?? '')
    const items: Array<{ idx: number; level: number; text: string }> = []
    Array.from(body.querySelectorAll('h1,h2,h3,h4,h5,h6')).forEach((h, i) => {
      const text = (h.textContent ?? '').trim()
      if (!text) return
      items.push({ idx: i, level: Number(h.tagName.slice(1)), text })
    })
    setToc(items)
  }, [safeHtml, detail?.cid])

  // v0.0.7+：正文搜索正则（与 SearchPanel 同源；无效正则时 null → 不匹配不高亮）
  const searchRe = useMemo(() => buildRegex(searchQuery, searchRegex), [searchQuery, searchRegex])

  // v0.0.7+：正文搜索高亮——词/正则/正文变化时清除旧标记、包裹全部匹配为
  // <mark class="search-highlight">，并按当前活动序号强调对应匹配与所在段落。
  // 注意：article 的 dangerouslySetInnerHTML 传稳定引用，React 不会重写 innerHTML，
  // 这里直接改 DOM 的高亮标记可跨渲染保留（正文音乐 iframe 不受影响）。
  // v0.0.8：包裹防抖 120ms（输入时全篇重包有成本）；活动强调在包裹完成后重设。
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const t = window.setTimeout(() => {
      clearSearchMarks(body)
      if (searchRe) wrapSearchMatches(body, searchRe)
      setActiveSearchMark(body, useUiStore.getState().searchActive, searchRe)
    }, 120)
    return () => window.clearTimeout(t)
  }, [safeHtml, searchRe])

  // v0.0.7+：活动匹配变化（上一处/下一处/点击结果）→ 立即移动强调标记与段落高亮
  // （v0.0.8：仅依赖 searchActive 与 searchRe，避免与高亮 effect 同批重复执行）
  useEffect(() => {
    const body = bodyRef.current
    if (body) setActiveSearchMark(body, searchActive, searchRe)
  }, [searchActive, searchRe])

  function jumpTo(idx: number): void {
    const body = bodyRef.current
    const scroller = body?.closest('.reader-main')
    if (!body || !scroller) return
    const el = Array.from(body.querySelectorAll('h1,h2,h3,h4,h5,h6'))[idx]
    if (!el) return
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    scroller.scrollTo({ top, behavior: 'smooth' })
  }

  // 横长图处理：宽/高比 ≥ 2 的图放大高度、宽度溢出裁掉（object-fit: cover 由 CSS 实现）
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const imgs = Array.from(body.querySelectorAll('img'))
    if (imgs.length === 0) return
    const markWide = (img: HTMLImageElement): void => {
      if (img.naturalWidth > 0 && img.naturalWidth / img.naturalHeight >= 2) {
        img.classList.add('reader-img-wide')
      }
    }
    for (const img of imgs) {
      if (img.complete) markWide(img)
      else img.addEventListener('load', () => markWide(img), { once: true })
    }
  }, [safeHtml, detail?.cid])

  const myUid = String(session?.userinfo?.uid ?? session?.userinfo?.id ?? '')
  const isMine = !!detail && myUid !== '' && String(detail.authorId) === myUid

  // v0.0.8：本人文章操作（编辑 / 转存为草稿）状态
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [remoteMsg, setRemoteMsg] = useState<string | null>(null)
  const cid = detail?.cid ?? ''
  // 远端状态：本地索引优先（转存后即时反映），详情字段兜底（未同步/缓存的文章）
  const articles = useDocsStore((s) => s.articles)
  const row = articles.find((a) => a.cid === cid)
  const remoteType = row?.type ?? ((detail?.type as ArticleType | undefined) ?? undefined)
  const isDraftArticle = remoteType === 'post_draft'
  // v0.0.9：科幻杂谈/官方公告/外文翻译分类——不开启评审、不显示评分。
  // v0.0.10：统一由 reader store 在 openArticle 时计算，视图只消费
  const reviewDisabled = useReaderStore((s) => s.reviewDisabled)
  const target = useReaderStore((s) => s.target)
  const clearTarget = useReaderStore((s) => s.clearTarget)

  // v1.1.12：正文选中文字右键菜单（复制 / 复制为 Markdown / 引用到评审）
  const showMenu = useContextMenu()
  /** 只在正文有选区时出菜单；选区内容在 contextmenu 触发时取好（点菜单项后浏览器选区会失效） */
  function handleBodyContextMenu(e: React.MouseEvent): void {
    const snap = readSelection(bodyRef.current)
    if (!snap) return
    const items: ContextMenuItem[] = [
      { label: '复制', icon: <Copy size={13} />, onSelect: () => void window.hqsf.copyText(snap.text) },
      {
        label: '复制链接',
        icon: <Link2 size={13} />,
        onSelect: () => void window.hqsf.copyText(h5ArticleUrl(cid))
      }
    ]
    // 评审 tab 存在的条件与之保持一致（本人文章/禁用评审的分类没有评审入口）
    if (session && !isMine && !reviewDisabled) {
      items.push({
        label: '引用到评审',
        icon: <Quote size={13} />,
        divided: true,
        onSelect: () => {
          useReaderStore.getState().quoteToReview(snap.text)
          useUiStore.getState().openPanelTab('review')
        }
      })
    }
    showMenu(e, items)
  }
  // v0.0.9：首页「最新评审」深链跳到禁用评审分类文章时，右栏无评审 tab 可消费目标，直接清理避免残留
  useEffect(() => {
    if (reviewDisabled && target?.reviewId && target.cid === cid) clearTarget()
  }, [reviewDisabled, target, cid, clearTarget])

  /** 短暂展示操作结果提示（4 秒自动消失） */
  function flashRemoteMsg(msg: string): void {
    setRemoteMsg(msg)
    window.setTimeout(() => setRemoteMsg((m) => (m === msg ? null : m)), 4000)
  }

  /** 编辑本人远端文章：非草稿先经服务端转存为草稿，再同步到本地存档并打开编辑器 */
  async function handleEditRemote(): Promise<void> {
    if (remoteBusy) return
    setRemoteBusy(true)
    setRemoteMsg(null)
    const res = await useReaderStore.getState().editRemoteArticle(cid)
    setRemoteBusy(false)
    if (!res.ok) flashRemoteMsg(`编辑失败: ${res.error}`)
    // 成功时已退出阅读态并切到编辑器，无需提示
  }

  /** 转存为草稿（仅服务端处理，不打开编辑器） */
  async function handleConvertToDraft(): Promise<void> {
    if (remoteBusy) return
    setRemoteBusy(true)
    setRemoteMsg(null)
    const res = await useReaderStore.getState().convertToDraft(cid)
    setRemoteBusy(false)
    if (!res.ok) flashRemoteMsg(`转存失败: ${res.error}`)
    else flashRemoteMsg(res.data.converted ? '已转存为草稿（服务端处理）' : '这篇文章已是草稿')
  }

  // v0.0.6：右栏 tabs 由通用 RightPanel 渲染（零/单/多 tab 规则内置）——
  // 目录（有标题时）/ 评论 / 评审（非本人文章）；原 ReaderPanel 内嵌实现已抽离
  const setPanelTab = useUiStore((s) => s.setPanelTab)
  const commentsTotal = useReaderStore((s) => s.commentsTotal)
  const reviewsCount = useReaderStore((s) => s.reviews.length)
  const hasToc = toc.length > 0
  // v0.0.7+：正文搜索跳转——滚动到第 idx 个高亮匹配（与结果列表同序；无标记时回退偏移映射）
  const jumpToSearch = (idx: number): void => {
    const u = useUiStore.getState()
    jumpToSearchMark(bodyRef.current, idx, buildRegex(u.searchQuery, u.searchRegex))
  }
  const tabs: Array<RightTab<'toc' | 'comments' | 'review' | 'search'>> = [
    ...(hasToc
      ? [
          {
            key: 'toc' as const,
            label: '目录',
            content: (
              <div className="reader-panel-scroll">
                <ul className="reader-toc-list">
                  {toc.map((t) => (
                    <li key={t.idx} className={`reader-toc-item lv-${Math.min(6, Math.max(1, t.level))}`}>
                      <a
                        href={`#toc-${t.idx + 1}`}
                        onClick={(e) => {
                          e.preventDefault()
                          jumpTo(t.idx)
                        }}
                      >
                        {t.text}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )
          }
        ]
      : []),
    { key: 'comments', label: '评论', badge: commentsTotal, content: <CommentSection cid={cid} /> },
    // v0.0.9：禁用评审的分类文章不提供评审 tab（与本人文章规则并列）
    ...(!isMine && !reviewDisabled
      ? [
          {
            key: 'review' as const,
            label: '评审',
            badge: reviewsCount > 0 ? reviewsCount : undefined,
            content: <ReviewPanel />
          }
        ]
      : []),
    // v0.0.6+：搜索（基础 tab，所有视图可用）
    {
      key: 'search' as const,
      label: '搜索',
      content: <SearchPanel text={bodyText} onJump={jumpToSearch} />
    }
  ]

  if (detailLoading) {
    // v0.0.7：预填充骨架——形状与真实阅读页同构（标题 + meta + 正文段落，限宽居中）
    return (
      <main className="main-area">
        <div className="reader-main">
          <span className="sr-only" role="status">正在加载文章 …</span>
          <SkeletonReader />
        </div>
      </main>
    )
  }

  if (detailError || !detail) {
    return (
      <main className="main-area">
        <div className="reader-error">
          <ErrorBanner title="阅读失败" message={detailError ?? '未找到文章'} />
          <button className="toolbar-btn" onClick={closeArticle}>
            返回
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="main-area">
      <div className="reader-layout">
        <div className="reader-main">
          <header className="reader-header">
            {/* v0.0.2：左侧内容区（标题 + meta + 归属标签） */}
            <div className="reader-header-left">
              <div className="reader-header-top">
                <h1 className="reader-title">{detail.title}</h1>
              </div>
              <div className="reader-meta">
                <span
                  className={`reader-author${
                    detail.authorId && String(detail.authorId) !== '0' && authorName(detail) !== '佚名' && authorName(detail) !== '匿名用户'
                      ? ' user-link'
                      : ''
                  }`}
                  title={detail.authorId && String(detail.authorId) !== '0' ? '查看用户主页' : undefined}
                  onClick={
                    detail.authorId && String(detail.authorId) !== '0' && authorName(detail) !== '佚名' && authorName(detail) !== '匿名用户'
                      ? () => openUserPage(String(detail.authorId))
                      : undefined
                  }
                >
                  {authorAvatar(detail) ? (
                    <img className="reader-author-avatar" src={authorAvatar(detail)} alt="" referrerPolicy="no-referrer" />
                  ) : null}
                  {authorName(detail)}
                </span>
                {detail.size ? <span>· {formatSize(detail.size)} 字</span> : null}
                {detail.views ? <span>· {detail.views} 阅读</span> : null}
                {detail.likes ? <span>· {detail.likes} 赞</span> : null}
                {detail.created ? <span>· {formatTs(detail.created)}</span> : null}
              </div>
              {/* v0.0.2：文章归属（活动/分类/合集），点击跳转 */}
              <BelongTags detail={detail} />
            </div>
            {/* v0.0.2：右侧操作区——上下排布（大号评分在上、评审按钮在下），与左侧整体等高。
                v0.0.9：禁用评审的分类文章不显示评分与评审按钮 */}
            <div className="reader-header-actions">
              {!reviewDisabled && detail.score && detail.score !== '-.-' ? (
                <span
                  className="reader-score-big"
                  style={{ color: scoreColor(detail.score) ?? undefined }}
                  title="评分"
                >
                  评分 <b>{detail.score}</b>
                </span>
              ) : null}
              {!isMine && !reviewDisabled && (
                <button
                  className="review-toggle"
                  onClick={() => {
                    const { panelOpen, panelTab, togglePanel, setPanelTab } = useUiStore.getState()
                    // v0.0.6：右栏已是评审 → 收起；否则展开右栏并切到评审
                    if (panelOpen && panelTab === 'review') {
                      togglePanel()
                    } else {
                      if (!panelOpen) togglePanel()
                      setPanelTab('review')
                    }
                  }}
                  title={panelOpen && panelTab === 'review' ? '收起右栏评审' : '在右栏查看与撰写评审'}
                >
                  <PenLine size={14} /> 评审
                </button>
              )}
              {/* v0.0.8：本人文章操作——草稿直接同步本地编辑；待审核/已发布/已拒绝先服务端转存草稿 */}
              {isMine && (
                <>
                  {!isDraftArticle && (
                    <button
                      className="review-toggle reader-own-action"
                      onClick={() => void handleConvertToDraft()}
                      disabled={remoteBusy}
                      title="转存为草稿（服务端处理）"
                    >
                      <FileDown size={14} /> {remoteBusy ? '转存中…' : '转存为草稿'}
                    </button>
                  )}
                  <button
                    className="review-toggle reader-own-action"
                    onClick={() => void handleEditRemote()}
                    disabled={remoteBusy}
                    title={
                      isDraftArticle
                        ? '同步到本地存档并本地编辑'
                        : '先在服务端转存为草稿，再同步到本地存档编辑'
                    }
                  >
                    <PenLine size={14} /> {remoteBusy ? '处理中…' : '编辑'}
                  </button>
                </>
              )}
            </div>
          </header>
          {remoteMsg && (
            <div className={`reader-remote-msg${remoteMsg.startsWith('编辑失败') || remoteMsg.startsWith('转存失败') ? ' err' : ''}`}>
              {remoteMsg}
            </div>
          )}
          {intro && <div className="reader-intro">{intro}</div>}
          {/* v0.0.3：目录已移入右栏 tab；正文下方评论区已移入右栏 tab */}
          <article
            ref={bodyRef}
            className="reader-body"
            onContextMenu={handleBodyContextMenu}
            // 正文已经 sanitizeHtml 白名单净化，无脚本/事件/危险协议
            // v0.0.6：dangerouslySetInnerHTML 传稳定引用——React 按对象引用比较，
            // 若每次渲染新建对象会重写 innerHTML 导致正文 iframe（音乐播放器）被重建中断
            dangerouslySetInnerHTML={bodyHtml}
          />
          {/* v0.0.3：互动悬浮按钮组（投币/点赞/收藏/分享 + 置顶，右下角）；返回列表已移到顶栏 */}
          <ReaderInteractions detail={detail} />
        </div>
        {/* v0.0.6：右栏常驻渲染（通用 RightPanel）；v0.0.7 可拖动分隔条已内置（展开时显示） */}
        <RightPanel tabs={tabs} activeTab={panelTab} onTabChange={setPanelTab} open={panelOpen} />
      </div>
    </main>
  )
}

/** 五维表单默认值 */


/** 解析逗号分隔五维分数串（顺序 dianzi,wenbi,jiezou,renwu,liyi）；非法返回 null */


/** 评审表单：五维 + auto-grow 编辑框 + 实时平均分预示（v0.0.2） */


/** auto-grow 编辑框：随内容自动变高、不显示滚动条、不可手动调整高度（v0.0.2） */


/** 评审条目（评者头像 + 五维 + 态度计数 + 评分着色；v0.0.3 加「回复评审/查看评审评论」；我的评审含编辑按钮） */


/**
 * v0.0.5：评审卡片内嵌评论（展开/收起由 ReviewItemCard 控制）：
 * 该评审的评论列表（含楼中楼）+ 回复框（提交带 reviewid）；
 * 评论数据来自 store.comments（按 cid 全局加载，此处按 reviewid 过滤）。
 */


/** 评审面板（v0.0.2）：「我的评审」/「所有评审」两个 tab + 排序 + 编辑模式（v0.0.3 移入右栏 tab 容器） */


