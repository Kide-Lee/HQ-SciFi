import { SECTION_LABELS, useUiStore } from '../stores/ui'
import { useReaderStore } from '../stores/reader'
import { EditorPane } from './EditorPane'
import { ReaderView } from './ReaderView'
import { ArticleListView } from './ArticleListView'
import { GptListView } from './GptListView'

/** 主界面：写作视图（M1 编辑器）/ 阅读视图（M2 读审一体）/ 栏目列表（M2 作品库 / M3 推荐·连载·活动） */
export function MainArea(): React.JSX.Element {
  const section = useUiStore((s) => s.section)
  const selectedId = useUiStore((s) => s.selectedId)
  const listContext = useUiStore((s) => s.listContext)
  const readingCid = useReaderStore((s) => s.readingCid)

  // 写作视图：编辑本地草稿；若打开了远端文章（阅读），显示阅读视图
  if (section === 'writing') {
    if (readingCid) return <ReaderView />
    return <EditorPane />
  }

  // 阅读态（从列表/侧栏打开的文章）
  if (readingCid) {
    return <ReaderView />
  }

  // 栏目列表：作品库分类 / 推荐（精选、AI模型）/ 连载（合集、连载）/ 活动（练笔期次）
  // M3：listContext 存在时渲染对应列表；kind=gpt 渲染 AI 模型卡片
  if (section === 'library' || section === 'recommend' || section === 'serial' || section === 'activity') {
    return (
      <main className="main-area">
        <div className="main-content list-content">
          {listContext?.kind === 'gpt' ? (
            <GptListView title={listContext.title} />
          ) : (
            <ArticleListView
              title={`${SECTION_LABELS[section]} · ${listContext?.title ?? selectedId ?? '全部文章'}`}
              mid={listContext?.mid}
              searchParams={listContext?.searchParams}
              choice={listContext?.choice}
            />
          )}
        </div>
      </main>
    )
  }

  return (
    <main className="main-area">
      <header className="main-header">
        <h1>{SECTION_LABELS[section]}</h1>
        {selectedId && <span className="crumb"> / {selectedId}</span>}
      </header>
      <div className="main-content">
        <div className="placeholder-card">
          <h2>{selectedId ?? SECTION_LABELS[section]}</h2>
          <p className="muted">该栏目将在后续版本接入。</p>
        </div>
      </div>
    </main>
  )
}
