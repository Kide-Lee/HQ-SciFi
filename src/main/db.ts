import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import type { ArticleRow, ArticleType } from '../shared/types'

/**
 * 本地 SQLite 索引（design.md 数据同步章节）。
 * 只存文章元数据/状态索引，不存正文 —— 正文始终是磁盘上的 .md 文件。
 * 主进程同步 API（better-sqlite3 同步调用，仅主进程使用）。
 */

interface ArticleRowDb {
  cid: string
  title: string
  type: string
  status: string
  author_id: string
  remote_modified: number
  local_modified: number
  content_hash: string
  file_path: string
  synced_at: number
  created_at: number
  updated_at: number
}

let db: Database.Database | null = null

const SCHEMA = `
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
`

function toRow(r: ArticleRowDb): ArticleRow {
  return {
    cid: r.cid,
    title: r.title,
    type: r.type as ArticleType,
    status: r.status,
    authorId: r.author_id,
    remoteModified: r.remote_modified,
    localModified: r.local_modified,
    contentHash: r.content_hash,
    filePath: r.file_path,
    syncedAt: r.synced_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function toDb(a: ArticleRow): ArticleRowDb {
  return {
    cid: a.cid,
    title: a.title,
    type: a.type,
    status: a.status,
    author_id: a.authorId,
    remote_modified: a.remoteModified,
    local_modified: a.localModified,
    content_hash: a.contentHash,
    file_path: a.filePath,
    synced_at: a.syncedAt,
    created_at: a.createdAt,
    updated_at: a.updatedAt
  }
}

/** 应用启动时调用一次（主进程） */
export function initDb(): void {
  if (db) return
  const dir = app.getPath('userData')
  const file = join(dir, 'hqsf.db')
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
}

export function getDb(): Database.Database {
  if (!db) throw new Error('数据库未初始化（initDb 未调用）')
  return db
}

export function upsertArticle(a: ArticleRow): void {
  const d = toDb(a)
  getDb()
    .prepare(
      `INSERT INTO articles (cid, title, type, status, author_id, remote_modified, local_modified,
        content_hash, file_path, synced_at, created_at, updated_at)
       VALUES (@cid, @title, @type, @status, @author_id, @remote_modified, @local_modified,
        @content_hash, @file_path, @synced_at, @created_at, @updated_at)
       ON CONFLICT(cid) DO UPDATE SET
        title=excluded.title, type=excluded.type, status=excluded.status, author_id=excluded.author_id,
        remote_modified=excluded.remote_modified, local_modified=excluded.local_modified,
        content_hash=excluded.content_hash, file_path=excluded.file_path, synced_at=excluded.synced_at,
        updated_at=excluded.updated_at`
    )
    .run(d)
}

/** 按远端 cid 更新（本地未同步草稿 cid 为空，用 file_path 定位） */
export function updateArticleByCid(cid: string, patch: Partial<ArticleRow>): void {
  const existing = getArticleByCid(cid)
  if (!existing) return
  upsertArticle({ ...existing, ...patch, updatedAt: Date.now() })
}

export function listArticles(type?: ArticleType): ArticleRow[] {
  if (type) {
    return (getDb()
      .prepare('SELECT * FROM articles WHERE type = ? ORDER BY updated_at DESC')
      .all(type) as ArticleRowDb[]).map(toRow)
  }
  return (getDb().prepare('SELECT * FROM articles ORDER BY updated_at DESC').all() as ArticleRowDb[]).map(toRow)
}

export function getArticleByCid(cid: string): ArticleRow | null {
  const r = getDb().prepare('SELECT * FROM articles WHERE cid = ?').get(cid) as ArticleRowDb | undefined
  return r ? toRow(r) : null
}

export function getArticleByFilePath(filePath: string): ArticleRow | null {
  const r = getDb().prepare('SELECT * FROM articles WHERE file_path = ?').get(filePath) as ArticleRowDb | undefined
  return r ? toRow(r) : null
}

/** 按 file_path 定位（本地草稿或已关联远端文章）并更新 */
export function updateArticleByFilePath(filePath: string, patch: Partial<ArticleRow>): void {
  const existing = getArticleByFilePath(filePath)
  if (!existing) return
  upsertArticle({ ...existing, ...patch, updatedAt: Date.now() })
}

export function deleteArticleByCid(cid: string): void {
  getDb().prepare('DELETE FROM articles WHERE cid = ?').run(cid)
}

export function setMeta(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value)
}

export function getMeta(key: string): string | null {
  const r = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return r ? r.value : null
}

// ---------- 阅读缓存（M2：文章详情本地缓存） ----------
// 缓存 1 天未使用即丢弃：fetched_at 兼作「最后使用时间」，读取命中即刷新；
// 另设容量上限，超限时按最后使用时间从旧到新删最旧。

/** 缓存有效期：超过该时长未使用即丢弃（24 小时） */
const READ_CACHE_TTL_MS = 24 * 60 * 60 * 1000
/** 命中刷新节流：距上次刷新超过该时长才落盘（避免每次读都写 SQLite） */
const READ_CACHE_TOUCH_INTERVAL_MS = 5 * 60 * 1000
/** 文章缓存总容量上限（16MB，足够容纳大量文章正文） */
const READ_CACHE_MAX_BYTES = 16 * 1024 * 1024
/** 清理时保留的目标水位（低于上限的 80%，避免频繁触发清理） */
const READ_CACHE_TARGET = Math.floor(READ_CACHE_MAX_BYTES * 0.8)

/** 读取缓存；过期（1 天未使用）则删除并返回 null；命中节流刷新最后使用时间 */
export function getReadCache<T>(key: string): T | null {
  const r = getDb().prepare('SELECT payload, fetched_at FROM read_cache WHERE key = ?').get(key) as
    | { payload: string; fetched_at: number }
    | undefined
  if (!r) return null
  const now = Date.now()
  if (now - r.fetched_at > READ_CACHE_TTL_MS) {
    deleteReadCache(key)
    return null
  }
  // 命中即视为使用；节流刷新最后使用时间（读路径不频繁写盘，TTL 判定最多偏差 5 分钟）
  if (now - r.fetched_at > READ_CACHE_TOUCH_INTERVAL_MS) {
    getDb().prepare('UPDATE read_cache SET fetched_at = ? WHERE key = ?').run(now, key)
  }
  try {
    return JSON.parse(r.payload) as T
  } catch {
    // 损坏条目直接丢弃
    deleteReadCache(key)
    return null
  }
}

/** 删除单条阅读缓存（检测到文章隐藏/未公开时立刻调用） */
export function deleteReadCache(key: string): void {
  getDb().prepare('DELETE FROM read_cache WHERE key = ?').run(key)
}

/** 写入阅读缓存；同时清除全部过期条目；超容量上限时按最后使用时间从旧到新删除 */
export function setReadCache(key: string, payload: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO read_cache (key, payload, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at`
    )
    .run(key, JSON.stringify(payload), Date.now())
  getDb().prepare('DELETE FROM read_cache WHERE fetched_at < ?').run(Date.now() - READ_CACHE_TTL_MS)
  trimReadCache()
}

/** 总字节超限时按最后使用时间删除最旧条目（逐条删，避免一次删太多） */
function trimReadCache(): void {
  for (;;) {
    const row = getDb()
      .prepare('SELECT COALESCE(SUM(LENGTH(payload)), 0) AS total FROM read_cache')
      .get() as { total: number }
    if (row.total <= READ_CACHE_TARGET) return
    const oldest = getDb()
      .prepare('SELECT key FROM read_cache ORDER BY fetched_at ASC LIMIT 1')
      .get() as { key: string } | undefined
    if (!oldest) return
    getDb().prepare('DELETE FROM read_cache WHERE key = ?').run(oldest.key)
  }
}
