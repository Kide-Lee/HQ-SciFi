import { SECTION_LABELS, useUiStore } from '../stores/ui'
import { EditorPane } from './EditorPane'

/** 主界面：写作视图（M1 编辑器）与其他栏目占位（M2/M3 接入） */
export function MainArea(): React.JSX.Element {
  const section = useUiStore((s) => s.section)
  const selectedId = useUiStore((s) => s.selectedId)

  if (section === 'writing') {
    return <EditorPane />
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
          <p className="muted">该栏目将在 M2/M3 接入（阅读、评审、内容浏览）。</p>
        </div>
      </div>
    </main>
  )
}
