/**
 * 右键菜单守卫（Tauri 专用）。
 *
 * 背景：Electron 的渲染进程**没有**默认右键菜单——页面不处理 `contextmenu` 就什么都不弹。
 * WebKitGTK / WebView2 相反：没人 `preventDefault` 的地方会弹出 WebView 自己的原生菜单
 * （英文的 Back / Forward / Reload / Select All…）。于是应用里只有显式挂了
 * `useContextMenu()` 的区域是中文菜单，其他地方一律英文原生菜单（v2.0.14 的实测表现）。
 *
 * 做法：在 window 冒泡阶段（应用内所有处理器执行完之后）统一 `preventDefault`，
 * 把「没人接管」的位置压成什么都不弹——与 1.x 的行为一致。
 *
 * 两条例外：
 * 1. 已经开始处理的事件（`defaultPrevented` 为真，说明组件自己的菜单已经打开）直接放过；
 * 2. 可编辑元素（文本类 input / textarea / contenteditable）交给
 *    `components/menu/ContextMenu.tsx` 里的兜底编辑菜单——它也在 window 冒泡阶段监听、
 *    靠 `defaultPrevented` 判断「有没有人接管」，所以这里必须放行，否则兜底菜单会被吃掉。
 *
 * 注意时序：本模块在 `installTauriBridge()` 里安装（早于 React 挂载），所以它的 window 监听
 * 先于 ContextMenuHost 的监听注册、先执行；正因如此第 2 条例外必须写在守卫里，
 * 不能依赖「别人先处理」。
 */
import { getTauriInternals } from './invoke'

/** 与 `editableContextMenu.tsx` 的 `isEditableTarget` 保持一致（该处依赖渲染层，这里就地复刻）。 */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number'])

function isEditableTarget(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type)
  return el instanceof HTMLElement && el.isContentEditable
}

let installed = false

function onContextMenu(event: MouseEvent): void {
  // 组件自己的菜单已经接管：不要重复处理
  if (event.defaultPrevented) return
  // 可编辑元素：放行给 ContextMenuHost 的兜底编辑菜单（它会 preventDefault）
  if (isEditableTarget(event.target instanceof Element ? event.target : null)) return
  // 其余位置：压掉 WebView 原生（英文）菜单，等于「没有菜单」
  event.preventDefault()
}

/** 安装全局右键守卫；幂等，只在 Tauri 运行时生效。 */
export function installTauriContextMenuGuard(): void {
  if (installed) return
  if (getTauriInternals() === null) return // Electron：本来就没有原生菜单
  installed = true
  window.addEventListener('contextmenu', onContextMenu)
}