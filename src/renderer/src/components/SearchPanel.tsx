import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Replace, Search, X } from 'lucide-react'
import { useUiStore } from '../stores/ui'
import { buildRegex, contextOf, findMatches, wrapIndex } from '../lib/searchText'

/**
 * v0.0.6+：右栏基础功能「搜索」（Ctrl+F 调出），版式类似 Word 导航窗格-查找与替换。
 * - 文本模式：全文匹配 → 结果列表 + 上一处/下一处 + 跳转（onJump）
 * - 列表模式：匹配条目（标题/摘要）→ 点击打开（onOpenItem）
 * - 编辑器模式（replaceable）：批量替换 / 逐个替换 / 正则替换（onReplace 应用新文本）
 */

export interface SearchItem {
  id: string
  title: string
  text?: string
}

interface SearchPanelProps {
  /** 文本搜索源（文章正文 / 编辑器内容等） */
  text?: string
  /** 列表搜索源（列表页 / 本地文档） */
  items?: SearchItem[]
  /** 文本模式：跳到第 index 个匹配 */
  onJump?: (index: number) => void
  /** 列表模式：打开匹配条目 */
  onOpenItem?: (id: string) => void
  /** 编辑器模式：提供替换区 */
  replaceable?: boolean
  /** 替换后应用新文本（编辑器注入） */
  onReplace?: (newText: string) => void
}

export function SearchPanel({
  text,
  items,
  onJump,
  onOpenItem,
  replaceable = false,
  onReplace
}: SearchPanelProps): React.JSX.Element {
  const query = useUiStore((s) => s.searchQuery)
  const setQuery = useUiStore((s) => s.setSearchQuery)
  const regex = useUiStore((s) => s.searchRegex)
  const setRegex = useUiStore((s) => s.setSearchRegex)
  // v0.0.7+：活动匹配序号入全局 ui store——与视图的正文高亮共享（上一处/下一处/点击结果联动）
  const searchActive = useUiStore((s) => s.searchActive)
  const setSearchActive = useUiStore((s) => s.setSearchActive)
  const [replaceText, setReplaceText] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  // 词/数据源变化时回到第一个匹配
  useEffect(() => setSearchActive(0), [query, regex, text, items, setSearchActive])

  // 聚焦查找框（Ctrl+F 调出时）
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const re = useMemo(() => buildRegex(query, regex), [query, regex])

  // 文本模式匹配
  const textMatches = useMemo(
    () => (text && re ? findMatches(text, re) : []),
    [text, re]
  )
  // 列表模式匹配（标题 + 摘要）
  // v0.0.8：re 为全局正则（'g'），re.test 有状态（lastIndex 前进）——每次测试前重置，
  // 否则过滤结果依赖遍历顺序会漏匹配
  const itemMatches = useMemo(() => {
    if (!items || !re) return []
    return items.filter((it) => {
      re.lastIndex = 0
      if (re.test(it.title)) return true
      re.lastIndex = 0
      return it.text ? re.test(it.text) : false
    })
  }, [items, re])

  const total = text !== undefined ? textMatches.length : itemMatches.length
  const active = wrapIndex(searchActive, total)

  /** v0.0.7+：上一个/下一个——更新活动序号并像点击结果一样触发定位（onJump） */
  function step(delta: number): void {
    if (total === 0) return
    const next = wrapIndex(searchActive + delta, total)
    setSearchActive(next)
    onJump?.(next)
  }

  /** 跳转当前匹配 */
  function go(idx: number): void {
    setSearchActive(idx)
    onJump?.(idx)
  }

  /** 编辑器替换：替换当前 / 全部 */
  function doReplace(all: boolean): void {
    if (!text || !re || !onReplace) return
    re.lastIndex = 0
    if (all) {
      onReplace(text.replace(re, replaceText))
      return
    }
    // 逐个：替换第 active 个匹配（从后往前替换避免索引漂移）
    const matches = findMatches(text, new RegExp(re.source, 'gi'))
    if (matches.length === 0) return
    const target = matches[wrapIndex(active, matches.length)]
    if (!target) return
    const next = text.slice(0, target.start) + replaceText + text.slice(target.end)
    onReplace(next)
  }

  const showList = (text !== undefined ? textMatches.length : itemMatches.length) > 0

  return (
    <div className="reader-panel-scroll search-panel">
      {/* 查找行 */}
      <div className="search-row">
        <Search size={13} className="search-icon" />
        <input
          ref={inputRef}
          className="search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="查找"
          onKeyDown={(e) => {
            if (e.key === 'Enter') step(e.shiftKey ? -1 : 1)
          }}
        />
        <button
          className={`search-regex${regex ? ' on' : ''}`}
          onClick={() => setRegex(!regex)}
          title={regex ? '正则表达式：开（点击关闭）' : '正则表达式：关（点击开启）'}
        >
          .*
        </button>
        {query && (
          <button className="search-clear" onClick={() => setQuery('')} title="清除">
            <X size={12} />
          </button>
        )}
      </div>

      {/* 替换行（仅编辑器） */}
      {replaceable && (
        <div className="search-row">
          <Replace size={13} className="search-icon" />
          <input
            className="search-input"
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            placeholder="替换为"
          />
        </div>
      )}

      {/* 替换操作行（仅编辑器） */}
      {replaceable && (
        <div className="search-actions">
          <button className="search-nav" onClick={() => doReplace(false)} title="替换当前匹配" disabled={total === 0}>
            替换
          </button>
          <button className="search-nav" onClick={() => doReplace(true)} title="全部替换" disabled={total === 0}>
            全部替换
          </button>
        </div>
      )}

      {/* v0.0.7+：匹配计数行——文本居左，上一处/下一处（仅图标）居右；多于 1 处匹配时才显示按钮 */}
      <div className="search-count">
        <span className="search-count-text">
          {query ? `${total} 处匹配` : '输入关键词查找'}
          {total > 0 && <span className="search-active-no">（第 {active + 1} 处）</span>}
        </span>
        {total > 1 && (
          <span className="search-count-nav">
            <button className="search-count-btn" onClick={() => step(-1)} title="上一个匹配（Shift+Enter）">
              <ArrowUp size={14} />
            </button>
            <button className="search-count-btn" onClick={() => step(1)} title="下一个匹配（Enter）">
              <ArrowDown size={14} />
            </button>
          </span>
        )}
      </div>

      {/* 结果列表 */}
      {text !== undefined ? (
        <ul className="search-results">
          {textMatches.map((m, i) => (
            <li key={i}>
              <button
                className={`search-result${i === active ? ' active' : ''}`}
                onClick={() => go(i)}
                title={contextOf(text, m.start, m.end)}
              >
                <span className="search-result-no">{i + 1}</span>
                {contextOf(text, m.start, m.end)}
              </button>
            </li>
          ))}
          {!showList && query && <li className="muted search-empty">未找到匹配</li>}
        </ul>
      ) : (
        <ul className="search-results">
          {itemMatches.map((it) => (
            <li key={it.id}>
              <button className="search-result" onClick={() => onOpenItem?.(it.id)} title={it.text}>
                <span className="search-result-title">{it.title}</span>
                {it.text && <span className="search-result-text">{it.text.slice(0, 60)}</span>}
              </button>
            </li>
          ))}
          {!showList && query && <li className="muted search-empty">未找到匹配</li>}
        </ul>
      )}
    </div>
  )
}
