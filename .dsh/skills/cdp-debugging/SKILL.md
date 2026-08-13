---
name: cdp-debugging
description: 通过 Chrome DevTools Protocol 无副作用地调试本机正在运行的应用：用 SIGUSR1 打开 Electron 主进程 inspector，经 webContents.debugger 挂载渲染层，执行只读探测、截图，或在用户明确要求后注入真实输入事件，最后干净拆除调试通道；也可用 headless Chromium 调试本地 Web GUI。自带零依赖 CDP 客户端 scripts/cdp.mjs（Node≥22 原生 WebSocket）。当用户要求"调试/检查/操作/截图正在运行的客户端或本地页面，且不重启、无副作用"时使用。
---

# CDP 调试本地运行中的应用

目标对象：hqsf-client（Electron，`electron-vite dev` 或打包版）的渲染层；或任何本地 Web GUI（如 DSH Web 界面）。核心价值：**不重启应用、不改动应用数据**就能挂进去看状态、截图、甚至输入。

## 工具清单（本 skill 自带，零 npm 依赖）

所有路径相对项目根目录。

```bash
node .dsh/skills/cdp-debugging/scripts/cdp.mjs targets            # 列出可挂载 target
CDP_PORT=9229 node .dsh/skills/cdp-debugging/scripts/cdp.mjs eval '<js 表达式>'   # 求值，JSON 输出
node .dsh/skills/cdp-debugging/scripts/cdp.mjs shot out.png [selector]           # 截图
node .dsh/skills/cdp-debugging/scripts/cdp.mjs listen [秒]         # console/异常事件流
```

- 环境变量：`CDP_PORT`（默认 9222）、`CDP_TARGET`（按 url 子串选 target）。
- 客户端已内置：`page`/`node` 两类 target 均可挂；`Runtime.evaluate` 自动带 `includeCommandLineAPI`（否则 Node inspector 上下文里没有 `require`）与 `awaitPromise`。
- `scripts/probe-page.js`：只读探测模板（窗口信息 + 可编辑元素 + 正文文本）。
- `scripts/type-into-editor.js`：真实输入模板（点击聚焦 + `Input.insertText`）。

## 流程 A：无重启挂载正在运行的 Electron

1. **找主进程 PID**（应用被重启后 PID 必变，每次重查，勿复用旧值）：
   ```bash
   ps aux | grep -E 'electron \.|electron-vite dev' | grep -v grep
   ```
2. **安全检查——必须先做**：SIGUSR1 的默认动作是终止进程，只有进程已捕获该信号才可发。
   ```bash
   grep SigCgt /proc/<pid>/status
   ```
   用 Node 判位（SIGUSR1=10 → bit 9）：位为 1 才继续。Electron 主进程（Node 运行时）恒已捕获，实测安全；若掩码显示未捕获，改用带 `--remote-debugging-port` 的启动方式（需重启，副作用大，必须经用户同意）。
3. **开 inspector**：`kill -USR1 <pid>` → 监听 `127.0.0.1:9229`（Node 约定端口，被占则递增）。校验：`curl http://127.0.0.1:9229/json/list`，target 类型是 `node`（不是 `page`）。
4. **挂渲染层 + 只读探测**：
   ```bash
   CDP_PORT=9229 node .dsh/skills/cdp-debugging/scripts/cdp.mjs eval "$(cat .dsh/skills/cdp-debugging/scripts/probe-page.js)"
   ```
   模板内部：`webContents.debugger.attach('1.3')` → `debugger.sendCommand('Runtime.evaluate', ...)` → `finally` 里 `detach()`。主进程上下文里 `require('electron')` 可用（依赖 `includeCommandLineAPI`）。
5. **真实输入**（仅当用户明确要求，见副作用纪律）：
   ```bash
   CDP_PORT=9229 node .dsh/skills/cdp-debugging/scripts/cdp.mjs eval "$(cat .dsh/skills/cdp-debugging/scripts/type-into-editor.js)"
   ```
   模板：先求值拿编辑器矩形 → `Input.dispatchMouseEvent`（mousePressed/mouseReleased）点击中心聚焦 → `Input.insertText` → 回读 DOM 校验 → 截图。**先探测再选元素**：编辑器是双模式——可视化模式为 Milkdown v7/ProseMirror（`div.ProseMirror[role=textbox]`），源码模式为 CodeMirror 6（`.cm-content`）；`type-into-editor.js` 两个选择器都兼容。若两者都不在，先跑 `probe-page.js` 看当前界面。
6. **清理（顺序重要）**：
   - 渲染层：模板的 `finally` 已 detach。
   - 主进程：只用 `process._debugEnd()`；**不要先调 `inspector.close()`**——Electron 里它会关掉调试代理却保留监听 socket，9229 变成只响应 `/json`、`evaluate` 永不返回的僵尸端口，只能重启应用消除。
   - `_debugEnd` 会先断 ws 再响应，客户端会挂起，属正常：用 `timeout 8` 包住，rc=124 可接受。
   - 验证：`ss -ltn | grep 9229` 无输出、`kill -0 <pid>` 进程存活。

## 流程 B：CDP 调试本地 Web GUI（如 DSH Web 界面）

三条路径按优雅程度排序。**共同注意**：B 类实例都是独立会话，看不到用户真实会话的实时状态（同一个前端，不同状态）。

### B1 首选：复用项目自带 Electron（零下载，需用户终端跑一条命令）

DSH 沙箱内无法启动 Electron GUI（SIGTRAP），但项目 `node_modules` 里的 Electron 本身就是完整 Chromium；用户在真实终端运行即可：

```bash
.dsh/skills/cdp-debugging/scripts/electron-web-shell.sh [URL]   # 默认 http://127.0.0.1:3080
```

会弹出一个显示目标页面的窗口（可最小化，关窗即退出），CDP 绑定 `127.0.0.1:9222`（`CDP_PORT` 可换）。之后沙箱内直接挂载——这是 `page` 型 target，`targets`/`eval`/`shot`/`listen` 全部可用：

```bash
CDP_PORT=9222 node .dsh/skills/cdp-debugging/scripts/cdp.mjs targets
```

### B2 一次性缓存：headless shell 装到用户级 `~/.cache`（用户终端执行一次）

DSH 沙箱对 `~/.cache` 只读但**可读**——浏览器装在那里不随 `.devtools` 清理丢失，以后永不重下：

```bash
# 用户终端执行一次（~150MB）
PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright npx -y playwright@1.55.0 install chromium --only-shell
```

沙箱内启动（user-data-dir 必须指向沙箱可写处，如工作区 `.devtools/`，自动创建、可随时删除）：

```bash
~/.cache/ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell \
  --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run \
  --remote-debugging-port=9222 --user-data-dir="$PWD/.devtools/cdp-profile" <目标 URL>
```

### B3 兜底：纯沙箱自助下载到工作区（`.devtools` 被删后需重下 ~150MB）

仅在无法请用户跑终端时使用；本机沙箱 `~/.npm`、`~/.cache` 只读会 EROFS，必须把缓存重定向到工作区：

```bash
mkdir -p .devtools/npm-cache .devtools/browsers
npm_config_cache="$PWD/.devtools/npm-cache" PLAYWRIGHT_BROWSERS_PATH="$PWD/.devtools/browsers" \
  npx -y playwright@1.55.0 install chromium --only-shell
```

启动参数同 B2（二进制在 `.devtools/browsers/`）。`.devtools/` 已在 `.gitignore` 中（机器本地缓存，不进库）；skill 脚本与模板才是版本化资产。

## 副作用纪律

- 默认**只读**：仅 `Runtime.evaluate` 读状态、`Page.captureScreenshot`、事件监听（console/network）。
- 点击、输入、保存等真实操作**必须等用户明确指令**；绝不未经要求触发保存/发布/任何网络写操作。
- 输入类操作只进内存草稿：不点保存即无痕，用户可 `Ctrl+Z` 撤销。
- 截图只落本地路径；当前模型若无图像输入能力，用 `eval` 拉 `document.body.innerText` 作"文本视图"替代。

## 坑清单

| 坑 | 对策 |
| --- | --- |
| `~/.npm`、`~/.cache` 只读（EROFS），浏览器装工作区里总被清理 | 首选 B1（项目 Electron 零下载）；或 B2 一次性装到 `~/.cache`；仅 B3 需把 `npm_config_cache`/`PLAYWRIGHT_BROWSERS_PATH` 重定向进工作区 |
| 盲发 SIGUSR1 可能杀进程 | 先解析 `/proc/<pid>/status` 的 `SigCgt` 第 10 位 |
| `inspector.close()` 制造僵尸 9229 | 清理只走 `process._debugEnd()`，顺序勿反 |
| Node inspector target 类型是 `node` 非 `page` | `cdp.mjs` 已同时接受两类 |
| 求值上下文无 `require` | `Runtime.evaluate` 带 `includeCommandLineAPI: true` |
| 应用重启后旧 PID 失效 | 每次 `ps` 重查，不缓存 PID |
| 编辑器 DOM 随模式变化（WYSIWYG=`.ProseMirror`，SV=`.cm-content`） | 先跑 `probe-page.js` 探测当前模式，不硬编码选择器 |
| `debugger.attach` 冲突（用户开着 DevTools） | 模板返回 `attachError`，先请用户关 DevTools |

## 与 Windows 真机验证的关系

AGENTS.md 记录的 Windows VM 验证（`--remote-debugging-port` + PowerShell `ClientWebSocket` 发 `Runtime.evaluate`）可用本 skill 的 `cdp.mjs` 与表达式模板替代：虚拟机内带调试端口启动应用后，从本机 SSH 端口转发或直连该端口即可，脚本零改动复用。
