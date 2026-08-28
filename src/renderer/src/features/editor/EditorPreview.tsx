import { useMemo } from 'react'

/**
 * v0.0.7+：编辑器右栏「预览」——源码模式整篇渲染（纯展示）。
 * dangerouslySetInnerHTML 传稳定引用，避免 React 每次渲染重写 innerHTML
 * （音乐/视频 iframe 不被重建）。SV 模式的搜索目标为左侧源码编辑器，
 * 预览不做搜索高亮（匹配/计数都以源码为准）。
 */
export function EditorPreview({ html }: { html: string }): React.JSX.Element {
  const htmlObj = useMemo(() => ({ __html: html }), [html])
  return (
    <div className="reader-panel-scroll">
      <div className="reader-body editor-preview-body" dangerouslySetInnerHTML={htmlObj} />
    </div>
  )
}
