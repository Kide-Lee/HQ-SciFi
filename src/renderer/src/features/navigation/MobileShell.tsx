import { cloneElement, isValidElement, useEffect, useRef, useState, type ReactElement, type TouchEvent } from 'react'
import {
  ChevronLeft,
  CloudDownload,
  CloudUpload,
  House,
  FilePlus,
  History,
  MessageCircle,
  PanelRightClose,
  PenLine,
  Redo2,
  Save,
  Search,
  Send,
  Settings,
  Share2,
  ShieldCheck,
  Undo2,
  User
} from 'lucide-react'
import { useUiStore, type TopSection } from '../../stores/ui'
import { useReaderStore } from '../../stores/reader'
import { useEditorStore } from '../../stores/editor'
import { useDocsStore } from '../../stores/docs'
import { useAuthStore } from '../../stores/auth'
import { useNotificationStore } from '../../stores/notifications'
import { currentUid, useUserStore } from '../../stores/user'
import { RecommendHome } from '../browse/RecommendHome'
import { SerialHome } from '../browse/SerialHome'
import { ActivityHome } from '../browse/ActivityHome'
import { LibraryHome } from '../browse/LibraryHome'
import { ArticleListView } from '../browse/ArticleListView'
import { ReaderView } from '../reader/ReaderView'
import { EditorPane } from '../editor/EditorPane'
import { UserView } from '../user/UserView'
import { LoginView } from '../auth/LoginView'
import { NotificationPanel } from '../notifications/NotificationPanel'
import { SettingsPanel } from '../settings/SettingsPanel'
import { HistoryPanel } from '../panel/HistoryPanel'
import { cachedImageUrl } from '../../lib/sanitize'
import type { LocalNode } from '../../../../shared/domain/index'
import type { ArticleType } from '../../../../shared/types'

type MobileTab = 'home' | 'mine' | 'writing' | 'messages' | 'settings'
type HomeTab = Extract<TopSection, 'recommend' | 'activity' | 'serial' | 'library'>

const HOME_TABS: Array<{ key: HomeTab; label: string }> = [
  { key: 'recommend', label: '推荐' },
  { key: 'activity', label: '活动' },
  { key: 'serial', label: '连载' },
  { key: 'library', label: '作品库' }
]

const USER_TABS_SELF: Array<{ key: 'home' | 'dynamic' | 'marks' | 'fans' | 'articles' | 'reviews' | 'comments'; label: string }> = [
  { key: 'home', label: '主页' },
  { key: 'dynamic', label: '动态' },
  { key: 'marks', label: '收藏' },
  { key: 'fans', label: '粉丝' },
  { key: 'articles', label: '文章' },
  { key: 'reviews', label: '评审' },
  { key: 'comments', label: '评论' }
]

const USER_TABS_OTHER: Array<{ key: 'home' | 'fans' | 'articles' | 'reviews' | 'comments'; label: string }> = [
  { key: 'home', label: '主页' },
  { key: 'fans', label: '粉丝' },
  { key: 'articles', label: '文章' },
  { key: 'reviews', label: '评审' },
  { key: 'comments', label: '评论' }
]

const WRITING_STATES: Array<{ key: ArticleType; label: string }> = [
  { key: 'post_draft', label: '草稿' },
  { key: 'waiting', label: '待审核' },
  { key: 'post', label: '已发布' },
  { key: 'reject', label: '已拒绝' }
]

const WRITING_TABS: Array<{ key: 'local' | ArticleType; label: string }> = [
  { key: 'local', label: '本地存档' },
  ...WRITING_STATES
]

const MSG_TABS: Array<{ key: 'interact' | 'chat' | 'notice'; label: string }> = [
  { key: 'interact', label: '互动' },
  { key: 'chat', label: '私聊' },
  { key: 'notice', label: '通知' }
]

const SETTINGS_TABS: Array<{ key: 'system' | 'interface' | 'user'; label: string }> = [
  { key: 'system', label: '系统' },
  { key: 'interface', label: '界面' },
  { key: 'user', label: '用户' }
]

/** 手机端主壳：五个底部导航 + 页面栈。桌面端不使用（按 UA 切换）。 */
/** 新建后没写正文就退出的「未命名草稿」：回到写作页时顺手清掉（避免列表里堆 0 字垃圾）。 */
function collectEmptyUntitled(nodes: LocalNode[], skipPath: string | null): string[] {
  const out: string[] = []
  const walk = (list: LocalNode[]): void => {
    for (const node of list) {
      if (node.isDir) {
        if (node.children) walk(node.children)
        continue
      }
      if (node.path === skipPath) continue
      if (!/(^|\/)未命名草稿(?:\s*\(\d+\))?\.md$/i.test(node.rel)) continue
      if ((node.words ?? 0) === 0) out.push(node.path)
    }
  }
  walk(nodes)
  return out
}

export function MobileShell(): React.JSX.Element {
  const listContext = useUiStore((s) => s.listContext)
  const panelOpen = useUiStore((s) => s.panelOpen)
  const panelMode = useUiStore((s) => s.panelMode)
  const loginOpen = useUiStore((s) => s.loginOpen)
  const closePanel = useUiStore((s) => s.closePanel)
  const readingCid = useReaderStore((s) => s.readingCid)
  const articleTitle = useReaderStore((s) => s.detail?.title ?? '')
  const reviewDisabled = useReaderStore((s) => s.reviewDisabled)
  const userPageUid = useUiStore((s) => s.userPageUid)
  const session = useAuthStore((s) => s.session)
  const [tab, setTab] = useState<MobileTab>('home')
  const [homeTab, setHomeTab] = useState<HomeTab>('recommend')
  const [writingTab, setWritingTab] = useState<'local' | ArticleType>('local')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [libSearch, setLibSearch] = useState(false)
  const [libQuery, setLibQuery] = useState('')
  const [libSubmitted, setLibSubmitted] = useState(false)
  const [wormholeLoading, setWormholeLoading] = useState(false)
  const [messageTab, setMessageTab] = useState<'interact' | 'chat' | 'notice'>('interact')
  const [settingsTab, setSettingsTab] = useState<'system' | 'interface' | 'user'>('system')
  const userTab = useUserStore((s) => s.tab)
  const userIsSelf = useUserStore((s) => s.isSelf)
  const [libraryCats, setLibraryCats] = useState<Array<{ mid?: number | string; name: string }>>([])
  const [libCat, setLibCat] = useState<{ mid?: number | string; name: string }>({ name: '原创作品' })
  const editingPath = useEditorStore((s) => s.currentPath)
  const totalUnread = useNotificationStore((s) => s.totalUnread)
  const pulling = useDocsStore((s) => s.pulling)
  const uid = currentUid()
  const backGuard = useRef(false)
  const pushedLayers = useRef(0)
  const touchStart = useRef<{ x: number; y: number } | null>(null)
  const [dragX, setDragX] = useState(0)
  const pageDir = useRef(1)
  const [pageAnim, setPageAnim] = useState<'next' | 'prev' | null>(null)

  const sessionAvatar = (() => {
    const raw = session?.userinfo?.avatar
    return typeof raw === 'string' && raw ? cachedImageUrl(raw) : null
  })()

  useEffect(() => {
    if (session) void useNotificationStore.getState().refreshUnread()
  }, [session])

  const go = (next: MobileTab): void => {
    const order: MobileTab[] = ['home', 'mine', 'writing', 'messages', 'settings']
    pageDir.current = order.indexOf(next) >= order.indexOf(tab) ? 1 : -1
    // 切页签时一律收起文章栏，避免上一个页面的抽屉盖住新页面。
    useUiStore.getState().closePanel()
    setTab(next)
    if (next === 'home') {
      setHomeTab('recommend')
      setLibSearch(false)
      setLibSubmitted(false)
      useUiStore.getState().setSection('recommend')
      useReaderStore.getState().closeArticle()
      useUiStore.getState().closeUserPage()
      useUiStore.getState().closeList()
    } else {
      useReaderStore.getState().closeArticle()
      useUiStore.getState().closeUserPage()
      useUiStore.getState().closeList()
      if (next === 'writing') useUiStore.getState().setSection('writing')
      if (next === 'mine' && uid) useUiStore.getState().openUserPage(uid)
    }
  }

  // 作品库二级分类：优先 metasList type=category，接口不可用时用桌面四项兜底
  useEffect(() => {
    if (tab !== 'home' || homeTab !== 'library' || libraryCats.length > 0) return
    void window.hqsf.listCategories().then((res) => {
      if (res.ok && res.data.length > 0) {
        const cats = res.data.map((c) => ({ mid: c.mid, name: c.name }))
        setLibraryCats(cats)
        setLibCat(cats[0])
      } else {
        setLibraryCats(['原创作品', '科幻杂谈', '官方公告', '外文翻译'].map((name) => ({ name })))
      }
    })
  }, [tab, homeTab, libraryCats.length])

  // 手机端写作页没有桌面左栏，需要自己刷新本地存档树与云端四态列表
  useEffect(() => {
    if (tab === 'writing') {
      void (async () => {
        await useDocsStore.getState().refreshLocal()
        await useDocsStore.getState().refreshArticles()
        const editor = useEditorStore.getState()
        const empties = collectEmptyUntitled(useDocsStore.getState().localTree, editor.currentPath)
        for (const path of empties) await useDocsStore.getState().deleteLocal(path)
      })()
    }
  }, [tab, session])

  // 进入「我的」每次回动态顶部（openUserPage 同 uid 会重置 tab）
  useEffect(() => {
    if (tab === 'mine' && uid) useUiStore.getState().openUserPage(uid)
  }, [tab, uid])

  // 文章页优先于所有 tab（搜索/首页/用户页都可能打开文章）
  useEffect(() => {
    if (readingCid) setTab('home')
  }, [readingCid])

  // 每多一层页面就多压一条 history，系统返回才有东西可退。
  const homeSubLayer = tab === 'home' && homeTab !== 'recommend' && !libSearch ? 1 : 0
  const layerCount =
    (loginOpen ? 1 : 0) +
    (libSearch ? 1 : 0) +
    (tab === 'writing' && editingPath ? 1 : 0) +
    (readingCid ? 1 : 0) +
    homeSubLayer +
    (listContext ? 1 : 0) +
    (userPageUid ? 1 : 0) +
    (panelOpen ? 1 : 0) +
    (historyOpen ? 1 : 0) +
    (tab !== 'home' ? 1 : 0)

  useEffect(() => {
    history.replaceState({ hqsfMobile: true }, '')
    return () => {
      pushedLayers.current = 0
    }
  }, [])

  useEffect(() => {
    while (pushedLayers.current < layerCount) {
      history.pushState({ hqsfMobile: true }, '')
      pushedLayers.current += 1
    }
    if (pushedLayers.current > layerCount) pushedLayers.current = layerCount
  }, [layerCount])

  // Android 系统返回：先退右栏 → 再退列表/文章/子页 → 最后回首页；首页不拦截，交给系统退出。
  useEffect(() => {
    const onPop = (): void => {
      if (backGuard.current) return
      const ui = useUiStore.getState()
      const reader = useReaderStore.getState()
      pushedLayers.current = Math.max(0, pushedLayers.current - 1)
      if (ui.loginOpen) {
        ui.closeLogin()
      } else if (ui.panelOpen) {
        ui.closePanel()
      } else if (useEditorStore.getState().currentPath) {
        const editor = useEditorStore.getState()
        const path = editor.currentPath
        const empty = !editor.content.trim()
        const untitled = /(^|\/)未命名草稿(?:\s*\(\d+\))?\.md$/i.test(path ?? '')
        void (async () => {
          await editor.close()
          // 新建后一个字没写、标题也没改就退出：删掉空草稿，不在列表里留垃圾。
          if (path && empty && untitled) await useDocsStore.getState().deleteLocal(path)
        })()
      } else if (ui.listContext) {
        ui.closeList()
      } else if (reader.readingCid) {
        reader.closeArticle()
      } else if (libSearch) {
        setLibSearch(false)
        setLibSubmitted(false)
      } else if (historyOpen) {
        setHistoryOpen(false)
      } else if (tab === 'home' && homeTab !== 'recommend') {
        setHomeTab('recommend')
        ui.setSection('recommend')
        ui.closeList()
        ui.closeUserPage()
      } else if (ui.userPageUid || tab !== 'home') {
        setTab('home')
        ui.closeUserPage()
        ui.setSection(homeTab)
      } else {
        // 根页面：允许系统返回退出应用。
        backGuard.current = true
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [tab, homeTab, historyOpen, editingPath, loginOpen, libSearch])

  // Android 壳层在 onBackPressed 里调用：返回 true 表示已交给页面 history，false 才退出应用。
  // WebView 的 canGoBack() 不把 pushState 算进原生返回栈，所以不能依赖 Wry 的自动处理。
  useEffect(() => {
    ;(window as unknown as { __hqsfBack?: () => boolean }).__hqsfBack = () => {
      if (pushedLayers.current > 0) {
        history.back()
        return true
      }
      return false
    }
    return () => {
      delete (window as unknown as { __hqsfBack?: () => boolean }).__hqsfBack
    }
  }, [])

  function openSearch(): void {
    setLibSearch(true)
    setLibQuery('')
    setLibSubmitted(false)
  }

  function closeSearch(): void {
    setLibSearch(false)
    setLibQuery('')
    setLibSubmitted(false)
  }

  function submitSearch(): void {
    const q = libQuery.trim()
    if (!q) return
    setLibSubmitted(true)
  }

  async function lucky(): Promise<void> {
    if (wormholeLoading) return
    setWormholeLoading(true)
    try {
      const first = await window.hqsf.listRemoteArticles({
        searchParams: { type: 'post' },
        limit: 1,
        page: 1,
        order: 'created'
      })
      const total = first.ok ? first.data.total : 0
      if (total <= 0) return
      const page = 1 + Math.floor(Math.random() * Math.ceil(total / 50))
      const res = await window.hqsf.listRemoteArticles({
        searchParams: { type: 'post' },
        limit: 50,
        page,
        order: 'created'
      })
      if (!res.ok || res.data.items.length === 0) return
      const item = res.data.items[Math.floor(Math.random() * res.data.items.length)]
      if (item?.cid) await useReaderStore.getState().openArticle(item.cid)
    } catch {
      // 随机打开失败静默
    } finally {
      setWormholeLoading(false)
    }
  }

  /** 页面内的左右滑动：翻页动画由 pageAnim 驱动，顶栏下划线由 MobileTabBar 跟随 dragX。 */
  function onTouchStart(e: TouchEvent<HTMLDivElement>): void {
    if (e.touches.length !== 1) {
      touchStart.current = null
      return
    }
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    setDragX(0)
  }

  type SwipeInfo = { length: number; index: number; go: (dir: number) => void }

  /** 当前页面可切换的页签集合：首/尾页签不允许再向外滑。 */
  function swipeInfo(): SwipeInfo | null {
    if (readingCid || libSearch || listContext || loginOpen || historyOpen) return null
    if (tab === 'mine' && uid) {
      const tabs = userIsSelf ? USER_TABS_SELF : USER_TABS_OTHER
      const index = Math.max(0, tabs.findIndex((t) => t.key === userTab))
      return {
        length: tabs.length,
        index,
        go: (dir) => {
          const next = tabs[index + dir]
          if (next) useUserStore.getState().setTab(next.key)
        }
      }
    }
    if (userPageUid && tab !== 'mine') {
      const tabs = userIsSelf ? USER_TABS_SELF : USER_TABS_OTHER
      const index = Math.max(0, tabs.findIndex((t) => t.key === userTab))
      return {
        length: tabs.length,
        index,
        go: (dir) => {
          const next = tabs[index + dir]
          if (next) useUserStore.getState().setTab(next.key)
        }
      }
    }
    if (tab === 'home' && !listContext) {
      if (homeTab === 'library') {
        const cats = libraryCats.length > 0 ? libraryCats : [{ name: '原创作品' }]
        // 在作品库分类前再放一个「连载」槽位：从第一个分类向右滑可回到连载，
        // 其余方向仍按分类顺序切换。
        const active = Math.max(0, cats.findIndex((c) => c.name === libCat.name))
        const index = active + 1
        return {
          length: cats.length + 1,
          index,
          go: (dir) => {
            if (dir < 0 && active === 0) {
              setHomeTab('serial')
              useUiStore.getState().setSection('serial')
              useUiStore.getState().closeList()
              return
            }
            const next = cats[active + dir]
            if (!next) return
            setLibCat(next)
            void useReaderStore.getState().setOrder(next.name === '原创作品' ? 'score' : 'created')
          }
        }
      }
      const index = Math.max(0, HOME_TABS.findIndex((t) => t.key === homeTab))
      return {
        length: HOME_TABS.length,
        index,
        go: (dir) => {
          const next = HOME_TABS[index + dir]
          if (!next) return
          setHomeTab(next.key)
          useUiStore.getState().setSection(next.key)
          useUiStore.getState().closeList()
        }
      }
    }
    if (tab === 'writing' && !editingPath) {
      const tabs = [{ key: 'local' as const }, ...WRITING_STATES]
      const index = Math.max(0, tabs.findIndex((t) => t.key === writingTab))
      return {
        length: tabs.length,
        index,
        go: (dir) => {
          const next = tabs[index + dir]
          if (next) setWritingTab(next.key)
        }
      }
    }
    if (tab === 'messages') {
      const index = Math.max(0, MSG_TABS.findIndex((t) => t.key === messageTab))
      return {
        length: MSG_TABS.length,
        index,
        go: (dir) => {
          const next = MSG_TABS[index + dir]
          if (next) setMessageTab(next.key)
        }
      }
    }
    if (tab === 'settings') {
      const index = Math.max(0, SETTINGS_TABS.findIndex((t) => t.key === settingsTab))
      return {
        length: SETTINGS_TABS.length,
        index,
        go: (dir) => {
          const next = SETTINGS_TABS[index + dir]
          if (next) setSettingsTab(next.key)
        }
      }
    }
    return null
  }

  function canSwipe(dir: number): boolean {
    const info = swipeInfo()
    return !!info && info.index + dir >= 0 && info.index + dir < info.length
  }

  function onTouchMove(e: TouchEvent<HTMLDivElement>): void {
    const start = touchStart.current
    if (!start || e.touches.length !== 1) return
    const dx = e.touches[0].clientX - start.x
    const dy = e.touches[0].clientY - start.y
    if (Math.abs(dx) < Math.abs(dy) * 1.1) return
    if (!canSwipe(dx < 0 ? 1 : -1)) {
      setDragX(0)
      return
    }
    setDragX(Math.max(-120, Math.min(120, dx)))
  }

  function onTouchEnd(e: TouchEvent<HTMLDivElement>): void {
    const start = touchStart.current
    touchStart.current = null
    const dx = start ? e.changedTouches[0].clientX - start.x : 0
    const dy = start ? e.changedTouches[0].clientY - start.y : 0
    setDragX(0)
    if (!start || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.3) return
    const dir = dx < 0 ? 1 : -1
    if (!canSwipe(dir)) return
    pageDir.current = dir
    swipeInfo()?.go(dir)
  }

  const pageGroupKey = readingCid
    ? `reader:${readingCid}`
    : userPageUid
      ? `user:${userPageUid}:${userTab}`
      : tab === 'home'
        ? `home:${homeTab}`
        : tab === 'mine'
          ? `mine:${userTab}`
          : tab === 'writing'
            ? `writing:${editingPath ? 'edit' : writingTab}`
            : tab === 'messages'
              ? `messages:${messageTab}`
              : tab === 'settings'
                ? `settings:${settingsTab}`
                : tab

  useEffect(() => {
    if (!pageGroupKey) return
    setPageAnim(pageDir.current > 0 ? 'next' : 'prev')
    const timer = window.setTimeout(() => setPageAnim(null), 240)
    return () => window.clearTimeout(timer)
  }, [pageGroupKey])

  const pageClass = `mobile-content${pageAnim ? ` mobile-page-${pageAnim}` : ''}`
  // 内容跟手；顶栏指示条反向移动（手指向左 = 翻到右页，装饰条向右）。
  const pageStyle = dragX !== 0 ? { transform: `translateX(${dragX * 0.34}px)`, transition: 'none' } : undefined

  const editorAction = (name: string): void => {
    window.dispatchEvent(new CustomEvent(name))
  }
  const undo = (): void => {
    document.querySelector<HTMLElement>('.ProseMirror')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })
    )
  }
  const redo = (): void => {
    document.querySelector<HTMLElement>('.ProseMirror')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true })
    )
  }

  const openArticle = async (cid: string, filePath: string): Promise<void> => {
    if (cid) await useReaderStore.getState().openArticle(cid)
    else if (filePath) await useEditorStore.getState().open(filePath)
  }

  if (readingCid) {
    return (
      <div className="mobile-app mobile-reader-app" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
        <header className="mobile-topbar mobile-reader-topbar">
          <span className="mobile-title mobile-reader-title">{articleTitle}</span>
          <button
            className={`mobile-icon-btn${panelOpen && panelMode === 'article' ? ' active' : ''}`}
            onClick={() => {
              const ui = useUiStore.getState()
              if (ui.panelOpen && ui.panelMode === 'article') ui.closePanel()
              else ui.openPanelTab(ui.panelTab || 'toc')
            }}
            title="文章栏"
            aria-label="文章栏"
          >
            {panelOpen && panelMode === 'article' ? <PanelRightClose size={18} /> : <MessageCircle size={18} />}
          </button>
        </header>
        <div className="mobile-content mobile-reader-content">
          <ReaderView />
        </div>
        {panelOpen && panelMode === 'article' && (
          <button className="mobile-panel-mask" onClick={closePanel} aria-label="收起文章栏" />
        )}
      </div>
    )
  }

  if (userPageUid && tab !== 'mine') {
    return (
      <div className="mobile-app" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
        <header className="mobile-topbar mobile-tabs-topbar">
          <button className="mobile-icon-btn" onClick={() => useUiStore.getState().closeUserPage()} title="返回">
            <ChevronLeft size={22} />
          </button>
          <MobileTabBar
            items={userIsSelf ? USER_TABS_SELF : USER_TABS_OTHER}
            active={userTab}
            dragX={dragX}
            onChange={(key) => useUserStore.getState().setTab(key)}
          />
        </header>
        <div className={pageClass} style={pageStyle}>
          <UserView />
        </div>
      </div>
    )
  }

  return (
    <div className="mobile-app" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      {tab === 'home' && (
        <>
          <header className={`mobile-topbar mobile-tabs-topbar${libSearch ? ' mobile-search-topbar' : ''}`}>
            {libSearch ? (
              <>
                <div className="mobile-search-box mobile-search-box-live">
                  <input
                    value={libQuery}
                    autoFocus
                    placeholder="在荒启中搜索"
                    onChange={(e) => {
                      setLibQuery(e.target.value)
                      if (!e.target.value) setLibSubmitted(false)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitSearch()
                    }}
                  />
                </div>
                <button className="mobile-search-shortcut" onClick={() => void lucky()} disabled={wormholeLoading}>
                  {wormholeLoading ? '乱流中…' : '时空乱流'}
                </button>
                <button className="mobile-icon-btn mobile-search-submit-icon" onClick={submitSearch} title="搜索">
                  <Search size={18} />
                </button>
              </>
            ) : (
              <>
                <MobileTabBar
                  items={HOME_TABS}
                  active={homeTab}
                  dragX={dragX}
                  onChange={(key) => {
                    pageDir.current =
                      HOME_TABS.findIndex((t) => t.key === key) >= HOME_TABS.findIndex((t) => t.key === homeTab) ? 1 : -1
                    setHomeTab(key)
                    useUiStore.getState().setSection(key)
                    useUiStore.getState().closeList()
                  }}
                />
                <button className="mobile-icon-btn mobile-tab-search" onClick={openSearch} title="搜索">
                  <Search size={19} />
                </button>
              </>
            )}
          </header>
          {libSearch && !libSubmitted && <div className="mobile-search-overlay" onClick={closeSearch} />}
          <div className={pageClass} style={pageStyle}>
            {libSearch && libSubmitted ? (
              <LibraryHome hideHero initialQuery={libQuery} autoSearch />
            ) : listContext ? (
              <div className="mobile-subpage">
                <ArticleListView
                  title={listContext.title}
                  mid={listContext.mid}
                  searchParams={listContext.searchParams}
                  choice={listContext.choice}
                  activityPhase={listContext.activityPhase}
                  hideScoreboard={listContext.hideScoreboard}
                  activityMeta={listContext.meta}
                />
              </div>
            ) : homeTab === 'recommend' ? (
              <RecommendHome />
            ) : homeTab === 'activity' ? (
              <ActivityHome />
            ) : homeTab === 'serial' ? (
              <SerialHome />
            ) : (
              <>
                <div className="mobile-library-tabs">
                  {(libraryCats.length > 0 ? libraryCats : [{ name: '原创作品' }]).map((cat) => (
                    <button
                      key={cat.name}
                      className={`mobile-home-tab${libCat.name === cat.name ? ' active' : ''}`}
                      onClick={() => {
                        setLibCat(cat)
                        void useReaderStore.getState().setOrder(cat.name === '原创作品' ? 'score' : 'created')
                      }}
                    >
                      {cat.name}
                    </button>
                  ))}
                </div>
                <div className="mobile-library-list">
                  <ArticleListView
                    title={libCat.name}
                    {...(libCat.mid != null ? { mid: libCat.mid } : { searchParams: { type: 'post' } })}
                  />
                </div>
              </>
            )}
          </div>
        </>
      )}

      {tab === 'mine' &&
        (uid ? (
          <>
            <header className="mobile-topbar mobile-tabs-topbar">
              <MobileTabBar
                items={userIsSelf ? USER_TABS_SELF : USER_TABS_OTHER}
                active={userTab}
                dragX={dragX}
                onChange={(key) => useUserStore.getState().setTab(key)}
              />
              <button className="mobile-icon-btn" onClick={() => setHistoryOpen(true)} title="阅读历史">
                <History size={19} />
              </button>
            </header>
            <div className={pageClass} style={pageStyle}>
              <UserView />
            </div>
          </>
        ) : (
          <div className="mobile-content mobile-login-content">
            <LoginView />
          </div>
        ))}

      {tab === 'writing' && (
        <>
          <header
            className={`mobile-topbar mobile-tabs-topbar mobile-writing-topbar${editingPath ? ' mobile-editor-topbar' : ''}`}
          >
            {editingPath ? (
              <>
                <div className="mobile-editor-actions">
                  <button className="mobile-icon-btn" onClick={() => void useEditorStore.getState().save()} title="保存">
                    <Save size={18} />
                  </button>
                  <button className="mobile-icon-btn" onClick={() => editorAction('hqsf:editor-sync')} title="同步到草稿">
                    <CloudUpload size={18} />
                  </button>
                  <button className="mobile-icon-btn" onClick={() => editorAction('hqsf:editor-publish')} title="发布">
                    <Send size={18} />
                  </button>
                  <button className="mobile-icon-btn" onClick={() => editorAction('hqsf:editor-forbidden')} title="违禁词检测">
                    <ShieldCheck size={18} />
                  </button>
                </div>
                <div className="mobile-editor-actions">
                  <button className="mobile-icon-btn" onClick={undo} title="撤销">
                    <Undo2 size={18} />
                  </button>
                  <button className="mobile-icon-btn" onClick={redo} title="重做">
                    <Redo2 size={18} />
                  </button>
                </div>
              </>
            ) : (
              <>
                <MobileTabBar
                  items={WRITING_TABS}
                  active={writingTab}
                  dragX={dragX}
                  onChange={(key) => {
                    pageDir.current =
                      WRITING_TABS.findIndex((t) => t.key === key) >= WRITING_TABS.findIndex((t) => t.key === writingTab) ? 1 : -1
                    setWritingTab(key)
                  }}
                />
                <div className="mobile-topbar-actions">
                  <button
                    className="mobile-icon-btn"
                    onClick={() => {
                      void useEditorStore
                        .getState()
                        .createUntitledDraft()
                        .then(() => useDocsStore.getState().refreshLocal())
                    }}
                    title="新建本地草稿"
                  >
                    <FilePlus size={19} />
                  </button>
                  <button
                    className="mobile-icon-btn"
                    disabled={pulling}
                    onClick={() => void useDocsStore.getState().pull()}
                    title={pulling ? '正在从云端下载…' : '从云端下载草稿与状态'}
                  >
                    <CloudDownload size={19} />
                  </button>
                  <button
                    className="mobile-icon-btn"
                    onClick={() =>
                      void window.hqsf.showMessageBox({
                        type: 'info',
                        title: '导出存档',
                        message:
                          'Android 版草稿保存在应用私有目录，暂未接入系统文件选择器。需要导出时可先用「从云端下载」同步到云端。'
                      })
                    }
                    title="导出存档"
                  >
                    <Share2 size={19} />
                  </button>
                </div>
              </>
            )}
          </header>
          <div className={`mobile-content${editingPath ? ' mobile-editor-content' : ''}${pageAnim ? ` mobile-page-${pageAnim}` : ''}`} style={pageStyle}>
            {writingTab === 'local' ? (
              <EditorPane />
            ) : (
              <MobileWritingState type={writingTab} onOpen={(cid, filePath) => void openArticle(cid, filePath)} />
            )}
          </div>
        </>
      )}

      {tab === 'messages' && (
        <>
          <header className="mobile-topbar mobile-tabs-topbar">
            <MobileTabBar
              items={MSG_TABS}
              active={messageTab}
              dragX={dragX}
              onChange={(key) => {
                pageDir.current = MSG_TABS.findIndex((t) => t.key === key) >= MSG_TABS.findIndex((t) => t.key === messageTab) ? 1 : -1
                setMessageTab(key)
              }}
            />
          </header>
          <div className={pageClass} style={pageStyle}>
            <NotificationPanel tab={messageTab} onTabChange={setMessageTab} hideTabs />
          </div>
        </>
      )}

      {tab === 'settings' && (
        <>
          <header className="mobile-topbar mobile-tabs-topbar">
            <MobileTabBar
              items={SETTINGS_TABS}
              active={settingsTab}
              dragX={dragX}
              onChange={(key) => {
                pageDir.current = SETTINGS_TABS.findIndex((t) => t.key === key) >= SETTINGS_TABS.findIndex((t) => t.key === settingsTab) ? 1 : -1
                setSettingsTab(key)
              }}
            />
          </header>
          <div className={pageClass} style={pageStyle}>
            <SettingsPanel mobile tab={settingsTab} onTabChange={setSettingsTab} hideSubtabs />
          </div>
        </>
      )}

      {historyOpen && (
        <div className="mobile-sheet-mask" onClick={() => setHistoryOpen(false)}>
          <div className="mobile-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="mobile-sheet-head">
              <span>阅读历史</span>
              <button className="mobile-icon-btn" onClick={() => setHistoryOpen(false)} title="关闭">
                ×
              </button>
            </div>
            <HistoryPanel />
          </div>
        </div>
      )}

      {!editingPath && (
        <nav className="mobile-bottom-nav">
          <MobileNavButton active={tab === 'home'} icon={<House size={22} />} label="首页" onClick={() => go('home')} />
          <MobileNavButton
            active={tab === 'mine'}
            icon={sessionAvatar ? <img className="mobile-nav-avatar" src={sessionAvatar} alt="" /> : <User size={22} />}
            label="我的"
            onClick={() => go('mine')}
          />
          <button className={`mobile-nav-write${tab === 'writing' ? ' active' : ''}`} onClick={() => go('writing')} title="写作">
            <PenLine size={24} fill={tab === 'writing' ? 'currentColor' : 'none'} />
          </button>
          <MobileNavButton
            active={tab === 'messages'}
            icon={<MessageCircle size={22} />}
            label="消息"
            badge={totalUnread}
            onClick={() => go('messages')}
          />
          <MobileNavButton
            active={tab === 'settings'}
            icon={<MobileSettingsIcon active={tab === 'settings'} />}
            label="设置"
            onClick={() => go('settings')}
          />
        </nav>
      )}
    </div>
  )
}

function MobileTabBar<K extends string>({
  items,
  active,
  onChange,
  dragX = 0
}: {
  items: ReadonlyArray<{ key: K; label: string; badge?: number }>
  active: K
  onChange: (key: K) => void
  dragX?: number
}): React.JSX.Element {
  const barRef = useRef<HTMLDivElement | null>(null)
  const [indicator, setIndicator] = useState({ left: 0, width: 0 })

  useEffect(() => {
    const measure = (): void => {
      const el = barRef.current?.querySelector<HTMLElement>('.mobile-home-tab.active')
      if (el) setIndicator({ left: el.offsetLeft, width: el.offsetWidth })
    }
    measure()
    const timer = window.setTimeout(measure, 60)
    const observer =
      typeof ResizeObserver !== 'undefined' && barRef.current ? new ResizeObserver(measure) : null
    if (observer && barRef.current) observer.observe(barRef.current)
    return () => {
      window.clearTimeout(timer)
      observer?.disconnect()
    }
  }, [active, items.length])

  return (
    <div className="mobile-home-tabs mobile-tabs-inline mobile-tabbar" ref={barRef}>
      {items.map((item) => (
        <button
          key={item.key}
          className={`mobile-home-tab${active === item.key ? ' active' : ''}`}
          onClick={() => onChange(item.key)}
        >
          {item.label}
          {item.badge != null && item.badge > 0 ? (
            <span className="mobile-nav-badge mobile-tab-badge">{item.badge > 99 ? '99+' : item.badge}</span>
          ) : null}
        </button>
      ))}
      <span
        className="mobile-tab-indicator"
        style={{
          left: indicator.left,
          width: indicator.width,
          transform: dragX !== 0 ? `translateX(${-dragX * 0.34}px)` : undefined,
          transition: dragX !== 0 ? 'none' : undefined
        }}
      />
    </div>
  )
}

function MobileNavButton({
  active,
  icon,
  label,
  badge,
  onClick
}: {
  active: boolean
  icon: ReactElement
  label: string
  badge?: number
  onClick: () => void
}): React.JSX.Element {
  return (
    <button className={`mobile-nav-btn${active ? ' active' : ''}`} onClick={onClick}>
      <span className="mobile-nav-icon">
        {isValidElement(icon) && typeof icon.type !== 'string'
          ? cloneElement(icon as ReactElement<{ fill?: string }>, { fill: active ? 'currentColor' : 'none' })
          : icon}
        {badge != null && badge > 0 ? <span className="mobile-nav-badge">{badge > 99 ? '99+' : badge}</span> : null}
      </span>
      <span>{label}</span>
    </button>
  )
}

function MobileSettingsIcon({ active }: { active: boolean }): React.JSX.Element {
  return (
    <span className="mobile-nav-gear">
      <Settings size={22} fill={active ? 'currentColor' : 'none'} />
      {active && <i className="mobile-nav-gear-hole" />}
    </span>
  )
}

function MobileWritingState({
  type,
  onOpen
}: {
  type: ArticleType
  onOpen: (cid: string, filePath: string) => void
}): React.JSX.Element {
  const articles = useDocsStore((s) => s.articles)
  const loading = useDocsStore((s) => s.pulling)
  useEffect(() => {
    void useDocsStore.getState().refreshArticles()
  }, [])
  const list = articles.filter((a) => a.type === type)
  return (
    <div className="mobile-writing-state">
      {loading && <p className="muted">正在同步 …</p>}
      {list.length === 0 && <p className="mobile-empty">这里还没有文章</p>}
      {list.map((a) => (
        <button key={a.cid || a.filePath} className="mobile-writing-card" onClick={() => onOpen(a.cid, a.filePath)}>
          <span className="mobile-writing-card-title">{a.title || '（无标题）'}</span>
          <span className="mobile-writing-card-meta">
            {a.remoteModified ? new Date(a.remoteModified * 1000).toLocaleDateString() : ''}
          </span>
        </button>
      ))}
    </div>
  )
}
