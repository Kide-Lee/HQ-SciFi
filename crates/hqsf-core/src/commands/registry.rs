//! IPC 通道注册表：**每条的通道名、命令名、模块、lane 都是从 P1 契约冻结产物抄来的单一来源**。
//!
//! 冻结产物：`doc/design/Tauri命令契约.md` + `src-tauri/testdata/contracts/commands.json`
//! （85 条 invoke + 2 条事件；三源交叉核对：`IPC_CHANNEL_BY_METHOD`、`preload`、18 个 handler 文件）。
//!
//! 这里的测试保证两件事：
//! 1. 注册表与冻结快照逐条一致（通道 → 命令名 / 模块 / lane），防止实现漂移；
//! 2. 命名、唯一性、lane 取值等结构性约束。
//!
//! 新增通道的正确顺序：先改契约文档与 JSON 快照（人工评审），再加 [`CommandSpec`]、再写命令。

use serde::{Deserialize, Serialize};
use specta::Type;

/// 一条 invoke 通道。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandSpec {
    /// 渲染层侧通道名，如 `hqsf:sync-pull`
    pub channel: &'static str,
    /// Tauri 命令名（`#[tauri::command] fn` 的标识符），如 `sync_pull`
    pub rust_command: &'static str,
    /// 归属模块（= `commands/<module>.rs`）
    pub module: &'static str,
    /// 迁移 lane（L1–L7c，见计划 §4.2）
    pub lane: &'static str,
    /// 入参名（顺序与 TS 侧一致；具体类型在命令函数签名上）
    pub params: &'static [&'static str],
    /// 返回值在契约文档里的 TS 写法（仅作文档与测试断言，不参与生成 TS）
    pub returns: &'static str,
}

/// 一条事件通道（后端 → 渲染层推送）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct EventSpec {
    /// 事件名，如 `hqsf:window-maximized-changed`
    pub event: &'static str,
    /// 载荷的契约写法
    pub payload: &'static str,
    pub module: &'static str,
    pub lane: &'static str,
}

/// 契约冻结时的 invoke 通道总数（85）。**改这个数字必须同时改契约文档与快照。**
pub const EXPECTED_INVOKE_TOTAL: usize = 85;

/// 全部 invoke 通道，按通道名字典序（与冻结快照同序，便于 diff）。
pub const COMMANDS: &[CommandSpec] = &[
    CommandSpec {
        channel: "hqsf:add-comment",
        rust_command: "add_comment",
        module: "comment",
        lane: "L7a",
        params: &["payload"],
        returns: "CommentSubmitResult",
    },
    CommandSpec {
        channel: "hqsf:add-log",
        rust_command: "add_log",
        module: "interact",
        lane: "L7b",
        params: &["type", "params"],
        returns: "LogOpResult",
    },
    CommandSpec {
        channel: "hqsf:check-forbidden",
        rust_command: "check_forbidden",
        module: "browse",
        lane: "L7b",
        params: &["title", "text"],
        returns: "{ code: number; msg: string }",
    },
    CommandSpec {
        channel: "hqsf:choose-docs-dir",
        rust_command: "choose_docs_dir",
        module: "docs",
        lane: "L2",
        params: &[],
        returns: "string | null",
    },
    CommandSpec {
        channel: "hqsf:clear-cache",
        rust_command: "clear_cache",
        module: "settings",
        lane: "L1",
        params: &[],
        returns: "ClearCacheResult",
    },
    CommandSpec {
        channel: "hqsf:convert-to-draft",
        rust_command: "convert_to_draft",
        module: "sync",
        lane: "L7c",
        params: &["cid"],
        returns: "ConvertDraftResult",
    },
    CommandSpec {
        channel: "hqsf:copy-text",
        rust_command: "copy_text",
        module: "system",
        lane: "L1",
        params: &["text"],
        returns: "null",
    },
    CommandSpec {
        channel: "hqsf:create-local-dir",
        rust_command: "create_local_dir",
        module: "docs",
        lane: "L2",
        params: &["rel"],
        returns: "string",
    },
    CommandSpec {
        channel: "hqsf:create-local-draft",
        rust_command: "create_local_draft",
        module: "docs",
        lane: "L2",
        params: &["title", "content", "dirRel"],
        returns: "string",
    },
    CommandSpec {
        channel: "hqsf:delete-local-file",
        rust_command: "delete_local_file",
        module: "docs",
        lane: "L2",
        params: &["path"],
        returns: "null",
    },
    CommandSpec {
        channel: "hqsf:edit-remote-article",
        rust_command: "edit_remote_article",
        module: "sync",
        lane: "L7c",
        params: &["cid"],
        returns: "EditRemoteResult",
    },
    CommandSpec {
        channel: "hqsf:file-exists",
        rust_command: "file_exists",
        module: "docs",
        lane: "L2",
        params: &["path"],
        returns: "boolean",
    },
    CommandSpec {
        channel: "hqsf:get-agreement",
        rust_command: "get_agreement",
        module: "agreement",
        lane: "L7c",
        params: &[],
        returns: "AgreementData",
    },
    CommandSpec {
        channel: "hqsf:get-app-info",
        rust_command: "get_app_info",
        module: "system",
        lane: "L1",
        params: &[],
        returns: "AppInfo",
    },
    CommandSpec {
        channel: "hqsf:get-changelog",
        rust_command: "get_changelog",
        module: "settings",
        lane: "L1",
        params: &[],
        returns: "ChangelogData",
    },
    CommandSpec {
        channel: "hqsf:get-docs-root",
        rust_command: "get_docs_root",
        module: "docs",
        lane: "L2",
        params: &[],
        returns: "string",
    },
    CommandSpec {
        channel: "hqsf:get-private-chat",
        rust_command: "get_private_chat",
        module: "chat",
        lane: "L7b",
        params: &["touid"],
        returns: "{ chatid: string }",
    },
    CommandSpec {
        channel: "hqsf:get-remote-article",
        rust_command: "get_remote_article",
        module: "read",
        lane: "L7a",
        params: &["cid"],
        returns: "ArticleDetail",
    },
    CommandSpec {
        channel: "hqsf:get-session",
        rust_command: "get_session",
        module: "auth",
        lane: "L4",
        params: &[],
        returns: "UserSession | null",
    },
    CommandSpec {
        channel: "hqsf:get-settings",
        rust_command: "get_settings",
        module: "settings",
        lane: "L1",
        params: &[],
        returns: "AppSettings",
    },
    CommandSpec {
        channel: "hqsf:get-unread-count",
        rust_command: "get_unread_count",
        module: "notify",
        lane: "L7b",
        params: &[],
        returns: "{ total: number }",
    },
    CommandSpec {
        channel: "hqsf:is-mark",
        rust_command: "is_mark",
        module: "interact",
        lane: "L7b",
        params: &["cid"],
        returns: "MarkStatus",
    },
    CommandSpec {
        channel: "hqsf:list-articles",
        rust_command: "list_articles",
        module: "docs",
        lane: "L2",
        params: &[],
        returns: "ArticleRow[]",
    },
    CommandSpec {
        channel: "hqsf:list-categories",
        rust_command: "list_categories",
        module: "browse",
        lane: "L7b",
        params: &[],
        returns: "Array<{ mid: number | string; name: string; slug: string; description?: string; imgurl?: string; count?: number }>",
    },
    CommandSpec {
        channel: "hqsf:list-chat-messages",
        rust_command: "list_chat_messages",
        module: "chat",
        lane: "L7b",
        params: &["chatid"],
        returns: "{ items: ChatMessage[] }",
    },
    CommandSpec {
        channel: "hqsf:list-chat-sessions",
        rust_command: "list_chat_sessions",
        module: "chat",
        lane: "L7b",
        params: &[],
        returns: "{ items: ChatSession[] }",
    },
    CommandSpec {
        channel: "hqsf:list-comments",
        rust_command: "list_comments",
        module: "comment",
        lane: "L7a",
        params: &["cid", "opts"],
        returns: "CommentListResult",
    },
    CommandSpec {
        channel: "hqsf:list-gpt-models",
        rust_command: "list_gpt_models",
        module: "browse",
        lane: "L7b",
        params: &[],
        returns: "GptModel[]",
    },
    CommandSpec {
        channel: "hqsf:list-local-docs",
        rust_command: "list_local_docs",
        module: "docs",
        lane: "L2",
        params: &[],
        returns: "LocalNode[]",
    },
    CommandSpec {
        channel: "hqsf:list-metas",
        rust_command: "list_metas",
        module: "browse",
        lane: "L7b",
        params: &["type"],
        returns: "MetaInfo[]",
    },
    CommandSpec {
        channel: "hqsf:list-my-reviews",
        rust_command: "list_my_reviews",
        module: "review",
        lane: "L7a",
        params: &[],
        returns: "{ cids: string[] }",
    },
    CommandSpec {
        channel: "hqsf:list-notifications",
        rust_command: "list_notifications",
        module: "notify",
        lane: "L7b",
        params: &[],
        returns: "{ items: AppNotification[]; totalUnread: number }",
    },
    CommandSpec {
        channel: "hqsf:list-recent-comments",
        rust_command: "list_recent_comments",
        module: "comment",
        lane: "L7a",
        params: &["opts"],
        returns: "{ items: CommentItem[]; total: number }",
    },
    CommandSpec {
        channel: "hqsf:list-remote-articles",
        rust_command: "list_remote_articles",
        module: "read",
        lane: "L7a",
        params: &["opts"],
        returns: "{ items: RemoteArticle[]; total: number }",
    },
    CommandSpec {
        channel: "hqsf:list-review-tasks",
        rust_command: "list_review_tasks",
        module: "review",
        lane: "L7a",
        params: &[],
        returns: "ReviewTaskItem[]",
    },
    CommandSpec {
        channel: "hqsf:list-reviews",
        rust_command: "list_reviews",
        module: "review",
        lane: "L7a",
        params: &["opts"],
        returns: "{ items: ReviewItem[]; total: number }",
    },
    CommandSpec {
        channel: "hqsf:login-password",
        rust_command: "login_password",
        module: "auth",
        lane: "L4",
        params: &["name", "password"],
        returns: "LoginResult",
    },
    CommandSpec {
        channel: "hqsf:logout",
        rust_command: "logout",
        module: "auth",
        lane: "L4",
        params: &[],
        returns: "null",
    },
    CommandSpec {
        channel: "hqsf:mark-notifications-read",
        rust_command: "mark_notifications_read",
        module: "notify",
        lane: "L7b",
        params: &["categories"],
        returns: "null",
    },
    CommandSpec {
        channel: "hqsf:open-docs-dir",
        rust_command: "open_docs_dir",
        module: "docs",
        lane: "L2",
        params: &[],
        returns: "null",
    },
    CommandSpec {
        channel: "hqsf:pick-upload-user-image",
        rust_command: "pick_upload_user_image",
        module: "user",
        lane: "L7b",
        params: &[],
        returns: "{ url: string } | null",
    },
    CommandSpec {
        channel: "hqsf:ping",
        rust_command: "ping",
        module: "system",
        lane: "L1",
        params: &[],
        returns: "string",
    },
    CommandSpec {
        channel: "hqsf:read-clipboard-html",
        rust_command: "read_clipboard_html",
        module: "system",
        lane: "L1",
        params: &[],
        returns: "string",
    },
    CommandSpec {
        channel: "hqsf:read-clipboard-text",
        rust_command: "read_clipboard_text",
        module: "system",
        lane: "L1",
        params: &[],
        returns: "string",
    },
    CommandSpec {
        channel: "hqsf:read-local-file",
        rust_command: "read_local_file",
        module: "docs",
        lane: "L2",
        params: &["path"],
        returns: "string",
    },
    CommandSpec {
        channel: "hqsf:remove-log",
        rust_command: "remove_log",
        module: "interact",
        lane: "L7b",
        params: &["key"],
        returns: "LogOpResult",
    },
    CommandSpec {
        channel: "hqsf:rename-local-node",
        rust_command: "rename_local_node",
        module: "docs",
        lane: "L2",
        params: &["oldRel", "newRel"],
        returns: "{ from: string; to: string }",
    },
    CommandSpec {
        channel: "hqsf:reveal-in-folder",
        rust_command: "reveal_in_folder",
        module: "docs",
        lane: "L2",
        params: &["path"],
        returns: "null",
    },
    CommandSpec {
        channel: "hqsf:search-comments",
        rust_command: "search_comments",
        module: "search",
        lane: "L7a",
        params: &["keyword", "limit"],
        returns: "{ items: CommentItem[]; total: number }",
    },
    CommandSpec {
        channel: "hqsf:search-reviews",
        rust_command: "search_reviews",
        module: "search",
        lane: "L7a",
        params: &["keyword", "limit"],
        returns: "{ items: ReviewItem[]; total: number }",
    },
    CommandSpec {
        channel: "hqsf:search-users",
        rust_command: "search_users",
        module: "search",
        lane: "L7a",
        params: &["keyword", "limit"],
        returns: "{ items: UserSearchResult[]; total: number }",
    },
    CommandSpec {
        channel: "hqsf:send-chat-message",
        rust_command: "send_chat_message",
        module: "chat",
        lane: "L7b",
        params: &["chatid", "msg"],
        returns: "null",
    },
    CommandSpec {
        channel: "hqsf:set-review-attitude",
        rust_command: "set_review_attitude",
        module: "review",
        lane: "L7a",
        params: &["reviewId", "type"],
        returns: "ReviewSubmitResult",
    },
    CommandSpec {
        channel: "hqsf:show-message-box",
        rust_command: "show_message_box",
        module: "system",
        lane: "L1",
        params: &["options"],
        returns: "{ response: number }",
    },
    CommandSpec {
        channel: "hqsf:submit-review",
        rust_command: "submit_review",
        module: "review",
        lane: "L7a",
        params: &["payload"],
        returns: "ReviewSubmitResult",
    },
    CommandSpec {
        channel: "hqsf:sync-pull",
        rust_command: "sync_pull",
        module: "sync",
        lane: "L7c",
        params: &[],
        returns: "PullResult",
    },
    CommandSpec {
        channel: "hqsf:sync-push",
        rust_command: "sync_push",
        module: "sync",
        lane: "L7c",
        params: &["filePath", "isDraft", "meta"],
        returns: "PushResult",
    },
    CommandSpec {
        channel: "hqsf:toggle-devtools",
        rust_command: "toggle_devtools",
        module: "window",
        lane: "L1",
        params: &[],
        returns: "null",
    },
    CommandSpec {
        channel: "hqsf:uninstall",
        rust_command: "uninstall",
        module: "settings",
        lane: "L1",
        params: &[],
        returns: "null",
    },
    CommandSpec {
        channel: "hqsf:update-check",
        rust_command: "update_check",
        module: "updater",
        lane: "L4",
        params: &[],
        returns: "UpdateState",
    },
    CommandSpec {
        channel: "hqsf:update-download",
        rust_command: "update_download",
        module: "updater",
        lane: "L4",
        params: &[],
        returns: "null",
    },
    CommandSpec {
        channel: "hqsf:update-install",
        rust_command: "update_install",
        module: "updater",
        lane: "L4",
        params: &[],
        returns: "null",
    },
    CommandSpec {
        channel: "hqsf:update-settings",
        rust_command: "update_settings",
        module: "settings",
        lane: "L1",
        params: &["patch"],
        returns: "AppSettings",
    },
    CommandSpec {
        channel: "hqsf:update-state",
        rust_command: "update_state",
        module: "updater",
        lane: "L4",
        params: &[],
        returns: "UpdateState",
    },
    CommandSpec {
        channel: "hqsf:user-articles",
        rust_command: "user_articles",
        module: "user",
        lane: "L7b",
        params: &["uid", "page", "limit"],
        returns: "{ items: RemoteArticle[]; total: number }",
    },
    CommandSpec {
        channel: "hqsf:user-clock",
        rust_command: "user_clock",
        module: "user",
        lane: "L7b",
        params: &[],
        returns: "ClockResult",
    },
    CommandSpec {
        channel: "hqsf:user-comments",
        rust_command: "user_comments",
        module: "user",
        lane: "L7b",
        params: &["uid", "page", "limit"],
        returns: "CommentListResult",
    },
    CommandSpec {
        channel: "hqsf:user-fan-list",
        rust_command: "user_fan_list",
        module: "user",
        lane: "L7b",
        params: &["uid", "page", "limit"],
        returns: "{ items: UserFollowItem[]; total: number }",
    },
    CommandSpec {
        channel: "hqsf:user-feed",
        rust_command: "user_feed",
        module: "user",
        lane: "L7b",
        params: &[],
        returns: "FollowFeedItem[]",
    },
    CommandSpec {
        channel: "hqsf:user-follow",
        rust_command: "user_follow",
        module: "user",
        lane: "L7b",
        params: &["uid", "follow"],
        returns: "{ ok: boolean; error?: string }",
    },
    CommandSpec {
        channel: "hqsf:user-follow-list",
        rust_command: "user_follow_list",
        module: "user",
        lane: "L7b",
        params: &["uid", "page", "limit"],
        returns: "{ items: UserFollowItem[]; total: number }",
    },
    CommandSpec {
        channel: "hqsf:user-follow-state",
        rust_command: "user_follow_state",
        module: "user",
        lane: "L7b",
        params: &["uid"],
        returns: "boolean",
    },
    CommandSpec {
        channel: "hqsf:user-marks",
        rust_command: "user_marks",
        module: "user",
        lane: "L7b",
        params: &["page", "limit"],
        returns: "{ items: UserMarkItem[]; total: number }",
    },
    CommandSpec {
        channel: "hqsf:user-profile",
        rust_command: "user_profile",
        module: "user",
        lane: "L7b",
        params: &["uid"],
        returns: "UserProfile",
    },
    CommandSpec {
        channel: "hqsf:user-reviews",
        rust_command: "user_reviews",
        module: "user",
        lane: "L7b",
        params: &["uid", "page", "limit"],
        returns: "{ items: ReviewItem[]; total: number }",
    },
    CommandSpec {
        channel: "hqsf:user-self-status",
        rust_command: "user_self_status",
        module: "user",
        lane: "L7b",
        params: &[],
        returns: "SelfStatus | null",
    },
    CommandSpec {
        channel: "hqsf:user-stats",
        rust_command: "user_stats",
        module: "user",
        lane: "L7b",
        params: &["uid"],
        returns: "UserStats | null",
    },
    CommandSpec {
        channel: "hqsf:user-update-profile",
        rust_command: "user_update_profile",
        module: "user",
        lane: "L7b",
        params: &["payload"],
        returns: "null",
    },
    CommandSpec {
        channel: "hqsf:verify-session",
        rust_command: "verify_session",
        module: "auth",
        lane: "L4",
        params: &[],
        returns: "{ valid: boolean; reachable: boolean }",
    },
    CommandSpec {
        channel: "hqsf:window-close",
        rust_command: "window_close",
        module: "window",
        lane: "L1",
        params: &[],
        returns: "void",
    },
    CommandSpec {
        channel: "hqsf:window-is-maximized",
        rust_command: "window_is_maximized",
        module: "window",
        lane: "L1",
        params: &[],
        returns: "boolean",
    },
    CommandSpec {
        channel: "hqsf:window-maximize-toggle",
        rust_command: "window_maximize_toggle",
        module: "window",
        lane: "L1",
        params: &[],
        returns: "boolean",
    },
    CommandSpec {
        channel: "hqsf:window-minimize",
        rust_command: "window_minimize",
        module: "window",
        lane: "L1",
        params: &[],
        returns: "void",
    },
    CommandSpec {
        channel: "hqsf:write-local-file",
        rust_command: "write_local_file",
        module: "docs",
        lane: "L2",
        params: &["path", "content"],
        returns: "null",
    },
    CommandSpec {
        channel: "media:pick-upload-image",
        rust_command: "pick_upload_image",
        module: "media",
        lane: "L5",
        params: &[],
        returns: "{ url: string } | null",
    },
];

/// 全部事件通道。
pub const EVENTS: &[EventSpec] = &[
    EventSpec {
        event: "hqsf:window-maximized-changed",
        payload: "boolean",
        module: "window",
        lane: "L1",
    },
    EventSpec {
        event: "hqsf:update-state",
        payload: "UpdateState",
        module: "updater",
        lane: "L4",
    },
];

/// lane 白名单（计划 §4.2）。
pub const LANES: &[&str] = &["L1", "L2", "L3", "L4", "L5", "L6", "L7a", "L7b", "L7c"];

/// 按通道名查命令（壳层注册时用）。
pub fn command_by_channel(channel: &str) -> Option<&'static CommandSpec> {
    COMMANDS.iter().find(|c| c.channel == channel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};

    /// P1 冻结快照（唯一真相来源）。
    fn frozen_snapshot() -> serde_json::Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../src-tauri/testdata/contracts/commands.json"
        );
        let raw = std::fs::read_to_string(path)
            .expect("契约快照缺失：src-tauri/testdata/contracts/commands.json");
        serde_json::from_str(&raw).expect("契约快照不是合法 JSON")
    }

    #[test]
    fn channels_are_unique() {
        let mut seen = BTreeSet::new();
        for c in COMMANDS {
            assert!(seen.insert(c.channel), "重复通道：{}", c.channel);
        }
    }

    #[test]
    fn rust_commands_are_unique() {
        let mut seen = BTreeSet::new();
        for c in COMMANDS {
            assert!(
                seen.insert(c.rust_command),
                "重复命令名：{}",
                c.rust_command
            );
        }
    }

    #[test]
    fn rust_command_names_follow_the_naming_rule() {
        for c in COMMANDS {
            // A1：`media:pick-upload-image` 是 1.x 遗留的唯一非 `hqsf:` 前缀通道
            // （src/main/ipc/media.handlers.ts:7），命名规则对它不适用，保留其历史命令名。
            let Some(rest) = c.channel.strip_prefix("hqsf:") else {
                assert_eq!(c.channel, "media:pick-upload-image");
                continue;
            };
            let expected = rest.replace('-', "_");
            assert_eq!(
                c.rust_command, expected,
                "通道 {} 的命令名应按规则生成",
                c.channel
            );
        }
    }

    #[test]
    fn lanes_are_known() {
        for c in COMMANDS {
            assert!(
                LANES.contains(&c.lane),
                "未知 lane {}（通道 {}）",
                c.lane,
                c.channel
            );
        }
        for e in EVENTS {
            assert!(
                LANES.contains(&e.lane),
                "未知 lane {}（事件 {}）",
                e.lane,
                e.event
            );
        }
    }

    #[test]
    fn count_matches_the_frozen_total() {
        assert_eq!(
            COMMANDS.len(),
            EXPECTED_INVOKE_TOTAL,
            "注册表条数与契约冻结总数不一致：冻结 {} 条，实现 {} 条",
            EXPECTED_INVOKE_TOTAL,
            COMMANDS.len()
        );
    }

    #[test]
    fn registry_matches_the_frozen_snapshot_exactly() {
        let snap = frozen_snapshot();
        let frozen: BTreeMap<String, (String, String, String)> = snap["channels"]
            .as_array()
            .expect("channels 应为数组")
            .iter()
            .map(|c| {
                (
                    c["channel"].as_str().expect("channel").to_string(),
                    (
                        c["rustCommand"].as_str().expect("rustCommand").to_string(),
                        c["rustModule"].as_str().expect("rustModule").to_string(),
                        c["lane"].as_str().expect("lane").to_string(),
                    ),
                )
            })
            .collect();

        let implemented: BTreeMap<String, (String, String, String)> = COMMANDS
            .iter()
            .map(|c| {
                (
                    c.channel.to_string(),
                    (
                        c.rust_command.to_string(),
                        c.module.to_string(),
                        c.lane.to_string(),
                    ),
                )
            })
            .collect();

        let missing: Vec<_> = frozen
            .keys()
            .filter(|k| !implemented.contains_key(*k))
            .collect();
        let extra: Vec<_> = implemented
            .keys()
            .filter(|k| !frozen.contains_key(*k))
            .collect();
        assert!(missing.is_empty(), "注册表缺少通道：{missing:?}");
        assert!(extra.is_empty(), "注册表多出通道：{extra:?}");
        for (channel, expected) in &frozen {
            assert_eq!(
                &implemented[channel], expected,
                "通道 {channel} 的命令名/模块/lane 与冻结快照不符"
            );
        }
    }

    #[test]
    fn events_match_the_frozen_snapshot_exactly() {
        let snap = frozen_snapshot();
        let frozen: BTreeMap<String, (String, String)> = snap["events"]
            .as_array()
            .expect("events 应为数组")
            .iter()
            .map(|e| {
                (
                    e["event"].as_str().expect("event").to_string(),
                    (
                        e["rustModule"].as_str().expect("rustModule").to_string(),
                        e["lane"].as_str().expect("lane").to_string(),
                    ),
                )
            })
            .collect();
        let implemented: BTreeMap<String, (String, String)> = EVENTS
            .iter()
            .map(|e| {
                (
                    e.event.to_string(),
                    (e.module.to_string(), e.lane.to_string()),
                )
            })
            .collect();
        assert_eq!(frozen, implemented, "事件注册表与冻结快照不一致");
    }

    #[test]
    fn command_lookup_works() {
        assert_eq!(
            command_by_channel("hqsf:ping").unwrap().rust_command,
            "ping"
        );
        assert!(command_by_channel("hqsf:nope").is_none());
    }

    /// 每条登记的命令都必须真的存在同名 `pub fn`（否则壳层 dispatch 会指向不存在的函数）。
    ///
    /// 这是「85/85 对等」的源码级门禁：契约冻结只保证通道名与命令名一致，
    /// 这里再保证命令名与实现一致。lane 实现文件由各 lane 拥有，本测试只读。
    #[test]
    fn every_registered_command_has_an_implementation() {
        const SOURCES: &[(&str, &str)] = &[
            ("agreement", include_str!("agreement.rs")),
            ("auth", include_str!("auth.rs")),
            ("browse", include_str!("browse.rs")),
            ("chat", include_str!("chat.rs")),
            ("comment", include_str!("comment.rs")),
            ("docs", include_str!("docs.rs")),
            ("interact", include_str!("interact.rs")),
            ("media", include_str!("media.rs")),
            ("notify", include_str!("notify.rs")),
            ("read", include_str!("read.rs")),
            ("review", include_str!("review.rs")),
            ("search", include_str!("search.rs")),
            ("settings", include_str!("settings.rs")),
            ("sync", include_str!("sync.rs")),
            ("system", include_str!("system.rs")),
            ("updater", include_str!("updater.rs")),
            ("user", include_str!("user.rs")),
            ("window", include_str!("window.rs")),
        ];
        let mut missing = Vec::new();
        for spec in COMMANDS {
            let needle = format!("pub fn {}(", spec.rust_command);
            let found = SOURCES.iter().any(|(_, src)| src.contains(&needle));
            if !found {
                missing.push(format!(
                    "{} → {}（{}，lane {}）",
                    spec.channel, spec.rust_command, spec.module, spec.lane
                ));
            }
        }
        assert!(
            missing.is_empty(),
            "以下 {} 条命令在 commands/*.rs 里找不到同名 pub fn：\n{}",
            missing.len(),
            missing.join("\n")
        );
    }
}
