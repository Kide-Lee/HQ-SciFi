import { useEffect, useRef } from 'react'
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

    return () => {
      disposed = true
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
    </div>
  )
}
