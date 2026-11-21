//! 文章索引的领域类型（原 `src/shared/domain/index.ts` 的 `ArticleType` / `ArticleRow`）。
//!
//! 这些类型同时是 SQLite 的行形状与 IPC 载荷形状——1.x 已经如此，保持同名同义可以
//! 让渲染层与迁移脚本都不需要改映射。

use serde::{Deserialize, Serialize};
use specta::Type;

/// 文章四态 + 本地未同步草稿。线上取值 `post_draft` / `waiting` / `post` / `reject` / `local`。
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Type,
)]
#[serde(rename_all = "snake_case")]
pub enum ArticleType {
    /// 远端草稿（已提交但未发布）
    PostDraft,
    /// 待审核（已发布等待评审）
    Waiting,
    /// 已发布
    Post,
    /// 已拒绝
    Reject,
    /// 本地未同步草稿（cid 为空）
    #[default]
    Local,
}

impl ArticleType {
    /// 线上/数据库里的字符串表示。
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PostDraft => "post_draft",
            Self::Waiting => "waiting",
            Self::Post => "post",
            Self::Reject => "reject",
            Self::Local => "local",
        }
    }

    /// 解析数据库/接口里的字符串；未知值返回 `None`（由调用方决定是报错还是兜底）。
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "post_draft" => Self::PostDraft,
            "waiting" => Self::Waiting,
            "post" => Self::Post,
            "reject" => Self::Reject,
            "local" => Self::Local,
            _ => return None,
        })
    }

    /// 是否属于「远端四态」（即已同步到服务端，cid 应非空）。
    pub const fn is_remote(self) -> bool {
        !matches!(self, Self::Local)
    }
}

impl std::fmt::Display for ArticleType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 本地索引的一行。字段与 1.x 完全一致（DB 列名用 snake_case，线上载荷用 camelCase）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArticleRow {
    /// 远端 cid；本地未同步草稿为 `""`（**注意不是 NULL**，与 1.x 一致）
    pub cid: String,
    pub title: String,
    /// 四态
    #[serde(rename = "type")]
    pub article_type: ArticleType,
    /// 远端 status 原始值（`publish` 等）
    pub status: String,
    pub author_id: String,
    /// 远端 modified 时间戳（秒）
    pub remote_modified: i64,
    /// 本地文件 mtime（毫秒）
    pub local_modified: i64,
    /// 上次同步时的本地内容哈希
    pub content_hash: String,
    /// 本地 md 文件绝对路径（无则空串）
    pub file_path: String,
    pub synced_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

impl ArticleRow {
    /// 新建一行的骨架：`cid`/`type` 必填，其余为空。
    pub fn new(cid: impl Into<String>, article_type: ArticleType, now_ms: i64) -> Self {
        Self {
            cid: cid.into(),
            article_type,
            created_at: now_ms,
            updated_at: now_ms,
            ..Default::default()
        }
    }

    /// 本地未同步草稿（cid 为空）。
    pub fn local_draft(file_path: impl Into<String>, now_ms: i64) -> Self {
        let mut row = Self::new("", ArticleType::Local, now_ms);
        row.file_path = file_path.into();
        row
    }

    /// 是否已关联远端文章。
    pub fn is_linked(&self) -> bool {
        !self.cid.is_empty()
    }
}
