/**
 * v1.1.12：未提交的评审 / 评论草稿缓存（localStorage）。
 *
 * 阅读页的评审表单与评论框都挂在右栏 tab 内容里：切 tab、收起右栏、切换文章、
 * 关闭阅读态都会卸载组件，纯 `useState` 的输入随之丢失；刷新与重启更是全部清空。
 * 本模块把未提交的输入按「类别 + 账号 + 文章 + 细分」即时写入 localStorage：
 *
 * - 写入是同步的（每次变更立即落盘），刷新 / 重启 / 换视图后原样恢复；
 * - 成功提交后由调用方显式清除（`clearDraft`），不留陈旧草稿；
 * - 保留 30 天（按最后一次编辑时间计），总条数设上限，超限淘汰最久未编辑的；
 *   恢复时会把同一份内容写回，等效于刷新保留期（与阅读缓存「命中即刷新最后使用时间」一致）；
 * - key 并入账号 uid：同一台机器切换账号不会串草稿。
 *
 * 只缓存「未提交的输入」，不参与阅读缓存 / 图片缓存 / 「设置→清除缓存」的管理范围。
 */

/** 草稿类别 */
export type DraftKind =
  /** 评审表单（五维评语 + 五维评分 + 综合评价） */
  | 'review'
  /** 文章评论区发表框 */
  | 'comment'
  /** 评审卡片内嵌评论框（按评审 id 细分） */
  | 'review-comment'

/** 草稿定位（决定 localStorage key） */
export interface DraftRef {
  kind: DraftKind
  /** 账号 uid（''/null = 未登录，归入 anon 分区） */
  uid?: string | number | null
  /** 文章 cid */
  cid: string
  /** 细分标识：评审表单为 `new` 或 `edit:<评审 id>`；评论框留空 */
  sub?: string
}

/** 评审表单草稿（与 ReviewForm 表单同构） */
export interface ReviewDraft {
  dianzi: string
  wenbi: string
  renwu: string
  jiezou: string
  liyi: string
  zonghe: string
  dianziScore: number
  wenbiScore: number
  renwuScore: number
  jiezouScore: number
  liyiScore: number
}

/** 评论框草稿（正文 + 回复目标；回复目标随正文一起缓存，避免恢复后丢「回复 @某人」语境） */
export interface CommentDraft {
  text: string
  /** 回复目标评论 coid（''=顶层评论） */
  parent: string
  /** 回复目标显示名（仅用于回复框占位文案） */
  parentAuthor: string
}

/** 五维评语字段 */
export const REVIEW_TEXT_KEYS = ['dianzi', 'wenbi', 'renwu', 'jiezou', 'liyi', 'zonghe'] as const
/** 五维评分字段（综合评价无评分） */
export const REVIEW_SCORE_KEYS = [
  'dianziScore',
  'wenbiScore',
  'renwuScore',
  'jiezouScore',
  'liyiScore'
] as const
/** 评分滑杆默认值（与评审表单初始值一致） */
export const DEFAULT_REVIEW_SCORE = 5

/** 草稿保留时长：30 天未编辑即丢弃 */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000

const PREFIX = 'hqsf-draft:'
/** 草稿条数上限（防长期堆积；超限淘汰最久未编辑的） */
const MAX_DRAFTS = 200
/** 全量清理节流：避免每次按键都扫描全部 key */
const PRUNE_INTERVAL_MS = 60 * 1000

let lastPruneAt = 0

/** 草稿的 localStorage key（同时用于判重：同 key 才算同一份草稿） */
export function draftStorageKey(ref: DraftRef): string {
  const uid = ref.uid == null || ref.uid === '' ? 'anon' : String(ref.uid)
  return `${PREFIX}${ref.kind}:${uid}:${ref.cid}:${ref.sub ?? ''}`
}

/** 空白评审表单 */
export function emptyReviewDraft(): ReviewDraft {
  return {
    dianzi: '',
    wenbi: '',
    renwu: '',
    jiezou: '',
    liyi: '',
    zonghe: '',
    dianziScore: DEFAULT_REVIEW_SCORE,
    wenbiScore: DEFAULT_REVIEW_SCORE,
    renwuScore: DEFAULT_REVIEW_SCORE,
    jiezouScore: DEFAULT_REVIEW_SCORE,
    liyiScore: DEFAULT_REVIEW_SCORE
  }
}

/** 两份评审表单是否完全一致（编辑态用于判断「与已有评审无差别」） */
export function sameReviewDraft(a: ReviewDraft, b: ReviewDraft): boolean {
  return (
    REVIEW_TEXT_KEYS.every((k) => a[k] === b[k]) && REVIEW_SCORE_KEYS.every((k) => a[k] === b[k])
  )
}

/** 空评审表单（未填任何评语且评分全为默认值）——此时没有可缓存的输入 */
export function isEmptyReviewDraft(d: ReviewDraft): boolean {
  return REVIEW_TEXT_KEYS.every((k) => d[k].trim() === '') &&
    REVIEW_SCORE_KEYS.every((k) => d[k] === DEFAULT_REVIEW_SCORE)
}

/** 评论框是否没有实质内容（正文空白且未选回复对象）——此时不缓存 */
export function isEmptyCommentDraft(d: CommentDraft): boolean {
  return d.text.trim() === '' && d.parent === ''
}

function isReviewDraft(v: unknown): v is ReviewDraft {
  if (typeof v !== 'object' || v === null) return false
  const d = v as Record<string, unknown>
  return (
    REVIEW_TEXT_KEYS.every((k) => typeof d[k] === 'string') &&
    REVIEW_SCORE_KEYS.every((k) => typeof d[k] === 'number' && Number.isFinite(d[k]))
  )
}

function isCommentDraft(v: unknown): v is CommentDraft {
  if (typeof v !== 'object' || v === null) return false
  const d = v as Record<string, unknown>
  return typeof d.text === 'string'
}

/** 读取并校验一条草稿；过期 / 损坏则删除并返回 null */
function readEntry<T>(key: string, valid: (v: unknown) => v is T): T | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(key)
  } catch {
    return null // localStorage 不可用：按无草稿处理，不影响正常输入
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; at?: unknown }
    const at = Number(parsed?.at)
    if (!Number.isFinite(at) || Date.now() - at > DRAFT_TTL_MS) {
      localStorage.removeItem(key)
      return null
    }
    if (!valid(parsed.v)) {
      localStorage.removeItem(key)
      return null
    }
    return parsed.v
  } catch {
    try {
      localStorage.removeItem(key)
    } catch {
      /* 忽略：清理失败不影响读取结果 */
    }
    return null
  }
}

/** 读取评审表单草稿 */
export function readReviewDraft(ref: DraftRef): ReviewDraft | null {
  return readEntry(draftStorageKey(ref), isReviewDraft)
}

/** 读取评论框草稿（缺失字段按空值补齐） */
export function readCommentDraft(ref: DraftRef): CommentDraft | null {
  const d = readEntry(draftStorageKey(ref), isCommentDraft)
  if (!d) return null
  return {
    text: d.text,
    parent: typeof d.parent === 'string' ? d.parent : '',
    parentAuthor: typeof d.parentAuthor === 'string' ? d.parentAuthor : ''
  }
}

/** 写入草稿（同步落盘；容量超限等失败静默，不影响正常输入与提交） */
export function writeDraft<T>(ref: DraftRef, value: T): void {
  try {
    localStorage.setItem(draftStorageKey(ref), JSON.stringify({ v: value, at: Date.now() }))
  } catch {
    return
  }
  if (Date.now() - lastPruneAt >= PRUNE_INTERVAL_MS) pruneDrafts()
}

/** 清除一条草稿（提交成功后调用） */
export function clearDraft(ref: DraftRef): void {
  try {
    localStorage.removeItem(draftStorageKey(ref))
  } catch {
    /* 忽略：清理失败不影响提交流程 */
  }
}

function allDraftKeys(): string[] {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith(PREFIX)) keys.push(k)
  }
  return keys
}

/** 清理过期与超限草稿，返回删除条数 */
export function pruneDrafts(now: number = Date.now()): number {
  lastPruneAt = now
  let keys: string[]
  try {
    keys = allDraftKeys()
  } catch {
    return 0
  }
  let removed = 0
  const alive: Array<{ key: string; at: number }> = []
  for (const key of keys) {
    let at = NaN
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? '') as { at?: unknown }
      at = Number(parsed?.at)
    } catch {
      at = NaN
    }
    if (!Number.isFinite(at) || now - at > DRAFT_TTL_MS) {
      try {
        localStorage.removeItem(key)
        removed++
      } catch {
        /* 忽略 */
      }
      continue
    }
    alive.push({ key, at })
  }
  if (alive.length > MAX_DRAFTS) {
    alive.sort((a, b) => a.at - b.at)
    for (const e of alive.slice(0, alive.length - MAX_DRAFTS)) {
      try {
        localStorage.removeItem(e.key)
        removed++
      } catch {
        /* 忽略 */
      }
    }
  }
  return removed
}
