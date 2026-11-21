/**
 * Tauri 2 渲染层门面：在 WebView 里重新装出 1.x 的 `window.hqsf`
 * （85 个 invoke 方法 + 2 个事件订阅），渲染层零改动。
 *
 * 迁移来源：1.x `src/preload/index.ts` 的 `contextBridge.exposeInMainWorld('hqsf', api)`。
 * - 方法名不手抄：遍历 `IPC_CHANNEL_BY_METHOD`（method→channel），再用 `COMMAND_BY_CHANNEL`
 *   （channel→Rust 命令名）取实际 invoke 目标；`windowControls_*` 前缀的键归入嵌套对象。
 * - 入参保持 1.x 的位置参数形态，按 `ARG_NAMES`（来自 Rust `registry.rs` 的 `CommandSpec.params`
 *   与 `Tauri命令契约.md` §2「入参」列）展开成 invoke 具名参数；`undefined` 的可选参数不发送，
 *   让 Rust 侧 `Option<T>` 得到 `None`。
 * - 返回信封对齐 1.x 可观测行为：信封方法成功 `{ok:true,data}`，失败 `{ok:false,error}`（不抛错，
 *   因为渲染层 188 处调用点统一用 `res.ok` 判断）；裸值方法（`ping`/`getAppInfo`/`windowControls.*`）
 *   直接返回载荷，失败抛 `Error`。
 *
 * 与 Electron 的行为差异：
 * - Electron 下 `window.hqsf` 由 preload 暴露，本模块的 `installTauriBridge()` 为 no-op；
 * - Tauri 下方法经 `__TAURI_INTERNALS__.invoke` 调用 Rust 命令，事件经 `plugin:event|listen` 订阅
 *   （见 `src/bridge/invoke.ts` 的 `TODO(verify): 事件桥接`）；
 * - 1.x `add-log` 等服务层异常会让 `ipcRenderer.invoke` 直接 reject（契约异常 A4），这里统一归一到
 *   `{ok:false,error}`，属于更严格的兼容（渲染层两种都处理）。
 *
 * 依赖说明：本机无 npm，故不引入 `@tauri-apps/api`；将来若允许加依赖，可用其 `invoke`/`listen`
 * 替换 `src/bridge/invoke.ts` 的两处实现，本文件不动。
 */
import { COMMAND_BY_CHANNEL, type IpcChannel } from '../shared/generated/commands'
import { IPC_CHANNEL_BY_METHOD } from '../shared/contracts/ipc'
import type { HqsfApi, WindowControls } from '../shared/contracts/hqsf-api'
import type { UpdateState } from '../shared/domain'
import { getTauriInternals, invoke, listenTauriEvent, toErrorMessage } from './invoke'

/**
 * 每条 invoke 通道的位置参数名（顺序即 1.x 调用顺序）。
 * 来源：`crates/hqsf-core/src/commands/registry.rs` 的 `CommandSpec.params`，已与契约文档 §2 逐条核对。
 * 用 `Record<IpcChannel, …>` 标注：少一条或多一条通道都会在编译期报错。
 */
const ARG_NAMES: Record<IpcChannel, readonly string[]> = {
  'hqsf:add-comment': ['payload'],
  'hqsf:add-log': ['type', 'params'],
  'hqsf:check-forbidden': ['title', 'text'],
  'hqsf:choose-docs-dir': [],
  'hqsf:clear-cache': [],
  'hqsf:convert-to-draft': ['cid'],
  'hqsf:copy-text': ['text'],
  'hqsf:create-local-dir': ['rel'],
  'hqsf:create-local-draft': ['title', 'content', 'dirRel'],
  'hqsf:delete-local-file': ['path'],
  'hqsf:edit-remote-article': ['cid'],
  'hqsf:file-exists': ['path'],
  'hqsf:get-agreement': [],
  'hqsf:get-app-info': [],
  'hqsf:get-changelog': [],
  'hqsf:get-docs-root': [],
  'hqsf:get-private-chat': ['touid'],
  'hqsf:get-remote-article': ['cid'],
  'hqsf:get-session': [],
  'hqsf:get-settings': [],
  'hqsf:get-unread-count': [],
  'hqsf:is-mark': ['cid'],
  'hqsf:list-articles': [],
  'hqsf:list-categories': [],
  'hqsf:list-chat-messages': ['chatid'],
  'hqsf:list-chat-sessions': [],
  'hqsf:list-comments': ['cid', 'opts'],
  'hqsf:list-gpt-models': [],
  'hqsf:list-local-docs': [],
  'hqsf:list-metas': ['type'],
  'hqsf:list-my-reviews': [],
  'hqsf:list-notifications': [],
  'hqsf:list-recent-comments': ['opts'],
  'hqsf:list-remote-articles': ['opts'],
  'hqsf:list-review-tasks': [],
  'hqsf:list-reviews': ['opts'],
  'hqsf:login-password': ['name', 'password'],
  'hqsf:logout': [],
  'hqsf:mark-notifications-read': ['categories'],
  'hqsf:open-docs-dir': [],
  'hqsf:pick-upload-user-image': [],
  'hqsf:ping': [],
  'hqsf:read-clipboard-html': [],
  'hqsf:read-clipboard-text': [],
  'hqsf:read-local-file': ['path'],
  'hqsf:remove-log': ['key'],
  'hqsf:rename-local-node': ['oldRel', 'newRel'],
  'hqsf:reveal-in-folder': ['path'],
  'hqsf:search-comments': ['keyword', 'limit'],
  'hqsf:search-reviews': ['keyword', 'limit'],
  'hqsf:search-users': ['keyword', 'limit'],
  'hqsf:send-chat-message': ['chatid', 'msg'],
  'hqsf:set-review-attitude': ['reviewId', 'type'],
  'hqsf:show-message-box': ['options'],
  'hqsf:submit-review': ['payload'],
  'hqsf:sync-pull': [],
  'hqsf:sync-push': ['filePath', 'isDraft', 'meta'],
  'hqsf:toggle-devtools': [],
  'hqsf:uninstall': [],
  'hqsf:update-check': [],
  'hqsf:update-download': [],
  'hqsf:update-install': [],
  'hqsf:update-settings': ['patch'],
  'hqsf:update-state': [],
  'hqsf:user-articles': ['uid', 'page', 'limit'],
  'hqsf:user-clock': [],
  'hqsf:user-comments': ['uid', 'page', 'limit'],
  'hqsf:user-fan-list': ['uid', 'page', 'limit'],
  'hqsf:user-feed': [],
  'hqsf:user-follow': ['uid', 'follow'],
  'hqsf:user-follow-list': ['uid', 'page', 'limit'],
  'hqsf:user-follow-state': ['uid'],
  'hqsf:user-marks': ['page', 'limit'],
  'hqsf:user-profile': ['uid'],
  'hqsf:user-reviews': ['uid', 'page', 'limit'],
  'hqsf:user-self-status': [],
  'hqsf:user-stats': ['uid'],
  'hqsf:user-update-profile': ['payload'],
  'hqsf:verify-session': [],
  'hqsf:window-close': [],
  'hqsf:window-is-maximized': [],
  'hqsf:window-maximize-toggle': [],
  'hqsf:window-minimize': [],
  'hqsf:write-local-file': ['path', 'content'],
  'media:pick-upload-image': []
}

/** 1.x preload 的裸值接口（不包 `{ok,data}` 信封）：成功直接返回载荷，失败抛 `Error`。 */
const BARE_CHANNELS: ReadonlySet<IpcChannel> = new Set<IpcChannel>([
  'hqsf:ping',
  'hqsf:get-app-info',
  'hqsf:window-minimize',
  'hqsf:window-maximize-toggle',
  'hqsf:window-close',
  'hqsf:window-is-maximized'
])

/**
 * 顶层 invoke 方法数：85 个 invoke 通道 − 4 个 `windowControls.*`（它们挂在嵌套对象上）。
 * `windowControls.*` 4 个 + 顶层 81 个 = 85，再加上 2 个事件订阅 = 87 个可调用成员。
 */
const EXPECTED_TOP_LEVEL_METHOD_COUNT = 81

/** `windowControls` 成员数：4 个 invoke + 1 个事件订阅。 */
const EXPECTED_WINDOW_CONTROL_MEMBER_COUNT = 5

type AsyncMethod = (...args: unknown[]) => Promise<unknown>

// ---------------------------------------------------------------------------
// 编译期覆盖性校验：三张表（IPC 方法表 / Rust 命令表 / HqsfApi 契约）必须严格一一对应。
// 若任何一张表新增或遗漏方法，下面的 `const … = true` 会因类型不成立而编译失败。
// ---------------------------------------------------------------------------
type IpcMethodKey = keyof typeof IPC_CHANNEL_BY_METHOD
type IpcInvokeMethod = Exclude<IpcMethodKey, 'onUpdateState' | `windowControls_${string}`>
type HqsfInvokeMethod = Exclude<keyof HqsfApi, 'windowControls' | 'onUpdateState'>
type IpcWindowControlKey = Extract<IpcMethodKey, `windowControls_${string}`>
type IpcWindowControlName = IpcWindowControlKey extends `windowControls_${infer Name}` ? Name : never
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** 81 个顶层 invoke 方法名：IPC 表 ↔ HqsfApi 完全一致（4 个 windowControls 方法在嵌套对象上）。 */
const INVOKE_METHODS_MATCH: Equals<IpcInvokeMethod, HqsfInvokeMethod> = true
/** 5 个 windowControls 成员：IPC 表 ↔ WindowControls 契约完全一致。 */
const WINDOW_CONTROLS_MATCH: Equals<IpcWindowControlName, keyof WindowControls> = true
/** 85 个 invoke 通道（含 4 个 windowControls 通道）：IPC 表的通道值 ↔ Rust 命令表 IpcChannel（排除唯一纯事件通道）。 */
const CHANNELS_MATCH: Equals<
  Exclude<(typeof IPC_CHANNEL_BY_METHOD)[IpcMethodKey], 'hqsf:window-maximized-changed'>,
  IpcChannel
> = true
void INVOKE_METHODS_MATCH
void WINDOW_CONTROLS_MATCH
void CHANNELS_MATCH

/** 运行时兜底：channel 是否在生成的 Rust 命令表里（`plugin:event|*` 不是业务通道）。 */
function isIpcChannel(channel: string): channel is IpcChannel {
  return Object.prototype.hasOwnProperty.call(COMMAND_BY_CHANNEL, channel)
}

/** 位置参数 → invoke 具名参数对象；undefined 的可选参数直接省略（Rust 侧得到 None）。 */
function argsFor(channel: IpcChannel, args: readonly unknown[]): Record<string, unknown> | undefined {
  const names = ARG_NAMES[channel]
  if (names.length === 0) return undefined
  const out: Record<string, unknown> = {}
  for (let i = 0; i < names.length; i += 1) {
    if (args[i] !== undefined) out[names[i]] = args[i]
  }
  return out
}

/** 信封方法：成功 `{ok:true,data}`，失败 `{ok:false,error}`（与 1.x preload 的 ipcRenderer.invoke 结果同形）。 */
function envelopeMethod(channel: IpcChannel): AsyncMethod {
  const cmd = COMMAND_BY_CHANNEL[channel]
  return async (...args: unknown[]) => {
    try {
      const data = await invoke<unknown>(cmd, argsFor(channel, args))
      return { ok: true, data }
    } catch (error) {
      return { ok: false, error: toErrorMessage(error) }
    }
  }
}

/** 裸值方法：直接返回 Rust 载荷；失败让 `invoke` 抛出的 `Error` 原样上抛。 */
function bareMethod<T>(channel: IpcChannel): (...args: unknown[]) => Promise<T> {
  const cmd = COMMAND_BY_CHANNEL[channel]
  return (...args: unknown[]) => invoke<T>(cmd, argsFor(channel, args))
}

/** `window.hqsf.windowControls`：4 个 invoke + 1 个事件订阅，与 1.x preload 一一对应。 */
function createWindowControls(): WindowControls {
  const controls: Record<string, unknown> = {}
  for (const [method, channel] of Object.entries(IPC_CHANNEL_BY_METHOD)) {
    if (!method.startsWith('windowControls_')) continue
    if (!isIpcChannel(channel)) continue // windowControls_onMaximizedChanged 是事件键，下面单独装配
    controls[method.slice('windowControls_'.length)] = bareMethod<unknown>(channel)
  }
  controls.onMaximizedChanged = (cb: (max: boolean) => void): (() => void) =>
    listenTauriEvent<boolean>('hqsf:window-maximized-changed', cb)
  return Object.assign({} as WindowControls, controls)
}

/**
 * 生成 `window.hqsf` 门面。
 * `Object.assign({} as HqsfApi, …)` 是表驱动生成与静态契约之间唯一的一处断言：
 * 键名/参数/返回语义由上面的 `Equals` 断言与 `ARG_NAMES: Record<IpcChannel, …>` 在编译期兜底。
 */
export function createHqsfApi(): HqsfApi {
  const methods: Record<string, AsyncMethod> = {}
  for (const [method, channel] of Object.entries(IPC_CHANNEL_BY_METHOD)) {
    if (method === 'onUpdateState' || method.startsWith('windowControls_')) continue
    if (!isIpcChannel(channel)) continue
    methods[method] = BARE_CHANNELS.has(channel) ? bareMethod<unknown>(channel) : envelopeMethod(channel)
  }

  // 防御性断言：正常情况由编译期断言保证；壳层/生成器漂移时在控制台留下明确线索。
  const windowControls = createWindowControls()
  const generatedCount = Object.keys(methods).length
  const windowControlCount = Object.keys(windowControls).length
  if (generatedCount !== EXPECTED_TOP_LEVEL_METHOD_COUNT || windowControlCount !== EXPECTED_WINDOW_CONTROL_MEMBER_COUNT) {
    console.error(
      `[bridge] window.hqsf 方法数异常：顶层期望 ${EXPECTED_TOP_LEVEL_METHOD_COUNT} 实得 ${generatedCount}，` +
        `windowControls 期望 ${EXPECTED_WINDOW_CONTROL_MEMBER_COUNT} 实得 ${windowControlCount}`
    )
  }

  return Object.assign({} as HqsfApi, methods, {
    windowControls,
    onUpdateState: (cb: (state: UpdateState) => void): (() => void) => listenTauriEvent<UpdateState>('hqsf:update-state', cb)
  })
}

/**
 * 在 Tauri WebView 里安装 `window.hqsf`；Electron（或已安装过）时什么都不做。
 * 返回是否真的安装（便于壳层/自检断言）。
 */
export function installTauriBridge(): boolean {
  if (getTauriInternals() === null) return false // Electron：preload 已暴露 window.hqsf
  if (window.hqsf) return false // 幂等
  Object.defineProperty(window, 'hqsf', {
    value: createHqsfApi(),
    writable: false,
    enumerable: true,
    configurable: false
  })
  return true
}