//! SQLite 索引（原 `src/main/infra/db/index.ts`，249 行）。
//!
//! **表结构与列名与 1.x 完全一致**（`articles` / `read_cache` / `meta` 三张表，列名 snake_case），
//! 这样 1.x 用户的 `hqsf.db` 可以零迁移直读——迁移风险从「写迁移脚本」降为「打开旧文件」。
//! 详见 `doc/spike/data-migration.md`（SP-4）。
//!
//! 只存文章元数据/状态索引，**不存正文**：正文始终是磁盘上的 `.md` 文件。

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::domain::article::{ArticleRow, ArticleType};
use crate::error::{CoreError, CoreResult};

/// 数据库文件名（位于 `AppPaths::data_dir`）。
pub const DB_FILE_NAME: &str = "hqsf.db";

/// 阅读缓存有效期：超过该时长未使用即丢弃（24 小时）。
pub const READ_CACHE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
/// 命中刷新节流：距上次刷新超过该时长才落盘（避免每次读都写 SQLite）。
pub const READ_CACHE_TOUCH_INTERVAL_MS: i64 = 5 * 60 * 1000;
/// 文章缓存总容量上限（16MB）。
pub const READ_CACHE_MAX_BYTES: i64 = 16 * 1024 * 1024;
/// 清理时保留的目标水位（上限的 80%，避免频繁触发清理）。
pub const READ_CACHE_TARGET_BYTES: i64 = READ_CACHE_MAX_BYTES / 10 * 8;

/// 与 1.x 逐字一致的建表语句。
const SCHEMA: &str = "\
CREATE TABLE IF NOT EXISTS articles (
  cid TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'local',
  status TEXT NOT NULL DEFAULT '',
  author_id TEXT NOT NULL DEFAULT '',
  remote_modified INTEGER NOT NULL DEFAULT 0,
  local_modified INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL DEFAULT '',
  file_path TEXT NOT NULL DEFAULT '',
  synced_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_articles_type ON articles(type);
CREATE INDEX IF NOT EXISTS idx_articles_file_path ON articles(file_path);
CREATE TABLE IF NOT EXISTS read_cache (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
";

/// 数据库里出现了本版本不认识的 `articles.type` 取值。
#[derive(Debug)]
struct UnknownArticleType(String);

impl std::fmt::Display for UnknownArticleType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "未知文章状态：{}", self.0)
    }
}

impl std::error::Error for UnknownArticleType {}

/// 本地索引。`Connection` 不是 `Sync`，用 `Mutex` 包住即可跨线程共享（与 better-sqlite3 同步语义一致）。
pub struct Db {
    conn: Mutex<Connection>,
}

impl std::fmt::Debug for Db {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Db").finish_non_exhaustive()
    }
}

impl Db {
    /// 打开（或创建）`data_dir/hqsf.db`，建表并启用 WAL。可重复调用。
    pub fn open(path: &Path) -> CoreResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        // `:memory:` 下 WAL 不生效但不报错；失败也不应阻断启动。
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        Self::from_connection(conn)
    }

    /// 内存库（单元测试用）。
    pub fn open_in_memory() -> CoreResult<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> CoreResult<Self> {
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        // 只在另一个线程 panic 时中毒；索引数据本身仍然可用，取回到内部值继续。
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ---------- 文章索引 ----------

    /// 清空文章索引（登录切换账号时调用，防止上一账号的索引串到新账号的侧栏四态）。
    pub fn clear_articles(&self) -> CoreResult<()> {
        self.lock().execute("DELETE FROM articles", [])?;
        Ok(())
    }

    /// 插入或覆盖一行（对应 1.x `upsertArticle`；`ON CONFLICT(cid)` 更新全部业务列）。
    pub fn upsert_article(&self, a: &ArticleRow) -> CoreResult<()> {
        self.lock().execute(
            "INSERT INTO articles (cid, title, type, status, author_id, remote_modified, local_modified,
              content_hash, file_path, synced_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(cid) DO UPDATE SET
              title=excluded.title, type=excluded.type, status=excluded.status, author_id=excluded.author_id,
              remote_modified=excluded.remote_modified, local_modified=excluded.local_modified,
              content_hash=excluded.content_hash, file_path=excluded.file_path, synced_at=excluded.synced_at,
              updated_at=excluded.updated_at",
            params![
                a.cid,
                a.title,
                a.article_type.as_str(),
                a.status,
                a.author_id,
                a.remote_modified,
                a.local_modified,
                a.content_hash,
                a.file_path,
                a.synced_at,
                a.created_at,
                a.updated_at,
            ],
        )?;
        Ok(())
    }

    /// 按远端 cid 更新（本地未同步草稿 cid 为空，用 `update_article_by_file_path` 定位）。
    /// 返回 `false` 表示没有这一行（1.x 语义：静默忽略）。
    pub fn update_article_by_cid(
        &self,
        cid: &str,
        now_ms: i64,
        patch: impl FnOnce(&mut ArticleRow),
    ) -> CoreResult<bool> {
        let Some(mut row) = self.get_article_by_cid(cid)? else {
            return Ok(false);
        };
        patch(&mut row);
        row.updated_at = now_ms;
        self.upsert_article(&row)?;
        Ok(true)
    }

    /// 按本地文件路径定位（本地草稿或已关联远端文章）并更新。
    pub fn update_article_by_file_path(
        &self,
        file_path: &str,
        now_ms: i64,
        patch: impl FnOnce(&mut ArticleRow),
    ) -> CoreResult<bool> {
        let Some(mut row) = self.get_article_by_file_path(file_path)? else {
            return Ok(false);
        };
        patch(&mut row);
        row.updated_at = now_ms;
        self.upsert_article(&row)?;
        Ok(true)
    }

    /// 列出文章索引，按 `updated_at` 倒序；`type` 为 `None` 时返回全部。
    pub fn list_articles(&self, article_type: Option<ArticleType>) -> CoreResult<Vec<ArticleRow>> {
        let conn = self.lock();
        let mut stmt;
        let rows = match article_type {
            Some(t) => {
                stmt = conn
                    .prepare("SELECT * FROM articles WHERE type = ?1 ORDER BY updated_at DESC")?;
                let mapped = stmt.query_map(params![t.as_str()], article_from_row)?;
                mapped.collect::<rusqlite::Result<Vec<_>>>()?
            }
            None => {
                stmt = conn.prepare("SELECT * FROM articles ORDER BY updated_at DESC")?;
                let mapped = stmt.query_map([], article_from_row)?;
                mapped.collect::<rusqlite::Result<Vec<_>>>()?
            }
        };
        Ok(rows)
    }

    pub fn get_article_by_cid(&self, cid: &str) -> CoreResult<Option<ArticleRow>> {
        let conn = self.lock();
        let row = conn
            .query_row(
                "SELECT * FROM articles WHERE cid = ?1",
                params![cid],
                article_from_row,
            )
            .optional()?;
        Ok(row)
    }

    pub fn get_article_by_file_path(&self, file_path: &str) -> CoreResult<Option<ArticleRow>> {
        let conn = self.lock();
        let row = conn
            .query_row(
                "SELECT * FROM articles WHERE file_path = ?1",
                params![file_path],
                article_from_row,
            )
            .optional()?;
        Ok(row)
    }

    pub fn delete_article_by_cid(&self, cid: &str) -> CoreResult<()> {
        self.lock()
            .execute("DELETE FROM articles WHERE cid = ?1", params![cid])?;
        Ok(())
    }

    // ---------- 键值元数据 ----------

    pub fn set_meta(&self, key: &str, value: &str) -> CoreResult<()> {
        self.lock().execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_meta(&self, key: &str) -> CoreResult<Option<String>> {
        let conn = self.lock();
        let row = conn
            .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| {
                r.get::<_, String>(0)
            })
            .optional()?;
        Ok(row)
    }

    // ---------- 阅读缓存（M2） ----------
    // 缓存 1 天未使用即丢弃：fetched_at 兼作「最后使用时间」，读取命中即刷新；
    // 另设容量上限，超限时按最后使用时间从旧到新删最旧。语义与 1.x 逐条对齐。

    /// 读取缓存；过期（1 天未使用）则删除并返回 `None`；命中且超过节流窗口则刷新最后使用时间。
    pub fn get_read_cache<T: DeserializeOwned>(
        &self,
        key: &str,
        now_ms: i64,
    ) -> CoreResult<Option<T>> {
        let row: Option<(String, i64)> = {
            let conn = self.lock();
            conn.query_row(
                "SELECT payload, fetched_at FROM read_cache WHERE key = ?1",
                params![key],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()?
        };
        let Some((payload, fetched_at)) = row else {
            return Ok(None);
        };
        if now_ms - fetched_at > READ_CACHE_TTL_MS {
            self.delete_read_cache(key)?;
            return Ok(None);
        }
        // 命中即视为使用；节流刷新最后使用时间（读路径不频繁写盘，TTL 判定最多偏差 5 分钟）。
        if now_ms - fetched_at > READ_CACHE_TOUCH_INTERVAL_MS {
            self.lock().execute(
                "UPDATE read_cache SET fetched_at = ?1 WHERE key = ?2",
                params![now_ms, key],
            )?;
        }
        match serde_json::from_str::<T>(&payload) {
            Ok(value) => Ok(Some(value)),
            Err(_) => {
                // 损坏条目直接丢弃（1.x 同义：try/catch 后 delete）。
                self.delete_read_cache(key)?;
                Ok(None)
            }
        }
    }

    /// 删除单条阅读缓存（检测到文章隐藏/未公开时立刻调用）。
    pub fn delete_read_cache(&self, key: &str) -> CoreResult<()> {
        self.lock()
            .execute("DELETE FROM read_cache WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// 写入阅读缓存；顺带清除全部过期条目；超容量上限时按最后使用时间从旧到新删除。
    pub fn set_read_cache<T: Serialize>(
        &self,
        key: &str,
        payload: &T,
        now_ms: i64,
    ) -> CoreResult<()> {
        let json = serde_json::to_string(payload)?;
        {
            let conn = self.lock();
            conn.execute(
                "INSERT INTO read_cache (key, payload, fetched_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at",
                params![key, json, now_ms],
            )?;
            conn.execute(
                "DELETE FROM read_cache WHERE fetched_at < ?1",
                params![now_ms - READ_CACHE_TTL_MS],
            )?;
        }
        self.trim_read_cache()?;
        Ok(())
    }

    /// 总字节超限时按最后使用时间删除最旧条目（逐条删，避免一次删太多）。
    fn trim_read_cache(&self) -> CoreResult<()> {
        loop {
            let conn = self.lock();
            let total: i64 = conn.query_row(
                "SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM read_cache",
                [],
                |r| r.get(0),
            )?;
            if total <= READ_CACHE_TARGET_BYTES {
                return Ok(());
            }
            let oldest: Option<String> = conn
                .query_row(
                    "SELECT key FROM read_cache ORDER BY fetched_at ASC LIMIT 1",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .optional()?;
            let Some(key) = oldest else {
                return Ok(());
            };
            conn.execute("DELETE FROM read_cache WHERE key = ?1", params![key])?;
        }
    }

    /// 清除全部阅读缓存（设置「清除缓存」用，不影响文章索引/设置/会话）。
    pub fn clear_read_cache(&self) -> CoreResult<()> {
        self.lock().execute("DELETE FROM read_cache", [])?;
        Ok(())
    }

    /// 阅读缓存当前条目数（设置页展示与测试用）。
    pub fn read_cache_len(&self) -> CoreResult<i64> {
        Ok(self
            .lock()
            .query_row("SELECT COUNT(*) FROM read_cache", [], |r| r.get(0))?)
    }
}

fn article_from_row(r: &Row<'_>) -> rusqlite::Result<ArticleRow> {
    let raw_type: String = r.get("type")?;
    let article_type = ArticleType::parse(&raw_type).ok_or_else(|| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(UnknownArticleType(raw_type.clone())))
    })?;
    Ok(ArticleRow {
        cid: r.get("cid")?,
        title: r.get("title")?,
        article_type,
        status: r.get("status")?,
        author_id: r.get("author_id")?,
        remote_modified: r.get("remote_modified")?,
        local_modified: r.get("local_modified")?,
        content_hash: r.get("content_hash")?,
        file_path: r.get("file_path")?,
        synced_at: r.get("synced_at")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

/// 把 `CoreError` 从 IO/DB 重新包一层，保持错误码稳定。
impl From<Db> for CoreError {
    fn from(_: Db) -> Self {
        CoreError::App("数据库未初始化".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        Db::open_in_memory().expect("内存库打开失败")
    }

    fn row(cid: &str, t: ArticleType, updated: i64) -> ArticleRow {
        let mut r = ArticleRow::new(cid, t, 1_000);
        r.title = format!("标题 {cid}");
        r.author_id = "u1".into();
        r.updated_at = updated;
        r
    }

    #[test]
    fn upsert_and_read_back_roundtrips_every_column() {
        let db = db();
        let mut a = row("c1", ArticleType::Waiting, 5_000);
        a.status = "publish".into();
        a.remote_modified = 1_700_000_000;
        a.local_modified = 1_700_000_000_123;
        a.content_hash = "abc".into();
        a.file_path = "/docs/a.md".into();
        a.synced_at = 42;
        db.upsert_article(&a).unwrap();

        let got = db.get_article_by_cid("c1").unwrap().expect("应存在");
        assert_eq!(got, a);
        assert_eq!(got.article_type, ArticleType::Waiting);
        assert!(got.is_linked());
    }

    #[test]
    fn upsert_conflict_updates_mutable_columns() {
        let db = db();
        db.upsert_article(&row("c1", ArticleType::PostDraft, 1))
            .unwrap();
        db.upsert_article(&row("c1", ArticleType::Post, 2)).unwrap();
        let all = db.list_articles(None).unwrap();
        assert_eq!(all.len(), 1, "同 cid 不应出现两行");
        assert_eq!(all[0].article_type, ArticleType::Post);
        assert_eq!(all[0].created_at, 1_000, "created_at 不应被覆盖");
    }

    #[test]
    fn list_orders_by_updated_at_desc_and_filters_type() {
        let db = db();
        db.upsert_article(&row("a", ArticleType::Post, 10)).unwrap();
        db.upsert_article(&row("b", ArticleType::Local, 30))
            .unwrap();
        db.upsert_article(&row("c", ArticleType::Post, 20)).unwrap();

        let all = db.list_articles(None).unwrap();
        assert_eq!(
            all.iter().map(|r| r.cid.as_str()).collect::<Vec<_>>(),
            vec!["b", "c", "a"]
        );
        let posts = db.list_articles(Some(ArticleType::Post)).unwrap();
        assert_eq!(
            posts.iter().map(|r| r.cid.as_str()).collect::<Vec<_>>(),
            vec!["c", "a"]
        );
    }

    #[test]
    fn patch_by_cid_and_file_path_sets_updated_at_and_ignores_missing() {
        let db = db();
        let mut local = ArticleRow::local_draft("/docs/draft.md", 1);
        local.title = "草稿".into();
        db.upsert_article(&local).unwrap();

        // 1.x 的 `updateArticleByFilePath` 只被「移动/重命名本地文件」使用（src/main/infra/fs/index.ts:227-230），
        // 补丁里改的是 file_path 与标题，不会改主键 cid（改 cid 会插入第二行 —— 1.x 同样如此）。
        let hit = db
            .update_article_by_file_path("/docs/draft.md", 9_999, |r| {
                r.file_path = "/docs/renamed.md".into();
                r.title = "改名后的草稿".into();
            })
            .unwrap();
        assert!(hit);
        let got = db
            .get_article_by_file_path("/docs/renamed.md")
            .unwrap()
            .unwrap();
        assert_eq!(got.cid, "", "本地草稿 cid 仍为空");
        assert_eq!(got.title, "改名后的草稿");
        assert_eq!(got.updated_at, 9_999);
        assert!(
            db.get_article_by_file_path("/docs/draft.md")
                .unwrap()
                .is_none()
        );

        assert!(!db.update_article_by_cid("nope", 1, |_| {}).unwrap());
        assert!(
            !db.update_article_by_file_path("/docs/none.md", 1, |_| {})
                .unwrap()
        );
    }

    #[test]
    fn clear_and_delete_articles() {
        let db = db();
        db.upsert_article(&row("a", ArticleType::Post, 1)).unwrap();
        db.upsert_article(&row("b", ArticleType::Post, 2)).unwrap();
        db.delete_article_by_cid("a").unwrap();
        assert_eq!(db.list_articles(None).unwrap().len(), 1);
        db.clear_articles().unwrap();
        assert!(db.list_articles(None).unwrap().is_empty());
    }

    #[test]
    fn meta_upserts_and_reads() {
        let db = db();
        assert_eq!(db.get_meta("last_sync").unwrap(), None);
        db.set_meta("last_sync", "1").unwrap();
        db.set_meta("last_sync", "2").unwrap();
        assert_eq!(db.get_meta("last_sync").unwrap().as_deref(), Some("2"));
    }

    #[test]
    fn read_cache_roundtrip_and_touch_throttle() {
        let db = db();
        let now = 1_000_000_i64;
        db.set_read_cache("k", &serde_json::json!({"v": 1}), now)
            .unwrap();
        let got: Option<serde_json::Value> = db.get_read_cache("k", now + 1_000).unwrap();
        assert_eq!(got.unwrap()["v"], 1);

        // 超过节流窗口才刷新 fetched_at
        let after = now + READ_CACHE_TOUCH_INTERVAL_MS + 1;
        let _: Option<serde_json::Value> = db.get_read_cache("k", after).unwrap();
        let _: Option<serde_json::Value> = db.get_read_cache("k", after + 1).unwrap();
        assert_eq!(db.read_cache_len().unwrap(), 1);
    }

    #[test]
    fn read_cache_expires_after_ttl_and_purges_the_row() {
        let db = db();
        let now = 0_i64;
        db.set_read_cache("k", &"x", now).unwrap();
        let got: Option<String> = db.get_read_cache("k", now + READ_CACHE_TTL_MS + 1).unwrap();
        assert!(got.is_none(), "过期应返回 None");
        assert_eq!(db.read_cache_len().unwrap(), 0, "过期条目应被删除");
    }

    #[test]
    fn corrupt_payload_is_dropped_instead_of_erroring() {
        let db = db();
        db.set_read_cache("k", &"ok", 0).unwrap();
        {
            let conn = db.lock();
            conn.execute("UPDATE read_cache SET payload = '{' WHERE key = 'k'", [])
                .unwrap();
        }
        let got: Option<String> = db.get_read_cache("k", 1).unwrap();
        assert!(got.is_none());
        assert_eq!(db.read_cache_len().unwrap(), 0);
    }

    #[test]
    fn set_read_cache_trims_to_target_watermark() {
        let db = db();
        // 每条 1MB，插 20 条 → 需要裁剪到 ≤ 12.8MB
        let blob = "x".repeat(1024 * 1024);
        for i in 0..20_i64 {
            db.set_read_cache(&format!("k{i}"), &blob, i).unwrap();
        }
        let total: i64 = db
            .lock()
            .query_row(
                "SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM read_cache",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            total <= READ_CACHE_TARGET_BYTES,
            "裁剪后总量 {total} 应低于目标水位"
        );
        assert!(total > 0);
    }

    #[test]
    fn clear_read_cache_removes_everything() {
        let db = db();
        db.set_read_cache("a", &1, 0).unwrap();
        db.set_read_cache("b", &2, 0).unwrap();
        db.clear_read_cache().unwrap();
        assert_eq!(db.read_cache_len().unwrap(), 0);
    }

    #[test]
    fn unknown_type_in_db_reports_error_instead_of_silently_coercing() {
        let db = db();
        {
            let conn = db.lock();
            conn.execute("INSERT INTO articles (cid, type) VALUES ('bad', 'wat')", [])
                .unwrap();
        }
        let err = db.get_article_by_cid("bad").unwrap_err();
        assert!(
            err.to_string().contains("未知文章状态"),
            "错误应说明取值: {err}"
        );
    }
}
