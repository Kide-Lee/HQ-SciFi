/**
 * 无边框窗口的拖拽兼容层（Tauri 专用）。
 *
 * 背景：1.x 用 Chromium 私有 CSS `-webkit-app-region: drag|no-drag`（`src/renderer/src/styles/index.css`
 * 有 9 处）实现「拖顶栏/拖左栏空白移动窗口」。这是 Electron 的能力，**WebKitGTK / WKWebView 不认这条
 * 声明**，而 `src-tauri/tauri.conf.json` 在 Windows/Linux 上是 `decorations: false`（自绘 36px 顶栏），
 * 所以不补这一层，窗口在这两个平台上完全拖不动（功能回归）。
 *
 * 做法：在渲染层保留原 CSS（Electron 仍由它生效），另外给三个「可拖拽区域」的根节点加上
 * `data-hqsf-drag-region` 属性；本模块捕获 `mousedown`，命中拖拽区域且没落在交互元素上时，
 * 调 Tauri 的 `plugin:window|start_dragging`（权限：`core:window:allow-start-dragging`，见
 * `src-tauri/capabilities/default.json`）。双击同区域 = 切换最大化（1.x 是原生窗口行为）。
 *
 * 为什么不用 `data-tauri-drag-region` 内建属性：内建实现只在 **mousedown 目标元素本身**带属性时生效，
 * 而本项目顶栏的标题、图标等是子元素（1.x 里点击子元素也能拖），逐个子元素补属性既脆弱又会随 UI 改动失效。
 */
import { getTauriInternals } from './invoke'

/** 可拖拽区域标记（写在 TSX 根节点上）。 */
export const DRAG_REGION_ATTR = 'data-hqsf-drag-region'

/** 交互元素：落在这些元素上时不能拖窗口（等价 1.x 的 `-webkit-app-region: no-drag`）。 */
const INTERACTIVE =
  'button, input, textarea, select, a, [contenteditable="true"], [role="button"], [data-hqsf-no-drag]'

/** 拖拽中标记，避免一次按下触发多次 start_dragging。 */
let dragging = false

/**
 * 判断事件目标是否落在「可拖拽但非交互」的位置。
 * 从 target 向上找最近的 `data-hqsf-drag-region`，中途先遇到交互元素则放弃。
 */
function findDragRegion(target: EventTarget | null): HTMLElement | null {
  let node = target instanceof Element ? target : null
  while (node) {
    if (node.matches(INTERACTIVE)) return null
    if (node instanceof HTMLElement && node.hasAttribute(DRAG_REGION_ATTR)) return node
    node = node.parentElement
  }
  return null
}

/**
 * 安装拖拽兼容层（仅 Tauri 运行时；Electron 由 `-webkit-app-region` 生效，此处 no-op）。
 * 幂等：重复调用只安装一次监听。
 */
export function installTauriDragRegion(): boolean {
  if (getTauriInternals() === null) return false
  if (typeof document === 'undefined' || document.documentElement.dataset.hqsfDrag === '1') return false
  document.documentElement.dataset.hqsfDrag = '1'

  document.addEventListener(
    'mousedown',
    (event) => {
      if (event.button !== 0 || event.defaultPrevented) return
      if (!findDragRegion(event.target)) return
      // 双击标题栏 = 最大化/还原（1.x 由系统窗口行为提供）。
      if (event.detail === 2) {
        void window.hqsf?.windowControls?.toggleMaximize?.()
        return
      }
      if (dragging) return
      dragging = true
      void getTauriInternals()
        ?.invoke('plugin:window|start_dragging')
        .catch(() => {
          /* 权限缺失或窗口已销毁：静默（拖不动比抛错好） */
        })
        .finally(() => {
          dragging = false
        })
    },
    true
  )
  return true
}
