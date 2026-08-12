import { useEffect, useMemo } from 'react'
import { SECTION_LABELS, useUiStore } from '../stores/ui'
import { useReaderStore } from '../stores/reader'
import { EditorPane } from './EditorPane'
import { ReaderView } from './ReaderView'
import { ArticleListView } from './ArticleListView'
import { GptListView } from './GptListView'
import { RecommendHome } from './RecommendHome'
import { SerialHome } from './SerialHome'
import { ActivityHome } from './ActivityHome'
import { LibraryHome } from './LibraryHome'
import { RightPanel, type RightTab } from './RightPanel'
import { SearchPanel } from './SearchPanel'

/** v0.0.6+：栏目/列表页外壳——内容 + 右栏（搜索列表文章，点击打开） */
function ListShell({
  children,
  contentClass = ''
}: {
  children: React.ReactNode
  contentClass?: string
}): React.JSX.Element {
  const panelOpen = useUiStore((s) => s.panelOpen)
  const panelTab = useUiStore((s) => s.panelTab)
  const setPanelTab = useUiStore((s) => s.setPanelTab)
  const list = useReaderStore((s) => s.list)
  const homeList = useReaderStore((s) => s.homeList)
  const openArticle = useReaderStore((s) => s.openArticle)

  const tabs = useMemo<Array<RightTab<'search'>>>(() => {
    // 列表页数据优先；栏目首页用上报的 homeList
    const src = list.length > 0 ? list : homeList
    const items = src.map((it) => ({ id: it.cid, title: it.title, text: it.text }))
    return [
      {
        key: 'search',
        label: '搜索',
        content: <SearchPanel items={items} onOpenItem={(cid) => void openArticle(cid)} />
      }
    ]
  }, [list, homeList, openArticle])

  return (
    <main className="main-area">
      <div className={`main-content${contentClass ? ` ${contentClass}` : ''}`}>{children}</div>
      <RightPanel tabs={tabs} activeTab={panelTab} onTabChange={setPanelTab} open={panelOpen} />
    </main>
  )
}

/** 主界面：写作视图（M1 编辑器）/ 阅读视图（M2 读审一体）/ 栏目列表（M2 作品库 / M3 推荐·连载·活动） */
export function MainArea(): React.JSX.Element {
  const section = useUiStore((s) => s.section)
  const selectedId = useUiStore((s) => s.selectedId)
  const listContext = useUiStore((s) => s.listContext)
  const readingCid = useReaderStore((s) => s.readingCid)

  // v0.0.6+：切换栏目时清空首页文章合集（避免旧栏目数据残留到右栏搜索）
  useEffect(() => {
    useReaderStore.getState().setHomeList([])
  }, [section])

  // 写作视图：编辑本地草稿；若打开了远端文章（阅读），显示阅读视图
  if (section === 'writing') {
    if (readingCid) return <ReaderView />
    return <EditorPane />
  }

  // 阅读态（从列表/侧栏打开的文章）
  if (readingCid) {
    return <ReaderView />
  }

  // v0.0.2：栏目首页——点击「推荐/连载/活动/作品库」顶层、未选中子项时显示
  if (!listContext) {
    if (section === 'recommend') {
      return (
        <ListShell>
          <RecommendHome />
        </ListShell>
      )
    }
    if (section === 'serial') {
      return (
        <ListShell>
          <SerialHome />
        </ListShell>
      )
    }
    if (section === 'activity') {
      return (
        <ListShell>
          <ActivityHome />
        </ListShell>
      )
    }
    if (section === 'library') {
      return (
        <ListShell>
          <LibraryHome />
        </ListShell>
      )
    }
  }

  // 栏目列表：作品库分类 / 推荐（精选、AI模型）/ 连载（合集、连载）/ 活动（练笔期次）
  // M3：listContext 存在时渲染对应列表；kind=gpt 渲染 AI 模型卡片
  if (section === 'library' || section === 'recommend' || section === 'serial' || section === 'activity') {
    return (
      <ListShell contentClass="list-content">
        {listContext?.kind === 'gpt' ? (
          <GptListView title={listContext.title} />
        ) : (
          <ArticleListView
            title={`${SECTION_LABELS[section]} · ${listContext?.title ?? selectedId ?? '全部文章'}`}
            mid={listContext?.mid}
            searchParams={listContext?.searchParams}
            choice={listContext?.choice}
            activityPhase={listContext?.activityPhase}
            activityMeta={listContext?.meta}
          />
        )}
      </ListShell>
    )
  }

  return (
    <ListShell>
      <header className="main-header">
        <h1>{SECTION_LABELS[section]}</h1>
        {selectedId && <span className="crumb"> / {selectedId}</span>}
      </header>
      <div className="placeholder-card">
        <h2>{selectedId ?? SECTION_LABELS[section]}</h2>
        <p className="muted">该栏目将在后续版本接入。</p>
      </div>
    </ListShell>
  )
}
