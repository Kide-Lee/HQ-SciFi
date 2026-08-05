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

// ---------- 阅读缓存（M2：文章详情本地缓存，带 TTL） ----------

/** 读取未过期缓存；过期/不存在返回 null */
export function getReadCache<T>(key: string, ttlMs: number): T | null {
  const r = getDb().prepare('SELECT payload, fetched_at FROM read_cache WHERE key = ?').get(key) as
    | { payload: string; fetched_at: number }
    | undefined
  if (!r) return null
  if (Date.now() - r.fetched_at > ttlMs) return null
  try {
    return JSON.parse(r.payload) as T
  } catch {
    return null
  }
}

/** 写入阅读缓存 */
export function setReadCache(key: string, payload: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO read_cache (key, payload, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at`
    )
    .run(key, JSON.stringify(payload), Date.now())
}
