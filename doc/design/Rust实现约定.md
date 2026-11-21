# Rust 实现约定（hqsf-core）

> 给并行实现 lane 的 agent 读。**先读本文件，再读你 lane 的契约行，最后读范例代码。**
> 目的：多人/多 agent 同时写同一个 crate 时，边界不互相踩、风格不分裂、验收标准一致。

## 0. 环境

```bash
cd /home/kidelee/Projects/HQ-SciFi
export CARGO_HOME=$PWD/.cargo-home      # 沙箱 HOME 只读，cargo 缓存必须落在仓内
cargo test -p hqsf-core                 # 必须全绿（当前基线 50 个测试）
cargo clippy -p hqsf-core --all-targets -- -D warnings   # 必须零警告
rustfmt --edition 2024 <你改的文件>      # 只格式化自己的文件，不要跑 cargo fmt --all
```

- **不要新增 crate 依赖**（无网络安装；`Cargo.toml` 的依赖表已冻结）。需要新依赖先问 lead。
- **不要运行 `cargo fmt --all`**：会重排别人正在写的文件。
- cargo 会锁 `target/`，并行时构建会排队，属正常。

## 1. 分层与 import 方向

`commands → services → adapters → domain`，`infra` 只被 services/commands 调用；`domain` 不许 import 任何 infra。

- `domain/` 纯规则：输入结构 → 输出结构，无 IO、无 `CoreCtx`。
- `adapters/` 远端 JSON 规整：`Raw`（`#[derive(Deserialize)]`，多别名用 `#[serde(alias)]`）+ `Out`（`#[derive(Serialize, specta::Type)]`）+ 纯函数。
- `services/` 编排：多步、跨子系统，签名吃 `&CoreCtx`。
- `commands/` 一个 IPC 通道一个 `pub fn`：**参数/返回结构体 + 一行调用**，不写业务分支。
- `infra/` 能力实现：只经 `CoreCtx` 的端口访问外界。

## 2. 文件所有权（重要）

**只允许写你自己 lane 分到的文件。** 以下共享文件任何 lane agent 都**不许改**（改了一旦并行就会互相覆盖）：

- `crates/hqsf-core/src/{lib,ctx,ports,testkit,error}.rs`
- 所有 `mod.rs`（`commands/mod.rs`、`adapters/mod.rs`、`services/mod.rs`、`infra/mod.rs`、`domain/mod.rs`）
- `crates/hqsf-core/src/commands/registry.rs`、`crates/hqsf-core/src/infra/{db,net}*`、`crates/hqsf-core/src/infra/sandbox.rs`
- `Cargo.toml`、`src-tauri/**`、`src/**`（1.x 代码是只读参照）

需要**新的端口方法、新错误变体、新 mod 声明、新依赖**时：不要自己加，给 lead 发消息说明「文件 + 签名 + 为什么」，lead 统一改。

## 3. 端口（IO 唯一入口）

`ctx.files`（FileStore）、`ctx.secrets`（SecretStore）、`ctx.http`（HttpTransport）、`ctx.events`（EventSink）、`ctx.clock`（Clock）、`ctx.paths`（AppData/resource 目录）、`ctx.platform.{clipboard,dialog,launcher,window}`。

- 内核里**禁止** `std::fs`、`reqwest`、`keyring`、`tauri`、`std::env`。
- 路径安全：本地文件一律先经 `infra::sandbox::assert_inside(docs_root, path)`。
- HTTP：一律 `infra::net::api::{api_request, download_binary, upload_multipart}`，路径从 `infra::net::config::endpoint(cfg, endpoints::XXX)` 取；token 从 `ctx.secrets.get("token")` 取后 `.token(&t)` 传，**绝不进返回载荷**。

## 4. 错误与文案

- 返回 `CoreResult<T>`；用户可见文案用 `CoreError::App(msg)`，**逐字照抄 1.x 的中文文案**（契约文档 `errors[]` 与源码 `file:line` 给了原文）。
- 「未登录」类：1.x 文案为 `未登录`（`fail('未登录')` 传错参数导致 error=undefined 是 1.x 的 bug，Rust 侧修成正常文案，并在报告里记一笔）。
- 配置类 `CoreError::config`（自动带 `[API 配置] ` 前缀）；远端 `code != 1` 由 `net` 层转 `CoreError::Api`。
- 不要在错误里拼路径/URL/SQL（`code()` 已分类）。

## 5. 序列化

- 给渲染层的载荷统一 `#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]` + `#[serde(rename_all = "camelCase")]`（TS 侧字段是 camelCase）。
- 字段名与 1.x 返回对象**完全一致**（含 `type` 这类关键字：`#[serde(rename = "type")]`）。
- 可缺省字段：1.x 里 `?:` 的用 `Option<T>`；1.x 里必有但可能为 null 的按实际类型（如 `String` 用默认空串前先核对源码）。
- 新增 wire 类型后**不要**自己登记到 `hqsf-bindings`（lead 统一加 `register::<T>()`），但要在报告里列出「新增根类型清单」。

## 6. 测试

- 用 `crate::testkit::{ctx, ScriptedHttp, MemFiles, MemSecrets, FixedClock, …}`，不碰真实磁盘/网络/钥匙串。
- 每个命令至少：成功路径 + 失败文案断言；错误文案用 `assert_eq!(err.to_string(), "原文")`。
- 纯函数用表驱动；有 1.x 语义歧义时用测试把选择钉死，并在报告里写明依据 `file:line`。
- 测试名用英文蛇形、一句话说清断言什么。

## 7. 命令函数形态

```rust
/// `hqsf:xxx` 对应实现。契约见 `doc/design/Tauri命令契约.md`。
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct XxxArgs { /* 与契约 params 字段一致 */ }

pub fn xxx(ctx: &CoreCtx, args: XxxArgs) -> CoreResult<XxxOut> { … }
```

- 事件类（2 条）不是 `pub fn`：由壳层订阅/推送，内核只提供序列化好的 `payload` 类型。
- 返回 `()` 的通道（1.x 返回 undefined）用 `CoreResult<()>`，壳层输出 `null`。

## 8. 完成标准

1. `cargo test -p hqsf-core` 全绿（新增测试数写进报告）；2. `cargo clippy … -D warnings` 零警告；3. 只改了自己 scope 的文件（`git status --short` 自查）；4. 报告：实现清单、新增根类型、与 1.x 的偏差/决定、未完成项。
## 9. 共享层速查（2026-11-21 追加，实现 lane 前必读）

以下设施**已经存在并有测试**，lane 直接复用，不要自建同类私有 helper（重复实现会被验收拒）。

### 9.1 `CoreCtx`（`ctx.rs`）

```rust
pub struct CoreCtx {
    pub files: Arc<dyn FileStore>,     // 全部文件 IO
    pub secrets: Arc<dyn SecretStore>, // token 等凭据
    pub http: Arc<dyn HttpTransport>,  // 全部网络（经 api.rs）
    pub events: Arc<dyn EventSink>,    // 向渲染层推事件
    pub clock: Arc<dyn Clock>,         // 一切时间
    pub paths: AppPaths,
    pub db: Arc<Db>,                   // 本地索引库（articles / read_cache / meta）
    pub platform: Platform,            // clipboard / dialog / launcher / window
}
```

### 9.2 `AppPaths`

`data_dir`（`hqsf.db`、`settings.json`）、`resource_dir`（`api.config.json`、`agreement.md`、`changelog.md`）、`documents_dir`（用户文档目录，默认草稿根 = `documents_dir/荒启科幻/草稿`）、`test_mode`（测试模式下数据目录与草稿根加 `-test`）。**都由壳层注入**，内核不读 `std::env`、不问 OS。

### 9.3 `services::net`（所有 HTTP 的唯一入口）

| 函数 | 用途 |
| --- | --- |
| `api_config(ctx)` | 读 `resource_dir/api.config.json`（其次 `data_dir`）并校验 |
| `request::<T>(ctx, "userInfo", &ApiOptions)` | 具名接口，校验 `code==1`，解包 `data` |
| `request_raw::<T>(…)` | 1.x 的 `raw: true` |
| `authed::<T>(ctx, "userStatus", &opts, "未登录，无法…")` | 自动把 token 加进 **query**（1.x 约定） |
| `token(ctx)` / `require_token(ctx, 文案)` | 未登录文案由调用方给（1.x 每个 handler 文案不同） |
| `download_image(ctx, url)` / `upload(ctx, token, filename, bytes)` | 图片下载 / `uploadFile` 上传 |

接口名常量：`infra::net::config::endpoints::*`。

### 9.4 会话契约

`SecretStore` 键 = `services::net::SESSION_SECRET_KEY`（`"hqsf.session"`），值是 JSON 对象，**至少含 `"token"` 字段**（其余字段归 `infra::session` 自定）。其它 lane 的认证命令都依赖这条，改键名等于让全部认证命令失效。

### 9.5 端口（`ports.rs`）

- `Launcher`：`open_external(url)` / `reveal_in_folder(path)` / `open_path(path)`（打开目录）/ `trash(path)`（回收站，**可恢复**，不得退化成 `remove_file`）。
- `WindowOps`：`minimize` / `toggle_maximize` / `close` / `is_maximized` / `toggle_devtools` / `set_zoom(f64)` / `insert_css(&str) -> key` / `remove_css(key)` / `execute_js(&str)`。
- 平台端口只由壳层实现；内核与 Android 端共用同一套 trait。

### 9.6 测试设施（`testkit`）

```rust
let h = Harness::new().with_api_config().with_token("tok");
h.http.enqueue(200, r#"{"code":1,"msg":"","data":{}}"#); // 或 h.http.push(...) builder（仅构造期）
let out = xxx(h.ctx(), args).unwrap();
assert_eq!(h.last_request().method, "POST");
assert_eq!(h.launcher.trashed.len(), 1);
```

`Harness` 字段：`ctx/files/secrets/http/events/clipboard/dialog/launcher/window`。各测试用独立内存库（`testkit::db()`），互不干扰。`testkit::api_config_json()` 是含全部 39 个必需接口的合法配置。

## 10. 事故记录与防回流（2026-11-21 14:06，必读）

**事故**：`lane-l8-migrate` 在仓库根用 `cargo new`/写文件的方式做实验，把根 `Cargo.toml` 覆盖成 `[package] name = "l8check"` 的独立 crate，并误建根 `src/lib.rs`、`src/error.rs`、`target/l8check/`。根清单当时是 untracked（无 git 备份），导致**所有 lane** 的 `cargo test -p hqsf-core` 立刻报 `package ID specification hqsf-core did not match any packages`，并行流水线停摆 ~2 分钟，靠 lead 手工重建（成员/排除/package 字段/8 个 workspace 依赖版本全部按 `.cargo-home/registry/cache` 实测版本反查）才恢复。

**为什么危险**：根 `Cargo.toml`、`Cargo.lock`、根 `src/` 是所有 lane 的公共前缀；任何人覆盖它，等于同时打断 8 个并发写手，且 untracked 文件没有 git 回滚。

**硬规则（违反即回退）**：
1. 只有 lead 可以创建/修改根 `Cargo.toml`、`Cargo.lock`、`crates/*/Cargo.toml`、根 `src/`（TS 渲染层）。
2. 任何 Rust 实验/一次性验证：放 `spikes/<name>/rs/`，**必须自带空 `[workspace]` 表**（根 workspace 已 exclude `spikes`，但子包不带空表会被父 workspace 反向捕获），并且**只在 `spikes/...` 目录内**跑 `cargo`（用 `--manifest-path` 或 `cd`），不要在仓库根跑。
3. 所有 lane 跑测试的命令固定为（仓库根执行）：
   ```bash
   export CARGO_HOME=$PWD/.cargo-home
   cargo test -q -p hqsf-core --lib
   ```
4. 写文件前先 `git status --short` 确认自己只动了约定范围内的文件；发现别人的未预期改动，**只报告不修改**。
