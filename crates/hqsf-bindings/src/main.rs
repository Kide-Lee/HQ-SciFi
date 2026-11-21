//! 无头绑定生成器。
//!
//! 产出三样东西（全部提交入库，CI 用 `--check` 校验漂移）：
//! 1. `src/shared/generated/types.ts`       —— specta 从 Rust 类型导出的 TS 类型
//! 2. `src/shared/generated/commands.ts`    —— 通道 → Tauri 命令名的映射（门面用）
//! 3. `src-tauri/testdata/contracts/commands.generated.json` —— 机器可读清单（契约测试用）
//!
//! 为什么不用 tauri-specta：它的导出入口是 `tauri_specta::Builder`，编译需要
//! WebKitGTK/GTK 的系统库；本仓 CI 的「Rust 单测」job 与开发沙箱都没有这些库。
//! 只依赖 specta 的本生成器可以在任何环境跑，同时保留「Rust 定义 → TS 生成」的单一来源。
//!
//! `#[serde(rename_all = "camelCase")]` 会被 `derive(Type)` 直接读取，因此不需要额外的
//! format 变换；下面的 [`Passthrough`] 只是满足 `Format` 参数。

use std::path::{Path, PathBuf};

use hqsf_core::commands::registry::COMMANDS;
use specta::Types;
use specta_typescript::Typescript;

const TYPES_TS: &str = "src/shared/generated/types.ts";
const COMMANDS_TS: &str = "src/shared/generated/commands.ts";
const MANIFEST_JSON: &str = "src-tauri/testdata/contracts/commands.generated.json";

/// 注册的根类型个数（仅用于日志）。
const ROOT_TYPE_COUNT: usize = 98;

fn repo_root() -> PathBuf {
    // crates/hqsf-bindings → crates → 仓库根
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop();
    p.pop();
    p
}

/// 注册所有需要导出的类型。新增 wire 类型时**只改这里**。
fn type_collection() -> Types {
    Types::default()
        .register::<hqsf_core::commands::comment::AddCommentArgs>()
        .register::<hqsf_core::commands::interact::AddLogArgs>()
        .register::<hqsf_core::adapters::agreement::AgreementData>()
        .register::<hqsf_core::commands::system::AppInfo>()
        .register::<hqsf_core::adapters::notify::AppNotification>()
        .register::<hqsf_core::infra::settings::AppSettings>()
        .register::<hqsf_core::adapters::read::ArticleDetail>()
        .register::<hqsf_core::adapters::read::ArticleListOptions>()
        .register::<hqsf_core::adapters::read::ArticleListOut>()
        .register::<hqsf_core::adapters::read::ArticleMeta>()
        .register::<hqsf_core::domain::article::ArticleRow>()
        .register::<hqsf_core::commands::browse::BrowseMetasArgs>()
        .register::<hqsf_core::adapters::read::CategoryMeta>()
        .register::<hqsf_core::services::settings::ChangelogData>()
        .register::<hqsf_core::commands::chat::ChatIdArgs>()
        .register::<hqsf_core::adapters::chat::ChatMessage>()
        .register::<hqsf_core::adapters::chat::ChatMessageList>()
        .register::<hqsf_core::commands::chat::ChatSendArgs>()
        .register::<hqsf_core::adapters::chat::ChatSession>()
        .register::<hqsf_core::adapters::chat::ChatSessionList>()
        .register::<hqsf_core::commands::chat::ChatTouidArgs>()
        .register::<hqsf_core::commands::browse::CheckForbiddenArgs>()
        .register::<hqsf_core::services::settings::ClearCacheResult>()
        .register::<hqsf_core::adapters::user::ClockResult>()
        .register::<hqsf_core::adapters::comment::CommentItem>()
        .register::<hqsf_core::adapters::comment::CommentListOptions>()
        .register::<hqsf_core::adapters::comment::CommentListOut>()
        .register::<hqsf_core::adapters::comment::CommentListResult>()
        .register::<hqsf_core::adapters::comment::CommentSubmitResult>()
        .register::<hqsf_core::domain::sync::ConvertDraftResult>()
        .register::<hqsf_core::domain::sync::EditRemoteResult>()
        .register::<hqsf_core::adapters::user::FollowFeedItem>()
        .register::<hqsf_core::adapters::user::FollowFeedKind>()
        .register::<hqsf_core::adapters::user::FollowOpResult>()
        .register::<hqsf_core::adapters::browse::ForbiddenCheck>()
        .register::<hqsf_core::commands::read::GetRemoteArticleArgs>()
        .register::<hqsf_core::adapters::browse::GptModel>()
        .register::<hqsf_core::commands::system::HostInfo>()
        .register::<hqsf_core::adapters::notify::InboxCommentItem>()
        .register::<hqsf_core::adapters::notify::InboxReviewItem>()
        .register::<hqsf_core::commands::interact::IsMarkArgs>()
        .register::<hqsf_core::adapters::read::Json>()
        .register::<hqsf_core::domain::user::JsonScalar>()
        .register::<hqsf_core::commands::comment::ListCommentsArgs>()
        .register::<hqsf_core::commands::comment::ListRecentCommentsArgs>()
        .register::<hqsf_core::commands::read::ListRemoteArticlesArgs>()
        .register::<hqsf_core::commands::review::ListReviewsArgs>()
        .register::<hqsf_core::services::docs::LocalNode>()
        .register::<hqsf_core::adapters::interact::LogOpResult>()
        .register::<hqsf_core::commands::auth::LoginPasswordArgs>()
        .register::<hqsf_core::services::auth::LoginResult>()
        .register::<hqsf_core::commands::notify::MarkNotificationsReadArgs>()
        .register::<hqsf_core::adapters::interact::MarkStatus>()
        .register::<hqsf_core::adapters::read::MetaInfo>()
        .register::<hqsf_core::adapters::read::MetaRef>()
        .register::<hqsf_core::adapters::review::MyReviews>()
        .register::<hqsf_core::adapters::notify::NotificationList>()
        .register::<hqsf_core::commands::user::PageArgs>()
        .register::<hqsf_core::adapters::comment::ParentCommentSummary>()
        .register::<hqsf_core::adapters::chat::PrivateChat>()
        .register::<hqsf_core::domain::sync::PullResult>()
        .register::<hqsf_core::domain::sync::PushResult>()
        .register::<hqsf_core::adapters::read::RemoteArticle>()
        .register::<hqsf_core::commands::interact::RemoveLogArgs>()
        .register::<hqsf_core::commands::docs::RenameLocalNodeOut>()
        .register::<hqsf_core::adapters::review::ReviewItem>()
        .register::<hqsf_core::adapters::review::ReviewListOptions>()
        .register::<hqsf_core::adapters::review::ReviewListOut>()
        .register::<hqsf_core::adapters::review::ReviewSubmitResult>()
        .register::<hqsf_core::adapters::review::ReviewTaskItem>()
        .register::<hqsf_core::commands::search::SearchArgs>()
        .register::<hqsf_core::adapters::user::SelfStatus>()
        .register::<hqsf_core::commands::review::SetReviewAttitudeArgs>()
        .register::<hqsf_core::commands::system::ShowMessageBoxOptions>()
        .register::<hqsf_core::commands::system::ShowMessageBoxResult>()
        .register::<hqsf_core::commands::system::ShowMessageBoxType>()
        .register::<hqsf_core::adapters::read::StrOrNum>()
        .register::<hqsf_core::commands::review::SubmitReviewArgs>()
        .register::<hqsf_core::commands::notify::UnreadCountOut>()
        .register::<hqsf_core::adapters::notify::UnreadCounts>()
        .register::<hqsf_core::infra::updater::UpdateState>()
        .register::<hqsf_core::adapters::user::UploadedImage>()
        .register::<hqsf_core::commands::user::UserFollowArgs>()
        .register::<hqsf_core::adapters::user::UserFollowItem>()
        .register::<hqsf_core::adapters::user::UserFollowList>()
        .register::<hqsf_core::commands::user::UserListArgs>()
        .register::<hqsf_core::adapters::user::UserMarkItem>()
        .register::<hqsf_core::adapters::user::UserMarkList>()
        .register::<hqsf_core::adapters::user::UserMarkRef>()
        .register::<hqsf_core::adapters::user::UserProfile>()
        .register::<hqsf_core::adapters::user::UserProfileUpdatePayload>()
        .register::<hqsf_core::adapters::search::UserSearchOut>()
        .register::<hqsf_core::adapters::search::UserSearchResult>()
        .register::<hqsf_core::services::auth::UserSession>()
        .register::<hqsf_core::adapters::user::UserStats>()
        .register::<hqsf_core::commands::user::UserUidArgs>()
        .register::<hqsf_core::commands::user::UserUpdateProfileArgs>()
        .register::<hqsf_core::services::auth::VerifySessionResult>()
}

fn render_types() -> Result<String, Box<dyn std::error::Error>> {
    // `specta_serde::Format` 负责把 `#[serde(rename_all = "camelCase")]` 等 serde 属性
    // 应用到导出的 TS 类型上（derive(Type) 只收集属性，不解释它们）。不加这一层，
    // TS 侧字段会是 snake_case，与线上 camelCase 载荷不符。
    //
    // `dangerous_bigints_as_number`：线上载荷全是 JS number（1.x 的 number），specta
    // 默认拒绝导出 i64/u64（怕超过 2^53 丢精度）。这里的 i64 只有毫秒时间戳（~1.7e12）
    // 与计数，远低于 `Number.MAX_SAFE_INTEGER`，因此按 number 导出是安全的；
    // 若将来引入 64 位 id，必须改回 bigint 或字符串。
    let collection = specta_util::Remapper::new()
        .dangerous_bigints_as_number()
        .remap_types(type_collection());
    let body = Typescript::default().export(&collection, specta_serde::Format)?;
    Ok(format!(
        "// 由 `cargo run -p hqsf-bindings` 生成，请勿手改。\n\
         // 来源：crates/hqsf-core 的 `#[derive(specta::Type)]` 类型。\n\
         // 漂移检查：`cargo run -p hqsf-bindings -- --check`\n\
         /* eslint-disable */\n\
         // prettier-ignore\n\
         {body}"
    ))
}

fn render_commands() -> (String, String) {
    let mut sorted: Vec<_> = COMMANDS.iter().collect();
    sorted.sort_by_key(|c| c.channel);

    let mut ts = String::from(
        "// 由 `cargo run -p hqsf-bindings` 生成，请勿手改。\n\
         // 来源：crates/hqsf-core/src/commands/registry.rs 的 COMMANDS。\n\
         // 漂移检查：`cargo run -p hqsf-bindings -- --check`\n\
         /* eslint-disable */\n\n\
         /** IPC 通道 → Tauri 命令名。`src/bridge` 的门面按这张表发 invoke。 */\n\
         export const COMMAND_BY_CHANNEL = {\n",
    );
    for c in &sorted {
        ts.push_str(&format!("  '{}': '{}',\n", c.channel, c.rust_command));
    }
    ts.push_str("} as const\n\n");
    ts.push_str(
        "export type IpcChannel = keyof typeof COMMAND_BY_CHANNEL\n\
         export type TauriCommand = (typeof COMMAND_BY_CHANNEL)[IpcChannel]\n\n",
    );
    ts.push_str("/** 每条命令的归属：lane 与契约文档的一致性由 `cargo test` 保证。 */\n");
    ts.push_str("export const COMMAND_META = {\n");
    for c in &sorted {
        ts.push_str(&format!(
            "  '{}': {{ module: '{}', lane: '{}' }},\n",
            c.channel, c.module, c.lane
        ));
    }
    ts.push_str("} as const\n");

    let manifest = serde_json::json!({
        "version": 1,
        "generatedBy": "cargo run -p hqsf-bindings",
        "count": sorted.len(),
        "commands": sorted.iter().map(|c| serde_json::json!({
            "channel": c.channel,
            "rustCommand": c.rust_command,
            "module": c.module,
            "lane": c.lane,
            "params": c.params,
            "returns": c.returns,
        })).collect::<Vec<_>>(),
    });
    let json = serde_json::to_string_pretty(&manifest).expect("manifest 序列化失败");
    (ts, json + "\n")
}

fn write_or_check(
    root: &Path,
    rel: &str,
    content: &str,
    check: bool,
    drift: &mut Vec<String>,
) -> std::io::Result<()> {
    let path = root.join(rel);
    if check {
        let actual = std::fs::read_to_string(&path).unwrap_or_default();
        if actual != content {
            drift.push(rel.to_string());
        }
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, content)?;
    println!("wrote {rel} ({} bytes)", content.len());
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let check = std::env::args().any(|a| a == "--check");
    let root = repo_root();
    let mut drift = Vec::new();

    let types = render_types()?;
    let (commands_ts, manifest) = render_commands();

    write_or_check(&root, TYPES_TS, &types, check, &mut drift)?;
    write_or_check(&root, COMMANDS_TS, &commands_ts, check, &mut drift)?;
    write_or_check(&root, MANIFEST_JSON, &manifest, check, &mut drift)?;

    if check {
        if drift.is_empty() {
            println!(
                "bindings 无漂移（{} 条命令，{} 个根类型）",
                COMMANDS.len(),
                ROOT_TYPE_COUNT
            );
            Ok(())
        } else {
            eprintln!("绑定漂移，请运行 `cargo run -p hqsf-bindings` 重新生成：");
            for f in drift {
                eprintln!("  - {f}");
            }
            std::process::exit(1)
        }
    } else {
        println!("完成。");
        Ok(())
    }
}
