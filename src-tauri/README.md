# src-tauri —— Tauri 2 壳层（v2 迁移）

把 1.x Electron 主进程（`src/main/**`）里「只有宿主才能做的事」搬到 Tauri 2 壳层；
业务全部在 `crates/hqsf-core`（端口 trait 见 `crates/hqsf-core/src/ports.rs`）。
设计依据：`doc/design/Tauri迁移计划.md` §1/§4/§5/§7 与 `doc/design/Rust实现约定.md`。

> ⚠️ 本机（bwrap 只读沙箱 + 无 `pkg-config`/WebKitGTK）**编不了这个 crate**：`cargo check`
> 会在 `glib-sys`/`webkit2gtk-sys` 的 build script 处失败，属预期。壳层代码靠「严格照 Tauri 2
> 官方 API + 保守写法」保证正确性，第一轮真实编译由 CI 的 shell job 完成。
> 所有不确定点都标了 `// TODO(verify):`（清单见文末）。

## 目录

```
src-tauri/
├── Cargo.toml                 # 独立 workspace（根 Cargo.toml exclude 了 src-tauri）
├── build.rs                   # tauri_build::build()
├── tauri.conf.json            # 窗口（create:false）/ 包 / 资源 / 图标
├── tauri.macos.conf.json      # 平台覆盖：decorations + hiddenInset 等价配置（数组整替！）
├── capabilities/default.json  # 最小权限集：core:default + core:window:allow-start-dragging，不开 fs/shell/http
├── icons/                     # 由 resources/icon.png 与 resources/icon.ico 生成（见下）
├── resources/                 # api.config.json / agreement.md / changelog.md（脚本生成，不入库）
├── scripts/
│   ├── prepare-resources.mjs    # 拷贝 electron-builder extraResources 的三项
│   └── gen-tauri-commands.mjs   # 生成 85 个 #[tauri::command]（生成物暂不提交）
├── src/
│   ├── main.rs                # 极薄入口：hq_scifi_lib::run()
│   ├── lib.rs                 # 启动编排：单实例 → CoreCtx → 窗口 → 协议 → 导航策略
│   ├── dispatch.rs            # HqsfError/HqsfResult + WholePayload（整包入参）+ 内部命令
│   ├── commands_generated.rs  # 85 个 #[tauri::command]（生成物，gitignored）
│   └── runtime/               # 端口实现（files/secrets/http/events/clock/paths/platform）
└── testdata/contracts/        # 冻结的 85 通道契约（上一阶段产出）
```

## 启动链路（`src/lib.rs`）

```
main.rs
└─ hq_scifi_lib::run()
   ├─ 注册 single-instance（第二个实例 → 聚焦已有窗口）
   ├─ 注册 opener / dialog / clipboard-manager 插件
   ├─ register_asynchronous_uri_scheme_protocol("hqsf-img")   # 后台线程抓图
   ├─ commands_generated::register(builder)                    # 85 条命令静态注册
   ├─ setup:
   │   ├─ runtime::mark_main_thread()   # 供 blocking dialog 判死锁风险
   │   ├─ detect_test_mode()            # --test 或 HQSF_TEST=1 → appData/hqsf-test
   │   ├─ AppPaths{data_dir,resource_dir,documents_dir,test_mode}
   │   ├─ migrate_legacy_data(旧 userData → data_dir)   # 必须在 Db::open 之前
   │   ├─ Db::open(data_dir/hqsf.db)
   │   ├─ CoreCtx::new(files, secrets, http, events, clock, paths, db, platform)
   │   ├─ manage(AppState{core, maximized, startup, updater})
   │   ├─ create_main_window()          # from_config(create:false) + 导航/新窗口/加载回调
   │   │   └─ on_page_load(Finished): show+focus + 注入 Ctrl+F12 + apply_settings_to_window()
   │   └─ spawn_startup_tasks()         # 两条 detach 线程，不阻塞窗口展示
   │       ├─ startup_token_check()     # 有 token → verify_session_token → 明确失效才 clear()
   │       └─ schedule_auto_update_check()  # autoUpdate 开启且非 deb → sleep 10s → check_for_github_update
   └─ app.run():
       ├─ RunEvent::Ready → 有 PendingStartupError 就弹错误框，关掉后 exit(1)
       └─ macOS RunEvent::Reopen → 主窗口 show+unminimize+focus（不重建、不加 prevent_exit）
```

1.x 对应：`src/main/bootstrap/index.ts:40-85`（loadApiConfig → initDb → registerImageProtocol →
registerIpcHandlers → createWindow）。差异：**api.config.json 不在启动期校验**（内核
`services::net::api_config()` 每次调用现读），所以缺配置不会再出现 1.x 那种「进程活着但无窗口」，
而是首个网络命令返回 `[API 配置] …` 错误。

## 线程模型（决定了每个命令的写法）

| 场景 | 线程 | 后果 |
| --- | --- | --- |
| 同步 `#[tauri::command]` | IPC 回调线程 —— Linux/GTK 与 macOS/WKWebView 上就是**主线程** | 任何阻塞调用都会冻结 UI；blocking dialog 直接死锁 |
| `async fn` 命令 | `async_runtime::spawn` → tokio worker | 阻塞只会占用一个 worker，不挡 UI |
| 自定义协议回调（`hqsf-img`） | webview 的 scheme 回调线程 | 同步版必须立刻返回（真正抓图要换异步注册） |

因此内核的同步端口（`HttpTransport` / `Dialog` 的 blocking API / 剪贴板读取）只允许在 async 命令里调：
`scripts/gen-tauri-commands.mjs` **统一生成 `pub async fn`**，`dispatch.rs` 顶部写明了这个约束
（改成同步命令 = 首屏一次网络请求就卡住窗口）。`runtime/mod.rs` 的 `is_main_thread()` 用于在误用时
留痕并自动降级（`show_message` 在主线程走非阻塞 `show`，避免死锁）。

## 端口实现的关键选择

### `Files`：`runtime/files.rs`（`std::fs`）

- `modified_ms` 用 `mtime` 的 Unix 毫秒（1.x `fs.Stats.mtimeMs`）。
- `list()` 排序：**目录优先，然后按小写名称**；1.x 用 `name.localeCompare(b, 'zh')`（中文拼音序），
  Rust 标准库没有等价实现 → 中文名排序与 1.x 不同。TODO：接 `pinyin` crate 或把排序移到渲染层。
- `write`/`rename` 自动建父目录（1.x `writeLocalDoc` 语义）；`list` 跳过单条 stat 失败的条目。

### `Secrets`：`runtime/secrets.rs`（keyring 3.6 → 系统钥匙串）

- service = `com.huangqisf.client`（= identifier），account = 内核传入的 key
  （会话键是 `hqsf.session`，见 `crates/hqsf-core/src/services/net.rs`）。
- **无 keyring 时显式报错**：`CoreError::app("系统钥匙串不可用（…）：…")`。
  1.x 的 `safeStorage` 在 Linux 上会降级成 `basic_text`（伪加密）并写 `session.json`；
  v2 **不降级**、不落明文 —— 迁移计划 §1.5 已确认这会导致**强制重新登录**（旧密文无法跨实现解密）。
- `get` 把 `NoEntry` 映射为 `Ok(None)`（未登录），`delete` 幂等。
- TODO(verify)：任务要求 keyring 4.x；4.0 把 `Entry` 移到 `keyring-core` 且要显式初始化 store，
  先用 3.6（语义相同），CI 可编译后升级。

### `Http`：`runtime/http.rs`（reqwest async + 专用 tokio Runtime）

`HttpTransport::send` 是**同步** trait，实现方式是：

```rust
runtime.spawn(async { ... })            // 专用 tokio Runtime（2 worker，thread_name "hqsf-http"）
  + std::sync::mpsc::recv_timeout(超时 + 5s grace)
```

- **不用 `tauri::async_runtime::block_on`**：在 async 命令（tokio worker）里嵌套 `block_on` 会 panic
  （「Cannot start a runtime from within a runtime」）。
- **也不用 reqwest 的 `blocking`**：它内部同样是 `block_on` 一个 runtime，行为与上一条同因。
- 风险（已在源码注释写明）：① 阻塞调用线程 —— 命令层是 worker 线程可接受，**主线程绝对不可**；
  ② 超时后后台任务可能仍在跑（无取消句柄）；③ 已关闭 reqwest 的 system-proxy（与 1.x undici 直连一致）。
- 超时：`HttpRequest.timeout_ms` 优先，`0` 用默认 15s；header 逐条透传（非法名/值跳过并 TODO）。

### `Events`：`runtime/events.rs`

`AppHandle::emit(event, payload)`，事件名原样（`hqsf:window-maximized-changed`、`hqsf:update-state`）。
TODO(verify)：多窗口出现时改为 `emit_to(MAIN_WINDOW_LABEL, …)`。

### `Clock`：`runtime/clock.rs`

`SystemTime::now()` → Unix 毫秒；时钟早于 1970 返回 0（不 panic）。

### `Paths`：`runtime/paths.rs`

| 1.x | v2 |
| --- | --- |
| `app.getPath('userData')` = `~/.config/hqsf-client` | `app_data_dir()` = `$XDG_DATA_HOME/com.huangqisf.client` |
| 测试模式 `<appData>/hqsf-test` | 同（`app_data_dir()` 的父目录 + `hqsf-test`） |
| `process.resourcesPath` | `resource_dir()`（debug 且仓库根有 `api.config.json` 时用仓库根） |
| `app.getPath('documents')` | `document_dir()`，取不到回退 `$HOME/Documents` |

`HQSF_API_CONFIG` 仍支持：取其**父目录**作为 `resource_dir`（内核只认 `resource_dir/api.config.json`）。
TODO(verify)：迁移计划 §1.5 写测试目录为 `com.huangqisf.client-test`，本实现按 1.x 用 `hqsf-test`。

### `Clipboard` / `Dialog` / `Launcher` / `WindowOps`：`runtime/platform.rs`

- **剪贴板**：tauri-plugin-clipboard-manager 只有 `read_text`/`write_text`/`write_html`，
  **没有 `read_html`** → `read_html()` 显式返回错误（不静默返回空串），TODO(verify) 提 `arboard`。
- **对话框**：`blocking_pick_folder`/`blocking_pick_file`/`blocking_show_with_result`
  （文档要求不要在 main thread 调 —— 命令层是 worker 线程；唯一例外是启动失败时的
  `show_message`，那时事件循环还没跑）。
  `show_message_box` 返回按钮下标：`Ok/Yes→0`、`No→1`、`Cancel→cancel_id`；
  按钮组合映射到 rfd 的 `Ok / OkCancelCustom / YesNoCancelCustom`（**最多 3 个按钮**，
  超出丢弃并记日志，现有通道无此用法）；`detail` 拼进正文；关闭后 `set_focus()` 还给主窗口。
- **外链**：`open_external` 先校验 scheme 仅 `http(s)`（否则 `CoreError::Forbidden`），再交
  `tauri_plugin_opener::open_url`；`reveal_in_folder`/`open_path`/`trash` 对应 1.x
  `shell.showItemInFolder`/`openPath`/`trashItem`（`trash` crate，回收站可恢复）。
- **自定义 CSS（与 Electron `insertCSS` 的差异）**：Tauri 没有等价 API，实现为 `eval` 注入
  `<style id="hqsf-custom-css">`。语义按内核契约：**每次注入先移除上一次的节点**（壳层自持 key，
  因为内核无状态），空字符串 = 仅清理。三点差异：
  1. Electron 插在 **user origin** 样式表；这里是 **author origin** 的 `<style>`，
     页面里带 `!important` 的规则可能压过自定义样式；
  2. 节点在 DOM 里可见、可被页面脚本改动；
  3. 页面 reload 后节点消失，需要重放（1.x 也在 `did-finish-load` 重放）。
- **devtools**：`open_devtools`/`close_devtools` 只在 debug 或 `--features devtools` 时存在；
  release 未开启时只打日志（1.x 生产包仍可 Ctrl+F12 —— 已知差异，需要时用 `devtools` feature 构建）。
- **Ctrl+F12**：不用全局快捷键（系统级、失焦也生效，与 1.x 语义不符），改为页面加载后注入
  keydown 监听 → 调用内部命令 `__hqsf_toggle_devtools`
  （`window.__TAURI_INTERNALS__.invoke` 非公开 API → TODO(verify)）。

## `hqsf-img` 自定义协议

1.x：`src/main/infra/media/imgcache.ts:281-300`（`protocol.handle('hqsf-img', …)`，本地缓存 + sha1 文件名）。

- 协议 origin 随平台变：**Windows/Android** = `http://hqsf-img.localhost/...`；
  **Linux/macOS** = `hqsf-img://localhost/...`。所以渲染层 URL 拼装也必须按平台分支
  （1.x 渲染层 `src/renderer/src/lib/sanitize.ts:83` 写死 `hqsf-img://fetch?url=` → 下一张卡要改）。
- 已接真（第二轮）：`hqsf_core::infra::media::shared().get_with_content_type(&ctx, url)`，
  命中磁盘/内存缓存直接返回，否则下载并落 `cache/images/<sha1(url)>`（单图 10MB、目录 16MB、
  内存 LRU 8MB、in-flight 去重）；`Content-Type` 用内核返回值。
- 注册用**异步**版 `register_asynchronous_uri_scheme_protocol` + 后台线程 `responder.respond(...)`：
  同步 handler 在 Linux/GTK 上跑主线程，网络慢会冻界面。
- 响应头：`Cache-Control: no-store`（内核自己缓存，webview 再缓存会让「清除缓存」失效）、
  `Access-Control-Allow-Origin: *`（自定义协议是独立 origin，`<img>`/canvas 需要 CORS）。
- 失败映射：`NotFound`→404、`Forbidden`→403、其余（网络/上游/缓存）→502，body 是内核中文文案。

## 开发 / 构建

```bash
# 1) 准备前端产物（1.x 仍是 electron-vite 构建，v2 阶段会换成 vite）
npm run build:web             # → out/web/index.html（tauri.conf.json 的 frontendDist）

# 2) 准备打包资源（api.config.json 不入库，必须本地有）
node src-tauri/scripts/prepare-resources.mjs

# 3) 运行 / 打包（需要 WebKitGTK 等系统依赖，本沙箱内不可用）
cd src-tauri
cargo tauri dev
cargo tauri build                       # deb/appimage/nsis/dmg，按平台
cargo build --release --features devtools   # 需要 Ctrl+F12 调试面板时
```

## 图标

`icons/` 已由 `resources/icon.png`（512×512）与 `resources/icon.ico` 生成：
`32x32.png` / `128x128.png` / `256x256.png` / `128x128@2x.png` / `icon.png` / `icon.ico`；
`icon.icns` 是手工拼的 PNG-in-ICNS 容器（ic07/ic08/ic09/ic13/ic14）。

**仍缺 / 待补**：
- `Square*Logo.png`（`tauri.conf.json` 的 `bundle.windows` 商店图标，当前用 nsis 不需要，UWP 才要）；
- `StoreLogo.png`；
- 1.x 的 `executableName: huangqi-scifi` 没有对应字段：Tauri 用 `productName` 生成可执行文件名
  （`hq-scifi`）→ 升级安装路径与 1.x 不同，打包卡要确认是否需要 `bundle.linux.deb.files`/重命名。

## 生成器（`scripts/gen-tauri-commands.mjs`）

读 `testdata/contracts/commands.json` + 扫 `crates/hqsf-core/src/commands/*.rs` 的 `pub fn` 签名，
生成 `src/commands_generated.rs`（85 个 `#[tauri::command] pub async fn`，**生成物不入库**）。

自动处理的三类「壳层注入参数」（不进渲染层入参，见脚本 `shellInject()`）：

| core 形参 | 壳层怎么给 | 依据 |
| --- | --- | --- |
| `host: &HostInfo` | `crate::build_host_info(&app)`（额外注入 `app: tauri::AppHandle`） | 1.x `process.platform` / `app.getVersion()` / `app.isPackaged` |
| `docs_root`（`impl Into<String>`） | `hqsf_core::infra::fs::docs_root(&state.core.paths, &state.core.db)` | 1.x `getDocsRoot()`（含 settings 里的自定义目录） |
| `exe_path: &Path` | `std::env::current_exe()` | 1.x `app.getPath('exe')` |

另外 `hqsf:uninstall` 成功后额外 `app.exit(0)`（1.x `setImmediate(app.quit)`）。

当前状态：**85/85 全部自动生成，MANUAL 0 条**（内核 85 条 `pub fn` 已全部落地）。

两条形态规则：

1. **平铺形参**（53 条）：命令形参名 = core 形参名（snake_case），`#[tauri::command(rename_all =
   "camelCase")]` 让 tauri 按 lowerCamelCase 去 JS 对象里取键，正好命中契约 `params[i].name`
   （`dir_rel`→`dirRel`、`is_draft`→`isDraft`…）。生成器逐条断言 `toLowerCamel(形参) === 契约名`。
2. **整包入参**（32 条，core 用 `*Args` 结构体吃掉整个载荷）：生成
   `args: WholePayload<ListReviewsArgs>`，由 `dispatch.rs` 里 `WholePayload` 的
   `CommandArg` 实现**忽略按键取值**、直接把整个 JSON 载荷反序列化成结构体。这样
   `{opts: …}` / `{cid, opts}` / `{payload: …}` / `{reviewId, type}` 都能落地；
   含 `type` 关键字的 3 个通道（`list-metas` / `add-log` / `set-review-attitude`）靠内核结构体
   自己的 `#[serde(rename = "type")]` 还原。camelCase 字段名来自结构体自身的
   `#[serde(rename_all = "camelCase")]`。

生成器刻意**不**做「通用转发命令」，否则 85 条白名单会塌缩成一个动态入口（违反迁移计划 §6.4）；
注册走 `register()` 里的 `tauri::generate_handler![…85 条…]` 静态展开。

`--verify` 是纯 Node 的契约门禁（CI 的 shell job 会跑）：85 条各生成一次、命令名 == 契约
`rustCommand`、每条带 `rename_all`、平铺形参 wire 名与契约参数逐一相等、整包结构体 wire 字段
⊇ 契约参数名、`register()` 覆盖全部命令、生成物无漂移。

## 启动后台任务（第三轮）

1.x 在 `createWindow()` 之后调两个「发出去就不管」的任务（`src/main/bootstrap/index.ts:86-87`）。
Tauri 侧由 `setup` 末尾的 `spawn_startup_tasks(app.handle().clone())` 复刻，**两条独立线程、不 await**：

| 任务 | 1.x 来源 | 实现要点 |
| --- | --- | --- |
| 启动会话校验 | `startupTokenCheck()`（`src/main/bootstrap/index.ts:20-31`） | `auth::stored_token` → 有才 `auth::verify_session_token`；`!valid && reachable`（服务端明确拒绝）才 `session::clear`；**不发** `logout`/`signOut`；网络/钥匙串异常只打日志、不清本地会话（离线可继续本地写作） |
| 自动更新检查 | `scheduleAutoUpdateCheck()`（`src/main/infra/updater/index.ts:80-92`） | `settings::get(ctx).auto_update` → 内核 `auto_check_enabled(autoUpdate, platform, APPIMAGE)` → 满足才 `sleep(10s)` → `services::updater::check_for_github_update(&ctx, &store)`，错误静默（内核自己把失败写进 store 并发 `hqsf:update-state`） |

差异与取舍：
- 1.x 用 `setTimeout(...).unref?.()`；这里是 detach 线程，进程退出时自然结束（无 `unref` 等价物）。
- `platform` 取值沿用 `HostInfo.platform` 的 `"windows" | "macos" | "linux"`；1.x 在 macOS 上是
  `"darwin"`。对判定无影响 —— 内核 `auto_check_enabled` 只区分 `"linux"`（`infra/updater.rs:243`）。
- 线程里不长期持有 `State<'_, AppState>`，只克隆 `Arc<CoreCtx>` / `Arc<UpdateStateStore>`
  （`startup_task_state()`），避免借用过期。

## 集成状态（第二轮）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 85 条命令 dispatch | ✅ 已生成（`--write`） | `commands_generated.rs` 704 行、85 条 `#[tauri::command(rename_all = "camelCase")] pub async fn` + `register()`；生成物 gitignored，**编译前必须先跑生成器**（CI shell job 已加步骤） |
| `hqsf-img` 协议 | ✅ 接真 | 走 `media::shared().get_with_content_type`，异步注册 + 后台线程 |
| 启动数据迁移 | ✅ 已接 | `migrate_legacy_data(旧 userData → data_dir)` 在 `Db::open` 之前；`NoSource`/`AlreadyMigrated`/`DryRun` 静默，`Migrated` 打日志，失败 → `PendingStartupError` 弹框 |
| 设置生效链路 | ✅ 已接 | `on_page_load(Finished)` 每次调 `commands::settings::apply_settings_to_window(&ctx)`；内核内部：`set_zoom(zoomFactor)` → 非空 `insert_css(customCss)` → 非空 `execute_js(customJs)` |
| 更新状态机 | ✅ 已注入 | `AppState.updater: Arc<UpdateStateStore>`，四条 `update-*` 命令共享（1.x 是模块级单例）；启动自动检查也用它 |
| 启动后台任务（第三轮） | ✅ 已接 | `startup_token_check` + `schedule_auto_update_check`，见上一节 |

**已知缺口（内核侧，壳层不改）**：`services::settings` 只在 `customCss`/`customJs` **非空**时才调
`insert_css`/`execute_js`，所以「把自定义 CSS 从有改到空」时同一会话里旧样式会残留（刷新后消失）。
壳层 `insert_css("")` 本身支持「移除」，需要内核在清空时也调用一次。

**必须 CI（真机）验证的 Top 5**（本机无 WebKitGTK，全都只能靠 CI 首跑暴露）：

1. `cargo check --manifest-path src-tauri/Cargo.toml --all-targets` 能否过（重点：生成的 85 条命令的
   `State<'_, AppState>` 生命周期、`WholePayload` 的 `CommandArg` impl、`generate_handler!` 里
   `crate::dispatch::__hqsf_toggle_devtools` 路径展开）。
2. `tauri::generate_context!()` 编译期嵌入 `../out/web`（CI 先 `npm run build:web`）。
3. `register_asynchronous_uri_scheme_protocol` 的 handler 签名与 `UriSchemeResponder` 的 `Send` 移动
   （已按 docs.rs 2.12 核对：`Fn(UriSchemeContext, Request<Vec<u8>>, UriSchemeResponder)`）。
4. `app.path().config_dir()` 在 Linux 上是否等于 Electron 的 `app.getPath('appData')`（迁移源目录命中率）。
5. 权限最小集是否够用：`core:default` + `core:window:allow-start-dragging`（无 fs/shell/http 权限，
   文件访问全走命令）。**已静态核实**：tauri 2.12 的 `core:window:default` 权限列表（crate 内
   `permissions/window/autogenerated/reference.md`）不含 `allow-start-dragging`，而 `start_dragging`
   命令是 `#[command(root = "crate")]`（无 `default`）→ 必须显式授权；`src/bridge/drag.ts` 与
   `data-tauri-drag-region` 两条路径都吃这条权限。剩下要在 CI 确认的只是它能否正常生效。

## 未完成（后续卡）

1. **窗口行为**：`data-tauri-drag-region` 替代 `-webkit-app-region: drag`（1.x 自定义标题栏靠 CSS，
   Tauri 需在 DOM 上加属性 + capability `core:window:allow-start-dragging`，已开；渲染层现由
   `src/bridge/drag.ts` 走 `plugin:window|start_dragging`，同样吃这条权限）。macOS 的
   「关窗不退出 + Dock 重开」需要 `ExitRequested` + `prevent_exit()`，**本轮明确不做**（保留 Tauri
   默认的关窗即退出，见 `lib.rs` 文件头差异 7）。
2. **渲染层协议 URL**：`src/renderer/src/lib/sanitize.ts:83` 写死 `hqsf-img://fetch?url=`，
   Windows 上应为 `http://hqsf-img.localhost/fetch?url=`（壳层两种形态都接受，但渲染层要按平台拼）。
3. **发布流程**：`.github/workflows/release.yml` 打包前也要跑
   `node src-tauri/scripts/gen-tauri-commands.mjs --write` + `prepare-resources.mjs`
   （生成物与 resources 都不入库）。

## TODO(verify) 清单（全部在源码里可 grep）

| 文件 | 内容 |
| --- | --- |
| `runtime/platform.rs` | `FileDialogBuilder::set_directory` 入参类型；`read_html` 用 `arboard`；`show_message_box` 任意按钮数 / `defaultId` |
| `runtime/secrets.rs` | keyring 4.x 升级 + store 初始化 |
| `runtime/http.rs` | header 非法值是否应报错；超时后台任务无取消 |
| `runtime/paths.rs` | 测试数据目录名 `hqsf-test` vs 迁移计划的 `com.huangqisf.client-test`；dev 资源目录取仓库根 |
| `runtime/events.rs` | 多窗口时改 `emit_to` |
| `lib.rs` | `__TAURI_INTERNALS__.invoke` 非公开 API（Ctrl+F12 注入）；macOS `Reopen` 只在「窗口隐藏/最小化」时可达（不加 `prevent_exit`，已在注释里定案） |
| `tauri.conf.json` | `zoomHotkeysEnabled:false` 是否与 1.x 一致（1.x 自己处理缩放） |