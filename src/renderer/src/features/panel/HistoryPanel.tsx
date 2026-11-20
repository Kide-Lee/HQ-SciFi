import { Trash2, X } from 'lucide-react'
import { useHistoryStore } from '../../stores/history'
import { useReaderStore } from '../../stores/reader'
import { useUiStore } from '../../stores/ui'
import { ArticleCard } from '../browse/ArticleListView'

/**
 * v1.1.12：阅读历史（右栏全局 tab，阅读 / 写作 / 栏目 / 用户页都可用）。
 *
 * 数据来自 `stores/history.ts`（localStorage，只记远端文章）；
 * 卡片复用列表/首页同款 `ArticleCard`（标题/摘要/作者/统计/评分/时间），
 * 不另写一套样式；仅额外叠一个「从历史中移除」按钮。
 */
export function HistoryPanel(): React.JSX.Element {
  const entries = useHistoryStore((s) => s.entries)
  const removeEntry = useHistoryStore((s) => s.remove)
  const clear = useHistoryStore((s) => s.clear)
  const openArticle = useReaderStore((s) => s.openArticle)
  const readingCid = useReaderStore((s) => s.readingCid)

  /** 重新打开历史文章：用户页优先于阅读态，先退出用户页再走正常阅读流程 */
  async function open(cid: string): Promise<void> {
    if (cid === readingCid) return
    useUiStore.getState().closeUserPage()
    await openArticle(cid)
  }

  async function clearAll(): Promise<void> {
    const confirm = await window.hqsf.showMessageBox({
      type: 'question',
      title: '清空阅读历史',
      message: `将移除全部 ${entries.length} 条阅读记录，不影响文章本身与本地文档。`,
      buttons: ['取消', '清空'],
      defaultId: 1,
      cancelId: 0
    })
    if (!confirm.ok || confirm.data.response !== 1) return
    clear()
  }

  return (
    <div className="history-panel">
      <div className="history-head">
        <span className="history-count">{entries.length > 0 ? `共 ${entries.length} 篇` : '阅读历史'}</span>
        {entries.length > 0 && (
          <button className="history-clear" onClick={() => void clearAll()} title="清空阅读历史">
            <Trash2 size={12} />
            清空
          </button>
        )}
      </div>
      <div className="history-list">
        {entries.length === 0 && (
          <div className="muted history-empty">还没有阅读记录，读过的文章会出现在这里</div>
        )}
        {entries.map((e) => (
          <div key={e.cid} className="history-item" data-cid={e.cid}>
            <ArticleCard
              article={e.article}
              active={e.cid === readingCid}
              onOpen={() => void open(e.cid)}
            />
            <button
              className="history-remove"
              onClick={() => removeEntry(e.cid)}
              title="从历史中移除"
              aria-label="从历史中移除"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
