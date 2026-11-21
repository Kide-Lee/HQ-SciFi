//! 旧版 Electron 用户数据 → 新端 `data_dir` 的一次性迁移（SP-4 落地，见
//! `doc/spike/data-migration.md`）。
//!
//! 迁移脚本已在真实用户库上验证（`spikes/migrate/rs`），本模块把它提升为内核能力。
//! `hqsf.db` 的三张表与 1.x **逐字一致**，所以迁移不是「改 schema」而是「安全搬运」，
//! 核心风险是 WAL：真实库 `read_cache` 18 行里有 12 行只存在于 `-wal` 中（151,793 B），
//! 只复制 `hqsf.db` 会**静默**丢这 12 行且 `integrity_check` 仍返回 `ok`。
//!
//! # 流程（任何一步失败都不动旧目录、不留半个库）
//!
//! 1. 记录源指纹（`hqsf.db` / `hqsf.db-wal` / `settings.json` 的 sha256 与大小，
//!    `session.json` 是否存在的布尔值）；
//! 2. 幂等/冲突判定：目标已有 `migration.json` 且源指纹一致 → 直接返回
//!    [`MigrationStatus::AlreadyMigrated`]（不写任何文件）；源指纹变了且没有 `force` → 报错；
//!    目标已有 `hqsf.db` 但没有可用标记 → 报错（`force` 才覆盖）；
//! 3. 把 `hqsf.db`、`hqsf.db-wal`、`settings.json` 复制到 `<to>/.migrate-staging/`；
//! 4. 在 staging 副本上 `integrity_check` → 记录折叠前行数/整表指纹 →
//!    `PRAGMA wal_checkpoint(TRUNCATE)` 折叠 WAL → 写 `meta['migration.electron']` 标记 →
//!    逐列比对 schema；
//! 5. 关闭连接（SQLite 会删除 `-wal`/`-shm`）后**不带 WAL 重新只读打开**：
//!    `integrity_check` 必须 ok，`articles`/`read_cache` 整表指纹必须与折叠前逐字节一致，
//!    `meta` 行数应为折叠前 +1 —— 这是防「WAL 只折叠了一半」的真正验收；
//! 6. 复核源指纹未变（**在落位之前**，保证「源变则目标不落盘」）→ 原子 `rename`
//!    staging 的 `hqsf.db` / `settings.json` 到目标目录 → 复核落位后 db 指纹；
//! 7. 原子写 `<to>/migration.json`（源指纹、目标指纹、行数、表指纹、schema 差异…）。
//!
//! 失败语义：staging 一律删除；目标目录只有在第 6 步 rename 时才出现文件；旧目录永不删除、
//! 永不写入（可直接回滚到 Electron）。
//!
//! # 两个必须知道的事实（SP-4 实测）
//!
//! - `PRAGMA wal_checkpoint(TRUNCATE)` 的返回值**不可信**：本机 SQLite 对「首次打开旧库
//!   产生的 recovery checkpoint」返回 `(0,0,0)`，但 `-wal` 确实被截断。所以验收不看返回值，
//!   只看「关闭后无 WAL 重开、行数与整表指纹不变」。
//! - 对 WAL 库做**只读打开**会在同目录留下 `-shm` 与 0 字节 `-wal`；所以折叠与复核都在
//!   staging 里做，只 `rename` 真正的 db/settings，目标目录落位后只有 3 个文件。
//!
//! # 为什么这里直接用 `std::fs`
//!
//! 迁移是 bootstrap 层（与 [`crate::infra::db`] 同级，运行在 `CoreCtx` 装配之前）：
//! 它必须在 `Db::open` / `FileStore` 存在之前读写**真实路径**上的 SQLite 文件（`-wal`/`-shm`
//! 旁文件、同目录 `rename` 的原子性），`FileStore` 抽象表达不了这些语义。这是全仓唯一的
//! `std::fs` 豁免，**不要**把它当范例；其余 `infra` 代码仍走端口。
//!
//! `session.json` 一律不迁移：旧 token 由 Electron `safeStorage` 加密（或 base64 降级），
//! 新端无法解密，也不应复制——`session_action` 字段写明这一点，壳层据此决定是否提示
//! 「请重新登录」。

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{CoreError, CoreResult};
use crate::infra::db::DB_FILE_NAME;

/// 暂存目录名（位于目标目录下）。成功即删除；崩溃残留会在下次运行开始时清掉。
pub const STAGING_DIR: &str = ".migrate-staging";
/// 数据库文件名；与 [`DB_FILE_NAME`] 保持一致（旧端与新端同名）。
pub const DB_NAME: &str = DB_FILE_NAME;
/// 旧端设置文件名。
pub const SETTINGS_NAME: &str = "settings.json";
/// 旧端会话文件名（只识别、**不复制**）。
pub const SESSION_NAME: &str = "session.json";
/// 迁移标记文件名。
pub const MARKER_NAME: &str = "migration.json";
/// 迁移标记格式版本。
pub const MARKER_VERSION: i64 = 1;

/// 迁移开关。
#[derive(Debug, Clone, Copy, Default)]
pub struct MigrateOptions {
    /// 目标已有库/标记但与源指纹不一致时，允许用当前源重新迁移（只替换新目录，旧目录只读）。
    pub force: bool,
    /// 只演练：完整复制/校验后删除 staging，不写目标目录、不写 `migration.json`。
    pub dry_run: bool,
}

/// 本次调用的结果（不写进 `migration.json`）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MigrationStatus {
    /// 源目录没有旧库（新用户）：未写任何文件，直接建新库即可。
    #[default]
    NoSource,
    /// 目标已有 `migration.json` 且源指纹一致：幂等跳过，目标未被改动。
    AlreadyMigrated,
    /// 本次完成了迁移（数据已落位、标记已写）。
    Migrated,
    /// 演练完成：已完整校验，未写目标目录。
    DryRun,
}

/// 源指纹：迁移幂等判定与「源在迁移期间是否被写过」的证据。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SourceFingerprint {
    pub db_sha256: String,
    pub db_size: u64,
    pub wal_sha256: Option<String>,
    pub wal_size: Option<u64>,
    pub settings_sha256: Option<String>,
    /// 旧目录里是否存在 `session.json`（存在也不复制，只用于提示重新登录）。
    pub session_present: bool,
}

impl SourceFingerprint {
    /// 数据库本体（db + wal）是否一致——「源在迁移期间被写」只关心这两个文件。
    fn data_matches(&self, other: &Self) -> bool {
        self.db_sha256 == other.db_sha256 && self.wal_sha256 == other.wal_sha256
    }

    /// 完整指纹对比（含 settings.json）——幂等判定用，与 spike 一致。
    fn matches(&self, other: &Self) -> bool {
        self.data_matches(other) && self.settings_sha256 == other.settings_sha256
    }
}

/// 三张表的行数（表不存在时该字段为 `-1`，与 spike 的 `count` 一致）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Rows {
    pub articles: i64,
    pub read_cache: i64,
    pub meta: i64,
}

/// 迁移报告；序列化后就是 `<data_dir>/migration.json`（字段名沿 spike，wire 用 camelCase）。
///
/// 字段顺序与 spike 的 `MigrationMarker` 对齐：源/目标指纹、行数、整表指纹、schema 差异、
/// `verifiedWithoutWal`（证明 WAL 已折叠）、`sessionAction`（token 结论）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MigrationReport {
    pub marker_version: i64,
    /// 生成方标识，便于以后排查是哪一版内核写的标记。
    pub tool: String,
    pub migrated_at_ms: i64,
    pub migrated_at_iso: String,
    pub source_dir: String,
    pub target_dir: String,
    pub source: SourceFingerprint,
    /// 折叠 WAL 后 staging 库的 sha256（落位后复核对得上才算成功）。
    pub target_db_sha256: String,
    pub target_db_size: u64,
    pub user_version: i64,
    pub schema_version: i64,
    pub journal_mode_before_checkpoint: String,
    pub journal_mode_after_checkpoint: String,
    pub page_size: i64,
    pub encoding: String,
    /// 复制过来的 `-wal` 帧数（按 `32 + frames*(page_size+24)` 推算；无 WAL 时 `None`）。
    pub wal_frames: Option<i64>,
    /// checkpoint 后 `-wal` 的字节数（应为 0）。
    pub wal_bytes_after_checkpoint: Option<u64>,
    pub rows: Rows,
    pub table_fingerprints: BTreeMap<String, String>,
    pub schema_diffs: Vec<String>,
    pub verified_without_wal: bool,
    /// token 结论（必须重新登录 / 本来就没有会话）。
    pub session_action: String,
    /// 非致命问题（例如 settings.json 损坏被跳过）；进 `migration.json` 便于事后排查。
    pub warnings: Vec<String>,
    /// 本次调用结果；运行时字段，不写进 `migration.json`。
    #[serde(skip)]
    pub status: MigrationStatus,
}

impl MigrationReport {
    fn no_source(from_dir: &Path, to_dir: &Path) -> Self {
        Self {
            marker_version: MARKER_VERSION,
            tool: tool_name(),
            source_dir: from_dir.display().to_string(),
            target_dir: to_dir.display().to_string(),
            ..Self::default()
        }
    }
}

/// 旧 userData 目录 → 新 `data_dir`。幂等，可在启动时**无条件**调用：
///
/// - 旧目录没有 `hqsf.db` → [`MigrationStatus::NoSource`]（不创建任何文件）；
/// - 已迁移且源指纹未变 → [`MigrationStatus::AlreadyMigrated`]（不写任何文件）；
/// - 否则迁移一次并返回 [`MigrationStatus::Migrated`]（`dry_run` 时是
///   [`MigrationStatus::DryRun`]）。
///
/// 壳层调用建议：`app_data_dir`/旧 `userData` 由壳层按平台拼好后传入；调用点必须在
/// `Db::open` **之前**（迁移会创建/替换 `data_dir/hqsf.db`），失败时不要把错误吞掉。
pub fn migrate_legacy_data(
    from_dir: &Path,
    to_dir: &Path,
    options: &MigrateOptions,
) -> CoreResult<MigrationReport> {
    let mut noop = || {};
    migrate_legacy_data_with_hook(from_dir, to_dir, options, &mut noop)
}

/// [`migrate_legacy_data`] 的测试接缝：`after_copy` 在「复制到 staging 完成、落盘之前」被调用，
/// 用于确定性地模拟「旧端进程没退干净、迁移期间又写了源库」——生产调用传空闭包。
fn migrate_legacy_data_with_hook(
    from_dir: &Path,
    to_dir: &Path,
    options: &MigrateOptions,
    after_copy: &mut dyn FnMut(),
) -> CoreResult<MigrationReport> {
    // ---- 0. 前置：源目录没有旧库 = 新用户，什么都不做 ----
    if !from_dir.join(DB_NAME).is_file() {
        return Ok(MigrationReport::no_source(from_dir, to_dir));
    }
    ensure_disjoint(from_dir, to_dir)?;

    // ---- 1. 源指纹 ----
    let src = fingerprint_source(from_dir)?;

    // ---- 2. 幂等 / 冲突判定 ----
    let marker_path = to_dir.join(MARKER_NAME);
    let target_db = to_dir.join(DB_NAME);
    let mut warnings = Vec::new();
    if let Some(previous) = read_marker(&marker_path, &mut warnings) {
        let same = previous.marker_version == MARKER_VERSION && previous.source.matches(&src);
        let target_present = target_db.is_file();
        if same && target_present && !options.force {
            let mut report = previous;
            report.status = MigrationStatus::AlreadyMigrated;
            report.warnings.extend(warnings);
            return Ok(report);
        }
        if !same && target_present && !options.force {
            return Err(CoreError::app(
                "旧版数据在迁移后又被修改过（旧版应用可能被重新打开过）；为避免覆盖已迁移的数据，\
                 本次不迁移。确认要用当前旧数据重新迁移，请设置 force",
            ));
        }
        // 源指纹一致但目标库被删、或显式 force：继续重新迁移（下面会重写标记）。
    }
    if target_db.is_file() && !options.force {
        return Err(CoreError::app(
            "新数据目录已有 hqsf.db 但没有可用的迁移标记，拒绝覆盖；确认要重新迁移请设置 force",
        ));
    }

    // ---- 3~7. 暂存副本上完成全部校验，最后才落位 ----
    let target_existed = to_dir.exists();
    fs::create_dir_all(to_dir)?;
    let staging = to_dir.join(STAGING_DIR);
    if staging.exists() {
        // 上次崩溃留下的暂存目录；里面只有副本，直接清掉。
        fs::remove_dir_all(&staging)?;
    }
    fs::create_dir_all(&staging)?;

    let mut run = || -> CoreResult<MigrationReport> {
        let mut staged =
            stage_and_verify(from_dir, to_dir, &staging, &src, after_copy, &mut warnings)?;

        // 落盘前复核源指纹：源在迁移期间被写过 → 报错且目标不落盘。
        verify_source_unchanged(from_dir, &src)?;

        if options.dry_run {
            fs::remove_dir_all(&staging)?;
            if !target_existed {
                let _ = fs::remove_dir(to_dir); // 只在空目录时成功
            }
            staged.report.status = MigrationStatus::DryRun;
            return Ok(staged.report);
        }

        install(&staging, to_dir, &staged)?;
        write_atomic(&marker_path, &serde_json::to_vec_pretty(&staged.report)?)?;
        Ok(staged.report)
    };
    let result = run();
    if result.is_err() {
        // 失败语义：删 staging；启动时新建的空目标目录也收回（部分落位时保持原状，
        // 交给下次启动的 force 分支处理）。
        let _ = fs::remove_dir_all(&staging);
        if !target_existed {
            let _ = fs::remove_dir(to_dir);
        }
    }
    result
}

/// 已完成全部校验、等着落位的 staging 产物。
struct Staged {
    report: MigrationReport,
    settings_staged: bool,
}

/// 步骤 3–5：复制到 staging，校验并把 WAL 折叠进主库。
///
/// 返回时 staging 里只有 `hqsf.db`（单文件自洽库）与可选的 `settings.json`。
#[allow(clippy::too_many_arguments)]
fn stage_and_verify(
    from_dir: &Path,
    to_dir: &Path,
    staging: &Path,
    src: &SourceFingerprint,
    after_copy: &mut dyn FnMut(),
    warnings: &mut Vec<String>,
) -> CoreResult<Staged> {
    let src_db = from_dir.join(DB_NAME);
    let src_wal = from_dir.join(format!("{DB_NAME}-wal"));
    let staged_db = staging.join(DB_NAME);
    let staged_wal = staging.join(format!("{DB_NAME}-wal"));

    // ---- 3. 复制 db + wal + settings（session.json 一律不复制） ----
    fs::copy(&src_db, &staged_db)?;
    if src_wal.is_file() {
        fs::copy(&src_wal, &staged_wal)?;
    }
    let settings_staged = copy_settings(&from_dir.join(SETTINGS_NAME), staging, warnings)?;

    // 测试接缝：复制已完成，源库此后被改写必须被第 6 步的复核发现。
    after_copy();

    // ---- 4a. 只碰 staging 副本：integrity_check + 元信息 ----
    let conn = Connection::open_with_flags(
        &staged_db,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| {
            CoreError::app(format!(
                "旧版数据库完整性校验失败（{e}），本次未迁移任何数据"
            ))
        })?;
    if integrity != "ok" {
        return Err(CoreError::app(format!(
            "旧版数据库完整性校验失败（{integrity}），本次未迁移任何数据"
        )));
    }

    let journal_mode_before: String =
        conn.pragma_query_value(None, "journal_mode", |r| r.get(0))?;
    let user_version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let schema_version: i64 = conn.pragma_query_value(None, "schema_version", |r| r.get(0))?;
    let page_size: i64 = conn.pragma_query_value(None, "page_size", |r| r.get(0))?;
    let encoding: String = conn.pragma_query_value(None, "encoding", |r| r.get(0))?;

    // WAL 帧数按文件大小推算：32 字节头 + 每帧（24 字节帧头 + page_size）。
    let wal_frames = match src.wal_size {
        Some(bytes) if bytes >= 32 && page_size > 0 => Some((bytes as i64 - 32) / (page_size + 24)),
        Some(_) => Some(0),
        None => None,
    };

    // 折叠前（打开读写连接时 SQLite 已 recover WAL，所以这里读到的就是「完整数据」）。
    let rows_before = count_all(&conn)?;
    let fps_before = fingerprints(&conn)?;

    // ---- 4b. 在副本上折叠 WAL ----
    // 返回值不可信（见模块文档），不看它；验收在 4d。
    let _: (i64, i64, i64) = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
    })?;
    let wal_bytes_after_checkpoint = Some(if staged_wal.is_file() {
        fs::metadata(&staged_wal)?.len()
    } else {
        0
    });
    let journal_mode_after: String = conn.pragma_query_value(None, "journal_mode", |r| r.get(0))?;

    // ---- 4c. 写 meta 迁移标记（供新端识别「这份库来自 1.x」），再折叠一次 ----
    let has_meta = table_exists(&conn, "meta")?;
    if has_meta {
        let meta_marker = serde_json::json!({
            "markerVersion": MARKER_VERSION,
            "tool": tool_name(),
            "sourceDir": from_dir.display().to_string(),
            "sourceDbSha256": src.db_sha256.clone(),
            "migratedAtMs": now_ms(),
        });
        conn.execute(
            "INSERT INTO meta(key, value) VALUES('migration.electron', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [meta_marker.to_string()],
        )?;
        let _: (i64, i64, i64) = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
    } else {
        warnings.push("旧库没有 meta 表，跳过 meta 迁移标记（仍写 migration.json）".to_string());
    }

    let schema_diffs: Vec<String> = compare_schema(&conn)?
        .iter()
        .map(ColDiff::describe)
        .collect();
    if !schema_diffs.is_empty() {
        warnings.push(format!(
            "旧库 schema 与本版本期望有 {} 处差异（明细见 migration.json 的 schemaDiffs）",
            schema_diffs.len()
        ));
    }

    // 最后一个连接关闭：SQLite 会 checkpoint 并删除 -wal / -shm。
    drop(conn);

    // ---- 4d. 关闭后不带 WAL 重新只读打开：证明折叠完整 ----
    let wal_left = if staged_wal.is_file() {
        fs::metadata(&staged_wal)?.len()
    } else {
        0
    };
    if wal_left > 0 {
        return Err(CoreError::app(
            "WAL 折叠失败（关闭连接后 -wal 仍非空），本次未迁移任何数据",
        ));
    }
    // 注意：只读打开会留下 -shm 与 0 字节 -wal（SP-4 §2.3），所以这一步只在 staging 里做，
    // 落位只搬 db/settings。
    let verify = Connection::open_with_flags(
        &staged_db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let integrity2: String = verify
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| {
            CoreError::app(format!(
                "折叠 WAL 后数据库无法通过完整性校验（{e}），本次未迁移任何数据"
            ))
        })?;
    if integrity2 != "ok" {
        return Err(CoreError::app(format!(
            "折叠 WAL 后数据库完整性校验失败（{integrity2}），本次未迁移任何数据"
        )));
    }
    let rows_after = count_all(&verify)?;
    let fps_after = fingerprints(&verify)?;
    drop(verify);

    // articles / read_cache 必须逐字节一致；meta 因新增迁移标记而行数 +1。
    for table in ["articles", "read_cache"] {
        if fps_before.get(table) != fps_after.get(table) {
            return Err(CoreError::app(format!(
                "WAL 折叠后 {table} 表内容不一致，迁移中止（数据可能不完整）"
            )));
        }
    }
    let expected_meta = rows_before.meta + i64::from(has_meta);
    if rows_after.meta != expected_meta {
        return Err(CoreError::app(
            "WAL 折叠后 meta 表行数异常，迁移中止（数据可能不完整）",
        ));
    }

    let target_db_sha256 = sha256_file(&staged_db)?;
    let target_db_size = fs::metadata(&staged_db)?.len();
    let migrated_at_ms = now_ms();
    let report = MigrationReport {
        marker_version: MARKER_VERSION,
        tool: tool_name(),
        migrated_at_ms,
        migrated_at_iso: iso_from_ms(migrated_at_ms as u128),
        source_dir: from_dir.display().to_string(),
        target_dir: to_dir.display().to_string(),
        source: src.clone(),
        target_db_sha256,
        target_db_size,
        user_version,
        schema_version,
        journal_mode_before_checkpoint: journal_mode_before,
        journal_mode_after_checkpoint: journal_mode_after,
        page_size,
        encoding,
        wal_frames,
        wal_bytes_after_checkpoint,
        rows: rows_after,
        table_fingerprints: fps_after,
        schema_diffs,
        verified_without_wal: true,
        session_action: session_action(src.session_present),
        warnings: std::mem::take(warnings),
        status: MigrationStatus::Migrated,
    };
    Ok(Staged {
        report,
        settings_staged,
    })
}

/// 步骤 6：同文件系统 `rename` 落位（原子），随后复核落位后指纹。
fn install(staging: &Path, to_dir: &Path, staged: &Staged) -> CoreResult<()> {
    let target_db = to_dir.join(DB_NAME);
    if target_db.exists() {
        // 仅 force / 目标库被删而标记残留这两条路径可达。
        fs::remove_file(&target_db)?;
    }
    fs::rename(staging.join(DB_NAME), &target_db)?;

    if staged.settings_staged {
        let target_settings = to_dir.join(SETTINGS_NAME);
        if target_settings.exists() {
            fs::remove_file(&target_settings)?;
        }
        fs::rename(staging.join(SETTINGS_NAME), &target_settings)?;
    }
    fs::remove_dir_all(staging)?;

    let installed = sha256_file(&target_db)?;
    if installed != staged.report.target_db_sha256 {
        let _ = fs::remove_file(&target_db);
        return Err(CoreError::app(
            "数据库落位后指纹与暂存副本不一致，已撤销本次落盘；请重试",
        ));
    }
    Ok(())
}

/// 源指纹（步骤 1）。
pub fn fingerprint_source(from_dir: &Path) -> CoreResult<SourceFingerprint> {
    let db = from_dir.join(DB_NAME);
    let wal = from_dir.join(format!("{DB_NAME}-wal"));
    let settings = from_dir.join(SETTINGS_NAME);
    let (wal_sha256, wal_size) = if wal.is_file() {
        (Some(sha256_file(&wal)?), Some(fs::metadata(&wal)?.len()))
    } else {
        (None, None)
    };
    Ok(SourceFingerprint {
        db_sha256: sha256_file(&db)?,
        db_size: fs::metadata(&db)?.len(),
        wal_sha256,
        wal_size,
        settings_sha256: if settings.is_file() {
            Some(sha256_file(&settings)?)
        } else {
            None
        },
        session_present: from_dir.join(SESSION_NAME).exists(),
    })
}

/// 复核源库（db + wal）在迁移期间没有被改写。变化 → `Err`，调用方保证目标不落盘。
pub fn verify_source_unchanged(from_dir: &Path, expected: &SourceFingerprint) -> CoreResult<()> {
    let now = fingerprint_source(from_dir)?;
    if !now.data_matches(expected) {
        return Err(CoreError::app(
            "旧版数据在迁移过程中被修改（旧版应用可能仍在运行）；本次未迁移任何数据，\
             请关闭旧版后重试",
        ));
    }
    Ok(())
}

/// 复制 settings.json 到 staging：合法 JSON 对象则原字节复制；损坏则跳过并记 warning
/// （SP-4 结论：设置文件损坏不应阻断迁移，新端会落到默认值）。
fn copy_settings(
    src_settings: &Path,
    staging: &Path,
    warnings: &mut Vec<String>,
) -> CoreResult<bool> {
    if !src_settings.is_file() {
        // 与 1.x 一致：设置文件缺失 → 默认值，不阻断。
        return Ok(false);
    }
    match read_settings(src_settings) {
        Ok(report) => {
            if !report.unknown_keys.is_empty() || !report.field_type_issues.is_empty() {
                warnings.push(format!(
                    "旧版 settings.json 有 {} 个未知字段、{} 处字段类型不符（原样复制，新端读取时会归一化）",
                    report.unknown_keys.len(),
                    report.field_type_issues.len()
                ));
            }
            fs::copy(src_settings, staging.join(SETTINGS_NAME))?;
            Ok(true)
        }
        Err(_) => {
            warnings.push(
                "旧版 settings.json 不是合法的 JSON 对象，未复制（新端使用默认设置）".to_string(),
            );
            Ok(false)
        }
    }
}

/// token 结论文案（写进 `migration.json.sessionAction`，壳层据此决定是否提示重新登录）。
fn session_action(session_present: bool) -> String {
    if session_present {
        "旧 session.json 未复制：token 由 Electron safeStorage 加密，Tauri 侧无法解密 → \
         首次启动强制重新登录"
            .to_string()
    } else {
        "源目录本无 session.json：无需清理，首次启动即未登录状态".to_string()
    }
}

fn tool_name() -> String {
    format!("hqsf-core {}", env!("CARGO_PKG_VERSION"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 读迁移标记；不存在/不可读/不可解析都当作「没有标记」（后者记一条 warning）。
fn read_marker(path: &Path, warnings: &mut Vec<String>) -> Option<MigrationReport> {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<MigrationReport>(&bytes) {
            Ok(marker) => Some(marker),
            Err(_) => {
                warnings.push("已有 migration.json 无法解析，按「没有迁移标记」处理".to_string());
                None
            }
        },
        Err(e) if e.kind() == ErrorKind::NotFound => None,
        Err(_) => {
            warnings.push("已有 migration.json 无法读取，按「没有迁移标记」处理".to_string());
            None
        }
    }
}

/// 两个目录不能相同、也不能互相包含（否则 staging/落位会踩到源目录）。
fn ensure_disjoint(from_dir: &Path, to_dir: &Path) -> CoreResult<()> {
    let lexical =
        from_dir == to_dir || from_dir.starts_with(to_dir) || to_dir.starts_with(from_dir);
    let canonical = match (fs::canonicalize(from_dir), fs::canonicalize(to_dir)) {
        (Ok(from), Ok(to)) => from == to || from.starts_with(&to) || to.starts_with(&from),
        _ => false,
    };
    if lexical || canonical {
        return Err(CoreError::app("旧数据目录与新数据目录不能相同或互相包含"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 文件哈希 / 原子写（移植自 spike `lib.rs`；sha2 已在 workspace 依赖里）
// ---------------------------------------------------------------------------

/// 文件 sha256（十六进制小写）。
pub fn sha256_file(path: &Path) -> CoreResult<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

/// 内存块的 sha256（十六进制小写）。
pub fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex(&hasher.finalize())
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    out
}

/// 原子写文件（同目录 `<name>.tmp` + `rename`），用于 `migration.json`。
pub fn write_atomic(path: &Path, contents: &[u8]) -> CoreResult<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    {
        let mut file = File::create(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 整表指纹（用于「WAL 折叠前后数据逐字节一致」验证）
// ---------------------------------------------------------------------------

/// 对整张表做确定性指纹：按第 1 列排序，逐行逐列按类型打标签后哈希。
///
/// 用来对比折叠 WAL 前后的表内容（值本身不做任何转换，文本原样进哈希）。
pub fn table_fingerprint(conn: &Connection, table: &str) -> rusqlite::Result<String> {
    let mut hasher = Sha256::new();
    let mut stmt = conn.prepare(&format!("SELECT * FROM \"{table}\" ORDER BY 1"))?;
    let ncols = stmt.column_count();
    let mut rows = stmt.query([])?;
    let mut nrows = 0u64;
    while let Some(row) = rows.next()? {
        nrows += 1;
        for i in 0..ncols {
            match row.get_ref(i)? {
                ValueRef::Null => hasher.update(b"N;"),
                ValueRef::Integer(v) => {
                    hasher.update(b"I");
                    hasher.update(v.to_le_bytes());
                }
                ValueRef::Real(v) => {
                    hasher.update(b"R");
                    hasher.update(v.to_bits().to_le_bytes());
                }
                ValueRef::Text(bytes) => {
                    hasher.update(b"T");
                    hasher.update((bytes.len() as u64).to_le_bytes());
                    hasher.update(bytes);
                }
                ValueRef::Blob(bytes) => {
                    hasher.update(b"B");
                    hasher.update((bytes.len() as u64).to_le_bytes());
                    hasher.update(bytes);
                }
            }
        }
        hasher.update(b"\n");
    }
    Ok(format!("rows={nrows};sha256={}", hex(&hasher.finalize())))
}

/// 无 chrono 依赖的 UTC ISO 时间（人类可读，不参与任何判定）。
pub fn iso_from_ms(ms: u128) -> String {
    let secs = (ms / 1000) as i64;
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // 1970-01-01 起的天数 → 公历（Howard Hinnant civil_from_days）。
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

// ---------------------------------------------------------------------------
// 行数 / 表存在性
// ---------------------------------------------------------------------------

const TABLE_NAMES: [&str; 3] = ["articles", "read_cache", "meta"];

fn table_exists(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
        [table],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// 行数；表不存在返回 `-1`（与 spike 的 `count` 一致，便于在报告里区分「空表」与「缺表」）。
fn count_rows(conn: &Connection, table: &str) -> rusqlite::Result<i64> {
    if !table_exists(conn, table)? {
        return Ok(-1);
    }
    conn.query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |r| {
        r.get(0)
    })
}

fn count_all(conn: &Connection) -> rusqlite::Result<Rows> {
    Ok(Rows {
        articles: count_rows(conn, "articles")?,
        read_cache: count_rows(conn, "read_cache")?,
        meta: count_rows(conn, "meta")?,
    })
}

/// 三张表各自的整表指纹；缺表就跳过（schema 差异会进 `schema_diffs`）。
fn fingerprints(conn: &Connection) -> rusqlite::Result<BTreeMap<String, String>> {
    let mut map = BTreeMap::new();
    for table in TABLE_NAMES {
        if table_exists(conn, table)? {
            map.insert(table.to_string(), table_fingerprint(conn, table)?);
        }
    }
    Ok(map)
}

// ---------------------------------------------------------------------------
// settings.json（移植 spike `read_settings` 的校验语义：只报告，不阻断迁移）
// ---------------------------------------------------------------------------

/// `settings.json` 的体检结果。
#[derive(Debug, Clone)]
pub struct SettingsReport {
    /// 解析后的 JSON（原样，未归一化）。
    pub raw: serde_json::Value,
    /// 1.x 设置里没有的字段（旧版装过更新版本后回退时可能出现）。
    pub unknown_keys: Vec<String>,
    /// 已知字段但类型不符（例如 `zoomFactor: "1.2"`）。
    pub field_type_issues: Vec<String>,
}

/// 读取并解析 `settings.json`。
///
/// 与 spike 的 `read_settings` 一致：**JSON 解析失败返回 `Err`**（由调用方决定回退默认值），
/// 未知字段/字段类型问题只记进返回结构，不失败。这里额外要求顶层是对象——1.x `normalize()`
/// 对非对象输入也回退默认值，但那样的文件没有复制价值。
pub fn read_settings(path: &Path) -> CoreResult<SettingsReport> {
    let bytes = fs::read(path)?;
    let raw: serde_json::Value = serde_json::from_slice(&bytes)?;
    if !raw.is_object() {
        return Err(CoreError::app("settings.json 顶层不是 JSON 对象"));
    }
    let known = [
        "autoUpdate",
        "hardwareAccel",
        "zoomFactor",
        "customCss",
        "customJs",
    ];
    let mut unknown_keys = Vec::new();
    let mut field_type_issues = Vec::new();
    if let Some(obj) = raw.as_object() {
        for (key, value) in obj {
            if !known.contains(&key.as_str()) {
                unknown_keys.push(key.clone());
                continue;
            }
            let ok = match key.as_str() {
                "autoUpdate" | "hardwareAccel" => value.is_boolean(),
                "zoomFactor" => value.is_number(),
                "customCss" | "customJs" => value.is_string(),
                _ => true,
            };
            if !ok {
                field_type_issues.push(format!("{key}: 期望类型不匹配，实际 {}", json_type(value)));
            }
        }
    }
    Ok(SettingsReport {
        raw,
        unknown_keys,
        field_type_issues,
    })
}

fn json_type(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "bool",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

// ---------------------------------------------------------------------------
// schema 逐列比对（移植自 spike `lib.rs`；期望值逐字对齐 `infra/db.rs` 的 `SCHEMA`）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
struct ExpectedCol {
    name: &'static str,
    /// 建表语句里的声明类型（SQLite 类型亲和性由它推导）。
    decl_type: &'static str,
    notnull: bool,
    /// 默认值的 SQL 文本；`None` = 无默认值。
    default: Option<&'static str>,
    /// `PRAGMA table_info` 的 pk 序号；0 = 非主键。
    pk: i64,
}

#[derive(Debug, Clone, Copy)]
struct ExpectedTable {
    name: &'static str,
    cols: &'static [ExpectedCol],
    indexes: &'static [&'static str],
}

const fn col(
    name: &'static str,
    decl_type: &'static str,
    notnull: bool,
    default: Option<&'static str>,
    pk: i64,
) -> ExpectedCol {
    ExpectedCol {
        name,
        decl_type,
        notnull,
        default,
        pk,
    }
}

const ARTICLES_COLS: &[ExpectedCol] = &[
    col("cid", "TEXT", false, None, 1),
    col("title", "TEXT", true, Some("''"), 0),
    col("type", "TEXT", true, Some("'local'"), 0),
    col("status", "TEXT", true, Some("''"), 0),
    col("author_id", "TEXT", true, Some("''"), 0),
    col("remote_modified", "INTEGER", true, Some("0"), 0),
    col("local_modified", "INTEGER", true, Some("0"), 0),
    col("content_hash", "TEXT", true, Some("''"), 0),
    col("file_path", "TEXT", true, Some("''"), 0),
    col("synced_at", "INTEGER", true, Some("0"), 0),
    col("created_at", "INTEGER", true, Some("0"), 0),
    col("updated_at", "INTEGER", true, Some("0"), 0),
];

const READ_CACHE_COLS: &[ExpectedCol] = &[
    col("key", "TEXT", false, None, 1),
    col("payload", "TEXT", true, Some("''"), 0),
    col("fetched_at", "INTEGER", true, Some("0"), 0),
];

const META_COLS: &[ExpectedCol] = &[
    col("key", "TEXT", false, None, 1),
    col("value", "TEXT", true, Some("''"), 0),
];

const EXPECTED_TABLES: &[ExpectedTable] = &[
    ExpectedTable {
        name: "articles",
        cols: ARTICLES_COLS,
        indexes: &["idx_articles_type", "idx_articles_file_path"],
    },
    ExpectedTable {
        name: "read_cache",
        cols: READ_CACHE_COLS,
        indexes: &[],
    },
    ExpectedTable {
        name: "meta",
        cols: META_COLS,
        indexes: &[],
    },
];

/// SQLite 类型亲和性推导（<https://www.sqlite.org/datatype3.html> §3.1）。
fn type_affinity(decl_type: &str) -> &'static str {
    let t = decl_type.to_ascii_uppercase();
    if t.contains("INT") {
        "INTEGER"
    } else if t.contains("CHAR") || t.contains("CLOB") || t.contains("TEXT") {
        "TEXT"
    } else if t.contains("BLOB") || t.trim().is_empty() {
        "BLOB"
    } else if t.contains("REAL") || t.contains("FLOA") || t.contains("DOUB") {
        "REAL"
    } else {
        "NUMERIC"
    }
}

#[derive(Debug, Clone)]
struct ActualCol {
    name: String,
    decl_type: String,
    notnull: bool,
    default: Option<String>,
    pk: i64,
}

fn table_info(conn: &Connection, table: &str) -> rusqlite::Result<Vec<ActualCol>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
    let rows = stmt.query_map([], |r| {
        Ok(ActualCol {
            name: r.get(1)?,
            decl_type: r.get(2)?,
            notnull: r.get::<_, i64>(3)? != 0,
            default: r.get(4)?,
            pk: r.get(5)?,
        })
    })?;
    rows.collect()
}

/// 一处 schema 差异（旧库与本版本期望的 DDL 漂移）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ColDiff {
    MissingTable(String),
    MissingColumn {
        table: String,
        col: String,
    },
    ExtraColumn {
        table: String,
        col: String,
        decl_type: String,
    },
    AffinityMismatch {
        table: String,
        col: String,
        expected_decl: String,
        actual_decl: String,
        expected_affinity: String,
        actual_affinity: String,
    },
    NotNullMismatch {
        table: String,
        col: String,
        expected: bool,
        actual: bool,
    },
    DefaultMismatch {
        table: String,
        col: String,
        expected: Option<String>,
        actual: Option<String>,
    },
    PkMismatch {
        table: String,
        col: String,
        expected: i64,
        actual: i64,
    },
    MissingIndex {
        table: String,
        index: String,
    },
}

impl ColDiff {
    /// 给 `migration.json` 的 `schemaDiffs` 用的中文描述。
    pub fn describe(&self) -> String {
        match self {
            ColDiff::MissingTable(table) => format!("表 {table} 不存在"),
            ColDiff::MissingColumn { table, col } => format!("{table}.{col}: 期望的列不存在"),
            ColDiff::ExtraColumn {
                table,
                col,
                decl_type,
            } => format!("{table}.{col}: 多出的列（{decl_type}），旧库/新库不一致"),
            ColDiff::AffinityMismatch {
                table,
                col,
                expected_decl,
                actual_decl,
                expected_affinity,
                actual_affinity,
            } => format!(
                "{table}.{col}: 声明类型 {actual_decl:?}（亲和性 {actual_affinity}）≠ 期望 \
                 {expected_decl:?}（亲和性 {expected_affinity}）"
            ),
            ColDiff::NotNullMismatch {
                table,
                col,
                expected,
                actual,
            } => format!("{table}.{col}: NOT NULL 期望 {expected} 实际 {actual}"),
            ColDiff::DefaultMismatch {
                table,
                col,
                expected,
                actual,
            } => format!("{table}.{col}: 默认值期望 {expected:?} 实际 {actual:?}"),
            ColDiff::PkMismatch {
                table,
                col,
                expected,
                actual,
            } => format!("{table}.{col}: 主键序号期望 {expected} 实际 {actual}"),
            ColDiff::MissingIndex { table, index } => format!("{table}: 期望索引 {index} 不存在"),
        }
    }
}

/// 逐列比对：期望 schema vs 实际库。差异只报告不阻断（由新端 schema 演进逻辑补齐）。
pub fn compare_schema(conn: &Connection) -> rusqlite::Result<Vec<ColDiff>> {
    let mut diffs = Vec::new();
    let actual_indexes: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'",
        )?;
        let it = stmt.query_map([], |r| r.get::<_, String>(0))?;
        it.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let all_tables: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )?;
        let it = stmt.query_map([], |r| r.get::<_, String>(0))?;
        it.collect::<rusqlite::Result<Vec<_>>>()?
    };

    for t in EXPECTED_TABLES {
        if !all_tables.iter().any(|n| n == t.name) {
            diffs.push(ColDiff::MissingTable(t.name.to_string()));
            continue;
        }
        let actual = table_info(conn, t.name)?;
        for e in t.cols {
            match actual.iter().find(|a| a.name == e.name) {
                None => diffs.push(ColDiff::MissingColumn {
                    table: t.name.to_string(),
                    col: e.name.to_string(),
                }),
                Some(a) => {
                    let ea = type_affinity(e.decl_type);
                    let aa = type_affinity(&a.decl_type);
                    if ea != aa {
                        diffs.push(ColDiff::AffinityMismatch {
                            table: t.name.to_string(),
                            col: e.name.to_string(),
                            expected_decl: e.decl_type.to_string(),
                            actual_decl: a.decl_type.clone(),
                            expected_affinity: ea.to_string(),
                            actual_affinity: aa.to_string(),
                        });
                    }
                    if e.notnull != a.notnull {
                        diffs.push(ColDiff::NotNullMismatch {
                            table: t.name.to_string(),
                            col: e.name.to_string(),
                            expected: e.notnull,
                            actual: a.notnull,
                        });
                    }
                    if e.default != a.default.as_deref() {
                        diffs.push(ColDiff::DefaultMismatch {
                            table: t.name.to_string(),
                            col: e.name.to_string(),
                            expected: e.default.map(str::to_string),
                            actual: a.default.clone(),
                        });
                    }
                    if e.pk != a.pk {
                        diffs.push(ColDiff::PkMismatch {
                            table: t.name.to_string(),
                            col: e.name.to_string(),
                            expected: e.pk,
                            actual: a.pk,
                        });
                    }
                }
            }
        }
        for a in &actual {
            if !t.cols.iter().any(|e| e.name == a.name) {
                diffs.push(ColDiff::ExtraColumn {
                    table: t.name.to_string(),
                    col: a.name.clone(),
                    decl_type: a.decl_type.clone(),
                });
            }
        }
        for idx in t.indexes {
            if !actual_indexes.iter().any(|n| n == idx) {
                diffs.push(ColDiff::MissingIndex {
                    table: t.name.to_string(),
                    index: idx.to_string(),
                });
            }
        }
    }
    Ok(diffs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::db::Db;
    use rusqlite::params;

    /// 造一个「旧端」源目录，返回仍持有连接的句柄（不关 → `-wal` 保留未 checkpoint 的帧）。
    ///
    /// 形态与 SP-4 的真实用户库一致（`read_cache` 18 行）：
    /// - 主库 `hqsf.db` 只有前 6 行（真实数据里主文件 mtime 停在 01:21）；
    /// - `hqsf.db-wal` 里有后 12 行未 checkpoint 的帧（真实数据里 WAL 写到 12:33）。
    ///
    /// 建表复用 [`Db::open`]（即 `infra/db.rs` 的真实 `SCHEMA`，测试里不手抄 DDL）。
    fn legacy_source(dir: &Path) -> Connection {
        let db_path = dir.join(DB_NAME);
        let db = Db::open(&db_path).expect("建源库失败");
        for i in 0..6 {
            db.set_read_cache(&format!("article:2404:{i}"), &sample_payload(i), 1_000 + i)
                .expect("写主库行失败");
        }
        // 最后一个连接关闭：SQLite 会 checkpoint 并删除 -wal，把前 6 行落进主文件。
        drop(db);

        let conn = Connection::open(&db_path).expect("重开源库失败");
        let mode: String = conn
            .pragma_query_value(None, "journal_mode", |r| r.get(0))
            .expect("读 journal_mode 失败");
        assert_eq!(mode, "wal", "源库应为 WAL 模式");
        for i in 6..18 {
            conn.execute(
                "INSERT INTO read_cache(key, payload, fetched_at) VALUES (?1, ?2, ?3)",
                params![
                    format!("article:anon:{i}"),
                    sample_payload(i).to_string(),
                    1_000 + i
                ],
            )
            .expect("写 WAL 行失败");
        }
        assert!(
            dir.join(format!("{DB_NAME}-wal")).is_file(),
            "夹具必须带未 checkpoint 的 -wal，否则测不到 WAL 语义"
        );
        conn
    }

    fn sample_payload(i: i64) -> serde_json::Value {
        serde_json::json!({
            "cid": format!("10000000{i}"),
            "title": format!("标题 {i}"),
            "text": format!("<p>正文 {i}</p>"),
        })
    }

    /// 源库「连同 WAL 一起 checkpoint 之后」的 `read_cache` 行数与整表指纹——
    /// 这是迁移产物的**独立基准**（不经过迁移代码）。
    fn read_cache_after_checkpoint(dir: &Path) -> (i64, String) {
        let scratch = tempfile::tempdir().expect("临时目录");
        fs::copy(dir.join(DB_NAME), scratch.path().join(DB_NAME)).expect("复制 db");
        let wal = dir.join(format!("{DB_NAME}-wal"));
        if wal.is_file() {
            fs::copy(&wal, scratch.path().join(format!("{DB_NAME}-wal"))).expect("复制 wal");
        }
        let conn = Connection::open(scratch.path().join(DB_NAME)).expect("打开副本");
        let _: (i64, i64, i64) = conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .expect("checkpoint");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM read_cache", [], |r| r.get(0))
            .expect("数行数");
        let fp = table_fingerprint(&conn, "read_cache").expect("算指纹");
        drop(conn);
        assert!(
            !scratch.path().join(format!("{DB_NAME}-wal")).is_file()
                || fs::metadata(scratch.path().join(format!("{DB_NAME}-wal")))
                    .map(|m| m.len())
                    .unwrap_or(0)
                    == 0,
            "checkpoint 后 WAL 应为空"
        );
        (rows, fp)
    }

    fn dir_entries(dir: &Path) -> Vec<String> {
        let mut entries: Vec<String> = fs::read_dir(dir)
            .expect("列目录")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        entries.sort();
        entries
    }

    #[test]
    fn migrates_rows_fingerprints_and_marker_and_folds_wal() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let from = tmp.path().join("legacy");
        let to = tmp.path().join("data");
        let _src_conn = legacy_source(&from);
        let settings = r#"{"autoUpdate":false,"customCss":"","customJs":"","hardwareAccel":true,"zoomFactor":1}"#;
        fs::write(from.join(SETTINGS_NAME), settings.as_bytes()).expect("写 settings");
        fs::write(from.join(SESSION_NAME), b"{\"tokenCipher\":\"x\"}").expect("写 session");

        let report = migrate_legacy_data(&from, &to, &MigrateOptions::default()).expect("迁移失败");

        assert_eq!(report.status, MigrationStatus::Migrated);
        assert_eq!(report.marker_version, MARKER_VERSION);
        // 行数：articles=0；read_cache=18（6 主库 + 12 WAL）；meta 多 1 条迁移标记。
        assert_eq!(
            report.rows,
            Rows {
                articles: 0,
                read_cache: 18,
                meta: 1
            }
        );
        assert!(report.verified_without_wal);
        assert_eq!(report.wal_bytes_after_checkpoint, Some(0));
        assert!(
            report.source.wal_size.unwrap_or(0) > 0,
            "源 WAL 应非空，否则没测到折叠"
        );
        assert!(report.wal_frames.unwrap_or(0) > 0);
        assert_eq!(
            report.target_db_sha256,
            sha256_file(&to.join(DB_NAME)).expect("目标 db 哈希")
        );
        assert_eq!(
            report.target_db_size,
            fs::metadata(to.join(DB_NAME)).unwrap().len()
        );
        assert!(
            report.schema_diffs.is_empty(),
            "旧库与新库 schema 应 0 差异"
        );
        assert_eq!(report.table_fingerprints.len(), 3);
        // session 不迁移，但要记录并写清 token 结论。
        assert!(report.source.session_present);
        assert!(report.session_action.contains("重新登录"));
        assert!(!to.join(SESSION_NAME).exists());
        // settings 原字节复制。
        assert_eq!(
            fs::read(to.join(SETTINGS_NAME)).expect("目标 settings"),
            settings.as_bytes()
        );
        // 落位后目标目录只有 3 个文件，-wal 已折叠（不存在），staging 已删。
        assert!(!to.join(format!("{DB_NAME}-wal")).exists());
        assert!(!to.join(format!("{DB_NAME}-shm")).exists());
        assert!(!to.join(STAGING_DIR).exists());
        assert_eq!(
            dir_entries(&to),
            vec![
                DB_NAME.to_string(),
                MARKER_NAME.to_string(),
                SETTINGS_NAME.to_string()
            ]
        );

        // migration.json 内容（camelCase，不含运行时字段）。
        let raw = fs::read_to_string(to.join(MARKER_NAME)).expect("读 marker");
        let marker: serde_json::Value = serde_json::from_str(&raw).expect("marker 应为 JSON");
        assert_eq!(marker["markerVersion"], MARKER_VERSION);
        assert_eq!(marker["rows"]["readCache"], 18);
        assert_eq!(marker["rows"]["articles"], 0);
        assert_eq!(marker["rows"]["meta"], 1);
        assert_eq!(marker["verifiedWithoutWal"], true);
        assert_eq!(marker["source"]["dbSha256"], report.source.db_sha256);
        assert_eq!(marker["source"]["sessionPresent"], true);
        assert_eq!(marker["targetDbSha256"], report.target_db_sha256);
        assert!(marker["tableFingerprints"]["read_cache"].is_string());
        assert!(marker["schemaDiffs"].as_array().unwrap().is_empty());
        assert!(marker.get("status").is_none(), "运行时字段不应写进 marker");

        // 目标库能被新端正常打开（同款 DDL 幂等），行数与迁移报告一致。
        let db = Db::open(&to.join(DB_NAME)).expect("新端开库失败");
        assert_eq!(db.read_cache_len().expect("数缓存"), 18);
        let meta = db
            .get_meta("migration.electron")
            .expect("读 meta")
            .expect("应有迁移标记");
        assert!(meta.contains("markerVersion"));
    }

    #[test]
    fn copying_db_without_wal_silently_loses_rows() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let from = tmp.path().join("legacy");
        let to = tmp.path().join("data");
        let _src_conn = legacy_source(&from);

        // SP-4 真实数据：同一个库带 WAL 是 18 行，只复制 db 是 6 行——静默丢 12 行 /
        // 151,793 B，且 integrity_check 依然返回 ok。这里用相同形态的夹具复现。
        let (full_rows, full_fp) = read_cache_after_checkpoint(&from);
        assert_eq!(full_rows, 18);

        let broken = tmp.path().join("db-only");
        fs::create_dir_all(&broken).expect("建目录");
        fs::copy(from.join(DB_NAME), broken.join(DB_NAME)).expect("只复制 db");
        let conn = Connection::open_with_flags(
            broken.join(DB_NAME),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .expect("只读打开 db-only 副本");
        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .expect("integrity_check");
        let lost_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM read_cache", [], |r| r.get(0))
            .expect("数行数");
        drop(conn);

        assert_eq!(integrity, "ok", "丢 WAL 不会报错，这正是最危险的静默失败");
        assert_eq!(lost_rows, 6, "只复制 db 只剩主库里的 6 行");
        assert!(lost_rows < full_rows);

        // 迁移实现必须把 -wal 一起带走并折叠：迁移后行数、整表指纹都应等于独立基准。
        let report = migrate_legacy_data(&from, &to, &MigrateOptions::default()).expect("迁移失败");
        assert_eq!(report.rows.read_cache, full_rows);
        assert_eq!(
            report.table_fingerprints["read_cache"], full_fp,
            "迁移产物的 read_cache 必须逐字节等于「源库 checkpoint 后」的完整数据"
        );
    }

    #[test]
    fn second_run_is_idempotent_and_rewrites_nothing() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let from = tmp.path().join("legacy");
        let to = tmp.path().join("data");
        let _src_conn = legacy_source(&from);

        let first = migrate_legacy_data(&from, &to, &MigrateOptions::default()).expect("首次迁移");
        let db_bytes = fs::read(to.join(DB_NAME)).expect("读目标 db");
        let marker_bytes = fs::read(to.join(MARKER_NAME)).expect("读 marker");

        let second = migrate_legacy_data(&from, &to, &MigrateOptions::default()).expect("重复迁移");
        assert_eq!(second.status, MigrationStatus::AlreadyMigrated);
        assert_eq!(second.target_db_sha256, first.target_db_sha256);
        assert_eq!(second.rows, first.rows);
        assert_eq!(fs::read(to.join(DB_NAME)).expect("再读 db"), db_bytes);
        assert_eq!(
            fs::read(to.join(MARKER_NAME)).expect("再读 marker"),
            marker_bytes
        );
        assert!(!to.join(STAGING_DIR).exists(), "幂等路径不应建 staging");
    }

    #[test]
    fn dry_run_lands_nothing() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let from = tmp.path().join("legacy");
        let to = tmp.path().join("data");
        let _src_conn = legacy_source(&from);

        let report = migrate_legacy_data(
            &from,
            &to,
            &MigrateOptions {
                dry_run: true,
                force: false,
            },
        )
        .expect("演练失败");

        assert_eq!(report.status, MigrationStatus::DryRun);
        assert_eq!(report.rows.read_cache, 18);
        assert!(report.verified_without_wal);
        assert!(!to.exists(), "dry-run 不应在目标目录留下任何东西");
        assert!(!to.join(DB_NAME).exists());
        assert!(!to.join(MARKER_NAME).exists());
        assert!(!to.join(STAGING_DIR).exists());
    }

    #[test]
    fn corrupt_source_fails_and_leaves_no_trace() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let from = tmp.path().join("legacy");
        let to = tmp.path().join("data");
        let src_conn = legacy_source(&from);
        drop(src_conn); // 关连接 → checkpoint 并删掉 -wal，再截断主文件
        let db_path = from.join(DB_NAME);
        let bytes = fs::read(&db_path).expect("读源库");
        assert!(bytes.len() > 4096);
        // 保留合法文件头、截断正文（与 SP-4 失败测试 A 的损坏方式一致）。
        fs::write(&db_path, &bytes[..4096]).expect("截断源库");

        let err = migrate_legacy_data(&from, &to, &MigrateOptions::default()).expect_err("应失败");
        assert_eq!(err.code(), "app");
        assert!(err.to_string().contains("完整性校验失败"), "文案: {err}");
        // 目标无残留：db / settings / marker / staging 都没有；新建的空目录也收回。
        assert!(!to.join(DB_NAME).exists());
        assert!(!to.join(SETTINGS_NAME).exists());
        assert!(!to.join(MARKER_NAME).exists());
        assert!(!to.join(STAGING_DIR).exists());
        assert!(!to.exists(), "失败后目标目录不应有残留");
        // 旧目录原样保留。
        assert!(from.join(DB_NAME).is_file());
    }

    #[test]
    fn force_allows_remigration_when_source_changed() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let from = tmp.path().join("legacy");
        let to = tmp.path().join("data");
        let src_conn = legacy_source(&from);

        let first = migrate_legacy_data(&from, &to, &MigrateOptions::default()).expect("首次迁移");
        let first_target_sha = sha256_file(&to.join(DB_NAME)).expect("目标哈希");
        assert_eq!(first_target_sha, first.target_db_sha256);

        // 迁移后旧端又被写过（来源指纹变化）。
        src_conn
            .execute(
                "INSERT INTO read_cache(key, payload, fetched_at) VALUES ('article:anon:99', '{}', 2000)",
                [],
            )
            .expect("改源库");

        // 无 force：拒绝，目标一个字节都不动。
        let err = migrate_legacy_data(&from, &to, &MigrateOptions::default())
            .expect_err("源变了且无 force 应拒绝");
        assert_eq!(err.code(), "app");
        assert!(err.to_string().contains("又被修改过"), "文案: {err}");
        assert_eq!(
            sha256_file(&to.join(DB_NAME)).expect("目标哈希"),
            first_target_sha,
            "拒绝路径不应改目标库"
        );

        // 有 force：用当前源重新迁移，行数跟着变。
        let forced = migrate_legacy_data(
            &from,
            &to,
            &MigrateOptions {
                force: true,
                dry_run: false,
            },
        )
        .expect("force 重迁失败");
        assert_eq!(forced.status, MigrationStatus::Migrated);
        assert_eq!(forced.rows.read_cache, 19);
        assert_ne!(forced.target_db_sha256, first.target_db_sha256);

        // 再 force 一次仍然成功（幂等 + force 语义：重复运行不改坏结果）。
        let again = migrate_legacy_data(
            &from,
            &to,
            &MigrateOptions {
                force: true,
                dry_run: false,
            },
        )
        .expect("再次 force 迁移失败");
        assert_eq!(again.status, MigrationStatus::Migrated);
        assert_eq!(again.rows.read_cache, 19);
    }

    #[test]
    fn source_modified_during_migration_aborts_without_landing() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let from = tmp.path().join("legacy");
        let to = tmp.path().join("data");
        let _src_conn = legacy_source(&from);
        let src_db = from.join(DB_NAME);

        // 模拟「复制已经做完、落盘之前，旧端进程又写了一次源库」。
        let result =
            migrate_legacy_data_with_hook(&from, &to, &MigrateOptions::default(), &mut || {
                let conn = Connection::open(&src_db).expect("打开源库");
                conn.execute("INSERT INTO meta(key, value) VALUES ('oops', '1')", [])
                    .expect("改源库");
            });

        let err = result.expect_err("源在迁移期间变了，必须报错");
        assert_eq!(err.code(), "app");
        assert!(err.to_string().contains("迁移过程中被修改"), "文案: {err}");
        // 「目标不落盘」：db / settings / marker / staging 都没有。
        assert!(!to.join(DB_NAME).exists());
        assert!(!to.join(MARKER_NAME).exists());
        assert!(!to.join(STAGING_DIR).exists());
        assert!(!to.exists());
        assert!(from.join(DB_NAME).is_file(), "旧目录必须原样保留");
    }

    #[test]
    fn missing_legacy_db_is_a_no_op() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let from = tmp.path().join("legacy"); // 不存在
        let to = tmp.path().join("data");

        let report = migrate_legacy_data(&from, &to, &MigrateOptions::default())
            .expect("无旧库不应报错（启动时可无条件调用）");
        assert_eq!(report.status, MigrationStatus::NoSource);
        assert!(!to.exists(), "无旧库时不应创建目标目录");
        assert_eq!(report.rows.read_cache, 0);
        assert!(!report.verified_without_wal);
    }

    #[test]
    fn broken_settings_is_skipped_with_warning_but_migration_succeeds() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let from = tmp.path().join("legacy");
        let to = tmp.path().join("data");
        let _src_conn = legacy_source(&from);
        fs::write(from.join(SETTINGS_NAME), b"{ this is not json").expect("写坏 settings");

        let report = migrate_legacy_data(&from, &to, &MigrateOptions::default())
            .expect("settings 损坏不应阻断迁移");
        assert_eq!(report.status, MigrationStatus::Migrated);
        assert_eq!(report.rows.read_cache, 18);
        assert!(
            !to.join(SETTINGS_NAME).exists(),
            "坏 settings 不复制，新端用默认值"
        );
        assert!(
            report.warnings.iter().any(|w| w.contains("settings.json")),
            "warnings: {:?}",
            report.warnings
        );
        // warnings 也进 marker，方便事后排查。
        let marker: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(to.join(MARKER_NAME)).expect("读 marker"))
                .expect("marker JSON");
        assert!(!marker["warnings"].as_array().unwrap().is_empty());
    }

    #[test]
    fn refuses_to_overwrite_target_db_without_marker_unless_forced() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let from = tmp.path().join("legacy");
        let to = tmp.path().join("data");
        let _src_conn = legacy_source(&from);

        // 目标已有库但没有 migration.json（例如 marker 写失败后又崩了）。
        fs::create_dir_all(&to).expect("建目标目录");
        let foreign = to.join(DB_NAME);
        fs::write(&foreign, b"not a real db").expect("写占位库");

        let err = migrate_legacy_data(&from, &to, &MigrateOptions::default())
            .expect_err("无标记的目标库应拒绝覆盖");
        assert_eq!(err.code(), "app");
        assert!(err.to_string().contains("拒绝覆盖"), "文案: {err}");
        assert_eq!(fs::read(&foreign).expect("占位库"), b"not a real db");

        // force：覆盖并补写标记。
        let forced = migrate_legacy_data(
            &from,
            &to,
            &MigrateOptions {
                force: true,
                dry_run: false,
            },
        )
        .expect("force 覆盖失败");
        assert_eq!(forced.status, MigrationStatus::Migrated);
        assert_eq!(forced.rows.read_cache, 18);
        assert!(to.join(MARKER_NAME).is_file());
    }
}
