//! 命令分发层公共部分：错误适配（[`HqsfError`]）、整包入参（[`WholePayload`]）、
//! 内部命令（`__hqsf_toggle_devtools`）。85 个通道命令本体由
//! `scripts/gen-tauri-commands.mjs --write` 生成到 `commands_generated.rs`。
//!
//! 迁移来源：
//!   - `src/main/ipc/index.ts` / `src/main/ipc.ts`（85 个 `ipcMain.handle('hqsf:*')` 白名单）
//!   - `src/preload/index.ts`（`window.hqsf` 暴露 85 个 invoke + 2 个事件订阅）
//!   - `src/shared/contracts/commands.ts`（通道名/入参/返回的单一来源）
//!   冻结契约：`crates/hqsf-core/src/commands/registry.rs`（`COMMANDS` / `EVENTS` /
//!   `EXPECTED_INVOKE_TOTAL = 85`）与 `src-tauri/testdata/contracts/commands.json`。
//!
//! 与 Electron 的差异：
//!   1. Electron 的 `ipcMain.handle` 直接返回 `{ok,data}|{ok,error}`；Tauri 的 command 返回值
//!      序列化后就是 JS Promise 的 resolve 值，**失败走 reject**。所以这里约定：
//!        - 成功：T 原样序列化（下一张卡的 preload 等价层负责包成 `{ok:true,data}`）；
//!        - 失败：[`HqsfError`] 序列化成 `{ok:false,error:"<中文消息>"}`（与 1.x 的错误信封同形），
//!          这样渲染层包装层两侧都能用同一个结构判断。
//!      `hqsf-core` 的 `CoreError` 没有（也不该）实现 `serde::Serialize`，故壳层用 newtype 适配。
//!   2. 通道名与命令名的映射是**扁平**的：Tauri command 名就是 core 函数名（`add_comment`），
//!      不存在 `hqsf:add-comment` 这种带冒号的通道 —— preload 等价层负责把 1.x 通道名映射到
//!      Tauri 命令名（映射表由 `commands.json` 的 `channel`↔`rustCommand` 字段生成）。
//!   3. 事件名保持原样（`hqsf:window-maximized-changed`、`hqsf:update-state`），见 `lib.rs` 与
//!      `runtime/events.rs`；Tauri 不限制事件名里的冒号。
//!
//! 本文件当前只放两样东西：
//!   - [`invoke_placeholder`]：未接入通道的统一错误（给 preload 等价层兜底，不注册为命令）；
//!   - [`__hqsf_toggle_devtools`]：内部命令，给注入的 Ctrl+F12 监听用（不是 85 条对外通道之一）。
//!
//! ## 下一张卡：生成 85 个命令所需信息（已就位）
//!   - 契约：`src-tauri/testdata/contracts/commands.json`（每条含 `channel` / `method` / `params` /
//!     `returns` / `errors` / `handler` / `rustCommand` / `rustModule` / `lane` / `kind`）；
//!   - 内核注册表：`crates/hqsf-core/src/commands/registry.rs` 的 `COMMANDS`（与契约同源、有测试）；
//!   - 内核函数：`crates/hqsf-core/src/commands/<module>.rs` 的 `pub fn`（`ctx: &CoreCtx` 第一个参数，
//!     其余参数与 `params` 顺序一致）；
//!   - 生成器脚本：`src-tauri/scripts/gen-tauri-commands.mjs`（读契约 + 扫 core 签名 → 输出本文件）。
//!
//! 生成后的命令形态（示例，决定 next card 的写法）：
//! ```ignore
//! #[tauri::command]
//! pub async fn add_comment(
//!     state: State<'_, AppState>,
//!     payload: CommentPayload,
//! ) -> HqsfResult<CommentSubmitResult> {
//!     hqsf_core::commands::comment::add_comment(&state.core, payload).map_err(HqsfError::from)
//! }
//! ```
//!
//! ## 为什么统一写成 `async fn`（**不要**改成同步）
//! Tauri 对两种命令的派发方式不同：
//!   - 同步命令：在 IPC 回调线程上**就地**执行。桌面端的 IPC 走自定义 URI scheme
//!     （`ipc://localhost/...`），Linux/GTK 与 macOS/WKWebView 的 scheme 回调跑在**主线程**上 ——
//!     于是任何阻塞调用都会冻结 UI（阻塞式 dialog 甚至直接死锁：对话框自己要主线程才能弹出）。
//!   - `async fn`：由 `async_runtime::spawn` 派发到 tokio worker 线程，不占主线程。
//! 内核的 `HttpTransport` / `Dialog` 端口是同步 trait（`runtime/http.rs` 用
//! `spawn + mpsc::recv`、`runtime/platform.rs` 用 `blocking_show*`），所以这 85 条命令
//! **必须**是 async，否则「首屏一次网络请求就卡住整个窗口」。
//! 例外：本文件里的 `__hqsf_toggle_devtools` 只做一次窗口状态切换，保持同步（不阻塞）。
//!   **禁止**出现「通用转发命令」（通道名 + serde_json::Value 直接路由到内核）：
//!   那等于把 85 条白名单塌缩成一条动态入口，违反迁移计划 §6.4 的安全不变式。
//!   每条命令必须独立注册、独立入参类型。

// 生成物：`commands_generated.rs`（gitignored）里是 85 个 `#[tauri::command]`，
// 由 `node src-tauri/scripts/gen-tauri-commands.mjs --write` 生成；
// `lib.rs` 里 `mod commands_generated;` + `commands_generated::register(builder)` 接进来。
// 手写本文件的原因：生成代码需要两个手写件 —— 错误适配与整包入参。

use hqsf_core::error::CoreError;
use serde::{Serialize, Serializer};
use tauri::State;

use crate::AppState;

/// 命令出口错误：把内核的 [`CoreError`] 适配成「可被 Tauri 序列化」的错误类型。
///
/// 序列化结果与 1.x IPC 的错误信封一致：`{ "ok": false, "error": "<中文消息>" }`。
/// 命令函数内部仍然只认 `CoreResult<T>`；这里的 newtype 只出现在 `#[tauri::command]` 边界上。
#[derive(Debug)]
pub struct HqsfError(pub CoreError);

impl From<CoreError> for HqsfError {
    fn from(error: CoreError) -> Self {
        Self(error)
    }
}

impl std::fmt::Display for HqsfError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for HqsfError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.0)
    }
}

impl Serialize for HqsfError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // CoreError::to_envelope() 已实现 Serialize（ErrorEnvelope{ok:false,error:String}）。
        self.0.to_envelope().serialize(serializer)
    }
}

/// 壳层命令的统一返回类型（`Result<T, CoreError>` + 序列化适配）。
pub type HqsfResult<T> = Result<T, HqsfError>;

/// 未接入通道的兜底错误。
///
/// 不是 `#[tauri::command]`：用作 preload 等价层的默认分支与生成器的占位实现，
/// 避免「通道拼错」被静默吞掉。
// 现在 85 条命令全部生成、没有通道走这里；保留给 `src/bridge` 的兜底分支与下一轮回归测试。
#[allow(dead_code)]
pub fn invoke_placeholder(channel: &str) -> HqsfResult<serde_json::Value> {
    Err(HqsfError(CoreError::app(format!(
        "命令尚未接入壳层：{channel}（等待 dispatch 生成卡按 commands.json 生成 85 个命令）"
    ))))
}

/// 「整包入参」：把**整个** invoke 载荷反序列化成内核的 `*Args` 结构体。
///
/// 为什么需要它：有 32 条通道的载荷是「一个对象」（`{opts: …}`、`{cid, opts}`、
/// `{payload: …}`、`{reviewId, type}` …），而内核把整个对象收成一个 `*Args` 结构体。
/// 若按普通形参写 `args: WholePayload<X>`，Tauri 会去 JS 对象里找名为 `args` 的键
/// （见 `tauri-macros` 的 `CommandArg::from_command`），而桥接层发的是**平铺对象** ——
/// 键根本不存在，运行时报 `invalid args`。所以这里实现 [`tauri::ipc::CommandArg`]：
/// 忽略「按名字取键」，直接取整个 payload 交给 `serde`。
///
/// 3 个通道的载荷里有 `type` 键（`hqsf:list-metas` / `hqsf:add-log` /
/// `hqsf:set-review-attitude`）。Rust 形参名没法叫 `type`（`r#type` 经 heck 会被
/// 转成 `rType`），走整包反序列化则由内核结构体自己的 `#[serde(rename = "type")]`
/// 还原 —— 这正是内核为 1.x 载荷写的 serde 属性，逐字对得上。
///
/// 与 Electron 的差异：1.x 是 `ipcMain.handle('hqsf:add-log', (_e, payload) => …)`，
/// 第二个参数就是整个对象；这里语义等价，只是把「按 key 取值」换成「整体
/// `serde_json::from_value`」。camelCase 字段名由内核结构体自身的
/// `#[serde(rename_all = "camelCase")]` 负责（`--verify` 会逐条断言）。
pub struct WholePayload<T>(pub T);

impl<'de, R, T> tauri::ipc::CommandArg<'de, R> for WholePayload<T>
where
    R: tauri::Runtime,
    T: serde::de::DeserializeOwned,
{
    fn from_command(
        command: tauri::ipc::CommandItem<'de, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        match command.message.payload() {
            // 桥接层（`src/bridge/invoke.ts`）只发 JSON 对象，走这一支。
            tauri::ipc::InvokeBody::Json(value) => serde_json::from_value(value.clone())
                .map(WholePayload)
                .map_err(|error| tauri::ipc::InvokeError::from(format!("调用参数不合法：{error}"))),
            // Raw（二进制）载荷：1.x 没有这种通道，明确报错而不是静默解成空结构体。
            tauri::ipc::InvokeBody::Raw(_) => Err(tauri::ipc::InvokeError::from(
                "调用参数不合法：该通道期望 JSON 对象载荷",
            )),
        }
    }
}

/// 内部命令：切换 devtools（由 `lib.rs` 注入的 Ctrl+F12 监听调用）。
///
/// 1.x：`src/main/window/index.ts:55-67` 的 `before-input-event`。
/// 通道名不是 85 条对外白名单之一，故用双下划线前缀区分；渲染层不直接暴露给业务代码。
#[tauri::command]
pub fn __hqsf_toggle_devtools(state: State<'_, AppState>) -> HqsfResult<()> {
    state.core.platform.window.toggle_devtools();
    Ok(())
}

/// 渲染层日志文件上限（超过后滚动成 `renderer.log.1`，只保留一份备份）。
const RENDERER_LOG_MAX_BYTES: u64 = 1_048_576;
/// 单条日志最多保留的字符数（避免一条超长 message 把文件顶爆）。
const RENDERER_LOG_LINE_MAX_CHARS: usize = 2_000;

/// 内部命令：接收渲染层 `console.*` 与未捕获异常，追加到 `<data_dir>/logs/renderer.log`。
///
/// 为什么需要它：release 包默认不编译 `devtools` feature，用户机器上看不到 console；
/// 有了这个文件，用户报「某处白屏/报错」时可以直接把日志发回来（等价于 1.x 里
/// 让用户开 devtools 复制控制台）。渲染层由 `lib.rs` 注入的 `CONSOLE_FORWARD_JS` 调用，
/// 壳层只落盘、不做任何判断；写盘失败也不影响页面（渲染层侧已 try/catch）。
#[tauri::command]
pub fn __hqsf_log(level: String, message: String, state: State<'_, AppState>) -> HqsfResult<()> {
    use std::io::Write;

    let dir = state.core.paths.data_dir.join("logs");
    std::fs::create_dir_all(&dir)
        .map_err(|e| HqsfError(CoreError::app(format!("创建日志目录失败：{e}"))))?;
    let path = dir.join("renderer.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > RENDERER_LOG_MAX_BYTES {
            let _ = std::fs::rename(&path, dir.join("renderer.log.1"));
        }
    }

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut line = format!("[{ts}] {level} ");
    line.extend(
        message
            .chars()
            .take(RENDERER_LOG_LINE_MAX_CHARS)
            .map(|c| if c == '\n' || c == '\r' { ' ' } else { c }),
    );
    line.push('\n');

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| HqsfError(CoreError::app(format!("打开渲染层日志失败：{e}"))))?;
    file.write_all(line.as_bytes())
        .map_err(|e| HqsfError(CoreError::app(format!("写入渲染层日志失败：{e}"))))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_serializes_to_envelope() {
        let error = HqsfError(CoreError::app("测试错误"));
        let json = serde_json::to_value(&error).expect("serialize");
        assert_eq!(json["ok"], serde_json::json!(false));
        assert_eq!(json["error"], serde_json::json!("测试错误"));
        // 结构上必须与内核的 ErrorEnvelope 完全一致（渲染层只认这一种形状）。
        let envelope = CoreError::app("测试错误").to_envelope();
        let expected = serde_json::to_value(&envelope).expect("serialize envelope");
        assert_eq!(json, expected);
    }

    #[test]
    fn placeholder_reports_channel_name() {
        let error = invoke_placeholder("hqsf:unknown").expect_err("必须报错");
        assert!(error.to_string().contains("hqsf:unknown"));
    }
}
