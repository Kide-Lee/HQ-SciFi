import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Vditor from 'vditor'
import { cachedImageUrl } from '../lib/sanitize'

// ---- 离线资源内联化（Electron 桌面环境不依赖 CDN）----
// 主样式 + 内容主题（.vditor-reset 排版），经 Vite 打包进产物
import 'vditor/dist/index.css'
import 'vditor/dist/css/content-theme/light.css'
// 渲染核心 Lute（window.Lute）、工具栏图标（注入 SVG symbol）、中文文案（window.VditorI18n）
import 'vditor/dist/js/lute/lute.min.js'
import 'vditor/dist/js/icons/ant.js'
import 'vditor/dist/js/i18n/zh_CN.js'
// 数学公式渲染 KaTeX（window.katex + 样式/字体）：Vditor 的 mathRender 直接使用 window.katex
// 注：mhchem（化学 \ce{} 扩展）未引入——其 UMD 内部 require("katex") 在 Vite 打包下无法解析；
// 其 script id 已占位（见 effect），Vditor 动态加载跳过，化学公式语法暂不支持
// KaTeX 用 ?raw 内联源码 + 同步 script 注入：若作为模块 import，Vite 会转换 UMD 的
// module.exports 分支导致 window.katex 全局挂载丢失（实测 katex is not defined）
import katexSource from 'vditor/dist/js/katex/katex.min.js?raw'
import 'vditor/dist/js/katex/katex.min.css'

// 模块顶层同步执行：window.katex 立即可用（Vditor mathRender 直接使用，无异步时序问题）
;(() => {
  if (!document.getElementById('vditorKatexScript')) {
    const s = document.createElement('script')
    s.id = 'vditorKatexScript'
    s.textContent = katexSource
    document.head.appendChild(s)
  }
  // 兜底校验：若渲染进程将来启用 CSP script-src 'self' 会拦截 textContent 注入，公式将无法渲染
  if (typeof (window as unknown as { katex?: unknown }).katex === 'undefined') {
    console.warn('[vditor] KaTeX 注入失败，数学公式将无法渲染（检查 CSP 或 katex 资源）')
  }
})()

/**
 * 占位已本地加载的脚本 id：Vditor 动态加载脚本前会先查 document.getElementById(id)，
 * 已存在则跳过（addScript/addScriptSync resolve 不再发起请求）。配合 cdn:'' 保证零远程请求。
 * 注意：Vditor destroy() 会移除 vditorIconScript 占位，故每次创建实例前需重新占位（见组件 effect）。
 */
function markScriptLoaded(id: string): void {
  if (!document.getElementById(id)) {
    const s = document.createElement('script')
    s.id = id
    document.head.appendChild(s)
  }
}

/** 占位已本地引入的样式表 link id（addStyle 检查 document.getElementById(id) 已存在则跳过） */
function markStyleLoaded(id: string): void {
  if (!document.getElementById(id)) {
    const l = document.createElement('link')
    l.id = id
    l.rel = 'stylesheet'
    l.type = 'text/css'
    document.head.appendChild(l)
  }
}

interface VditorEditorProps {
  /** 文档标识：变化时用最新 content 重建编辑器（切换文档） */
  docKey: string
  /** 编辑模式：所见即所得 / 即时渲染 / 分屏预览（变化时重建） */
  mode: 'wysiwyg' | 'ir' | 'sv'
  /** 初始内容（仅创建时使用一次；之后编辑器为内容唯一来源，经 onChange 回流） */
  content: string
  /** markdown 内容变化回调（输入即触发，由上层落盘/同步） */
  onChange: (md: string) => void
}

/**
 * Vditor 三模式一体编辑器（所见即所得 / 即时渲染 IR / 分屏预览 SV）。
 * 渲染核心 Lute 与图标/文案均本地打包；`cache` 关闭（内容以 store 为单一来源，
 * 避免 localStorage 缓存与文档切换互相覆盖）；`input` 回调回流内容。
 */
export function VditorEditor({ docKey, mode, content, onChange }: VditorEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef(content)
  contentRef.current = content
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // 上一次已回流的值：Vditor 初始化/内部 setValue 触发 input 时与初值相同则跳过，避免误标 dirty
  const lastValueRef = useRef(content)
  // 当前 Vditor 实例（公式弹窗确认时调用 insertValue；Electron 渲染层不支持 window.prompt）
  const vditorRef = useRef<Vditor | null>(null)
  const [mathOpen, setMathOpen] = useState(false)
  const [mathLatex, setMathLatex] = useState('')

  /** 公式弹窗确认：插入块级公式 $$…$$（经 Vditor 渲染为 KaTeX 公式块） */
  function handleInsertMath(): void {
    const latex = mathLatex.trim()
    const vditor = vditorRef.current
    if (!latex || !vditor) return
    // 弹窗 input 抢走焦点：插入前回到编辑器，避免选区漂移导致插入位置错乱
    try {
      vditor.focus()
    } catch {
      // 忽略：实例未就绪等场景
    }
    // 异步初始化未就绪（this.vditor 为空）时 insertValue 会抛错，就绪才插入
    if (vditor.vditor) {
      vditor.insertValue(`$$${latex}$$`, true)
    }
    setMathOpen(false)
    setMathLatex('')
  }

  useEffect(() => {
    if (!containerRef.current) return
    lastValueRef.current = contentRef.current
    // 组件卸载标记 + 实例引用（after 回调里兜底销毁「已卸载但未及销毁」的实例）
    let disposed = false
    let vditor: Vditor | null = null
    // Vditor destroy() 会移除 vditorIconScript 占位，模式/文档切换重建前重新占位，
    // 防止 addScriptSync 同步请求 icons 脚本（cdn='' 相对路径在 dev server 返回 HTML 报错）
    markScriptLoaded('vditorLuteScript')
    markScriptLoaded('vditorIconScript')
    markScriptLoaded('vditorI18nScriptzh_CN')
    // KaTeX 公式渲染脚本/样式已本地引入：占位阻止 Vditor 动态加载（mathRender 直接用 window.katex）
    markScriptLoaded('vditorKatexScript')
    markScriptLoaded('vditorKatexChemScript')
    markStyleLoaded('vditorKatexStyle')

    const options = {
      mode,
      value: contentRef.current,
      // 内容以应用 store 为单一来源，禁用 Vditor 的 localStorage 缓存（避免切文档串内容）
      cache: { enable: false },
      // 资源已本地打包；置空阻止 Vditor 从 unpkg CDN 动态加载任何脚本
      cdn: '',
      lang: 'zh_CN',
      icon: 'ant',
      // Vditor 类型声明 theme 为 'classic' | 'dark'，但运行时（mergeOptions）支持
      // { current, path } 对象（v3.11 行为，升级 Vditor 时需复核）；path 置空时
      // setContentTheme 直接跳过，内容主题由上方 import 提供，避免任何远程 CSS 请求
      theme: { current: 'light', path: '' },
      // Lute 渲染 emoji 的图片基址，置空避免生成 unpkg 图片请求
      emojiPath: '',
      toolbar: [
        'headings',
        'bold',
        'italic',
        'strike',
        'link',
        '|',
        'list',
        'ordered-list',
        'check',
        '|',
        'quote',
        'line',
        'code',
        'inline-code',
        // 插入数学公式（KaTeX/LaTeX，块级 $$…$$；行内公式直接用 $…$ 写在正文）
        {
          name: 'math',
          icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 7V4H6l6 8-6 8h12v-3"/></svg>',
          tip: '插入数学公式（KaTeX）',
          click: () => {
            // Electron 渲染层不支持 window.prompt，用 React 弹窗输入 LaTeX；
            // 插入走 vditorRef（effect 里的 Vditor 实例，含 insertValue；click 回调参数是 IVditor 无此方法）
            setMathOpen(true)
          }
        },
        'table',
        '|',
        'undo',
        'redo'
      ],
      toolbarConfig: { pin: true },
      preview: {
        // 内容主题本地已引入；禁用 hljs（无本地高亮脚本，避免动态加载请求）
        theme: { current: 'light', path: '' },
        hljs: { enable: false },
        delay: 200,
        // 媒体渲染器（YouTube/B站等视频 iframe）会产生远程 iframe 请求，桌面阅读不引入，禁用
        render: { media: { enable: false } },
        // 分屏预览固定桌面宽度即可，无需平板/手机/公众号/知乎切换，移除整个 vditor-preview__action 组件
        // （actions 为空数组时 Vditor 不渲染该组件，源码 previewRender 开头 return）
        actions: [],
        // 预览区图片 src 改写为 hqsf-img:// 本地缓存协议（与阅读视图一致，离线可看）
        transform: (html: string) =>
          html.replace(
            /(<img[^>]*\ssrc=")(https?:\/\/[^"]+)(")/g,
            (_pre, pre: string, url: string, post: string) => `${pre}${cachedImageUrl(url)}${post}`
          )
      },
      // 桌面应用：预览区链接不自动打开新窗口（外部链接统一交系统浏览器，见窗口安全约定）
      link: { isOpen: false },
      input: (value: string) => {
        if (value === lastValueRef.current) return
        lastValueRef.current = value
        onChangeRef.current(value)
      },
      // 异步初始化完成回调：若组件已卸载（极端时序下未及销毁的实例），立即销毁清理
      after: () => {
        if (disposed && vditor) {
          try {
            vditor.destroy()
          } catch {
            // 实例未就绪的 destroy 可能抛错，忽略
          }
        }
      }
    } as unknown as IOptions

    vditor = new Vditor(containerRef.current, options)
    vditorRef.current = vditor

    return () => {
      disposed = true
      vditorRef.current = null
      // Vditor 构造器为异步初始化（addScript(...).then(init)，返回时 this.vditor 尚未就绪），
      // 未就绪时 destroy() 访问 this.vditor.element 会抛 TypeError——已就绪才同步销毁，
      // 未就绪的由上方 after 回调（disposed 标记）兜底销毁
      if (vditor && vditor.vditor) {
        try {
          vditor.destroy()
        } catch {
          // noop
        }
      }
    }
  }, [docKey, mode])

  return (
    <div className="vditor-editor-wrap" ref={containerRef}>
      {/* Vditor 挂载点（组件自身渲染 toolbar + 编辑区 + 预览区） */}
      {/* 插入数学公式弹窗（Electron 渲染层不支持 window.prompt，自绘输入框；portal 到 body 避免被 Vditor 容器清理） */}
      {mathOpen &&
        createPortal(
          <div className="math-dialog-mask" onClick={() => setMathOpen(false)}>
            <div className="math-dialog" onClick={(e) => e.stopPropagation()}>
              <h3>插入数学公式</h3>
              <p className="muted">
                LaTeX 语法，例如 <code>{'\\frac{a}{b}'}</code>；插入为块级公式。行内公式请用
                {' $…$ '}直接写在正文。
              </p>
              <input
                autoFocus
                value={mathLatex}
                onChange={(e) => setMathLatex(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleInsertMath()
                  if (e.key === 'Escape') setMathOpen(false)
                }}
                placeholder={'\\frac{a}{b}'}
              />
              <div className="math-dialog-actions">
                <button className="toolbar-btn" onClick={() => setMathOpen(false)}>
                  取消
                </button>
                <button className="toolbar-btn primary" onClick={handleInsertMath} disabled={!mathLatex.trim()}>
                  插入
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
