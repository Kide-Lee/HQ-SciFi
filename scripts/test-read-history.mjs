/**
 * 阅读历史纯逻辑与持久化（renderer `lib/readHistory.ts`）回归：
 * 条目包装（cid 取快照）、同篇去重置顶、条数上限淘汰、
 * localStorage 读写 / 旧格式兼容 / 损坏与不可用时的兜底。
 *
 * store 侧的胶水（详情 → 列表快照：作者匿名脱敏、摘要截断）由 GUI 实测覆盖。
 */
import assert from 'node:assert/strict'

/** 最小 localStorage 替身（含失效开关，用于验证兜底路径） */
class MemoryStorage {
  #map = new Map()
  failWrites = false
  failReads = false
  get length() {
    return this.#map.size
  }
  key(i) {
    return [...this.#map.keys()][i] ?? null
  }
  getItem(k) {
    if (this.failReads) throw new Error('read blocked')
    return this.#map.has(k) ? this.#map.get(k) : null
  }
  setItem(k, v) {
    if (this.failWrites) throw new Error('quota exceeded')
    this.#map.set(k, String(v))
  }
  removeItem(k) {
    this.#map.delete(k)
  }
  clear() {
    this.#map.clear()
  }
}

const storage = new MemoryStorage()
globalThis.localStorage = storage

const { HISTORY_KEY, HISTORY_MAX, loadHistory, makeHistoryEntry, saveHistory, upsertHistory } =
  await import('../src/renderer/src/lib/readHistory.ts')

/** 列表字段快照最小样本（ArticleCard 渲染所需的必填字段） */
const article = (over = {}) => ({
  cid: '101',
  title: '第一篇',
  text: '摘要文本',
  type: 'post',
  status: 'publish',
  score: '7.5',
  authorId: '9',
  views: 3,
  likes: 1,
  commentsNum: 2,
  created: 100,
  modified: 100,
  ...over
})

/* ---- 条目包装：cid 取自快照 ---- */
const entry = makeHistoryEntry(article(), 1700, 3)
assert.deepEqual(
  { cid: entry.cid, readAt: entry.readAt, count: entry.count, title: entry.article.title },
  { cid: '101', readAt: 1700, count: 3, title: '第一篇' }
)
assert.equal(makeHistoryEntry(article({ cid: 202 }), 1).cid, '202') // cid 统一为字符串
assert.equal(makeHistoryEntry(article({ cid: 202 }), 1).article.cid, 202) // 快照原样保留

/* ---- 去重置顶 ---- */
let entries = []
entries = upsertHistory(entries, makeHistoryEntry(article(), 1000))
entries = upsertHistory(entries, makeHistoryEntry(article({ cid: '202', title: '第二篇' }), 2000))
assert.deepEqual(entries.map((e) => e.cid), ['202', '101'])
entries = upsertHistory(entries, makeHistoryEntry(article({ title: '第一篇（改过标题）' }), 3000, 2))
assert.deepEqual(
  entries.map((e) => [e.cid, e.count, e.readAt]),
  [
    ['101', 2, 3000],
    ['202', 1, 2000]
  ]
)
assert.equal(entries.length, 2) // 不产生重复条目
assert.equal(entries[0].article.title, '第一篇（改过标题）') // 快照随最近一次打开刷新

/* ---- 条数上限：超出淘汰最久未读的 ---- */
let many = []
for (let i = 0; i < HISTORY_MAX + 5; i++) {
  many = upsertHistory(many, makeHistoryEntry(article({ cid: String(i), title: `第 ${i} 篇` }), 1000 + i))
}
assert.equal(many.length, HISTORY_MAX)
assert.equal(many[0].cid, String(HISTORY_MAX + 4)) // 最新在最前
assert.equal(many.some((e) => e.cid === '4'), false) // 最早的 5 条被淘汰

/* ---- 持久化往返 ---- */
assert.deepEqual(loadHistory(), []) // 尚未落盘
saveHistory(many)
assert.equal(loadHistory().length, HISTORY_MAX)
assert.equal(loadHistory()[0].cid, many[0].cid)
assert.equal(loadHistory()[0].article.title, many[0].article.title)
assert.equal(JSON.parse(storage.getItem(HISTORY_KEY)).length, HISTORY_MAX)

/* ---- 损坏 / 信封 / 脏条目 ---- */
storage.setItem(HISTORY_KEY, '{ 不是 JSON')
assert.deepEqual(loadHistory(), [])
storage.setItem(HISTORY_KEY, JSON.stringify({ entries: [makeHistoryEntry(article({ cid: '7' }), 5)] }))
assert.equal(loadHistory()[0].cid, '7') // 兼容 { entries: [...] } 信封
storage.setItem(HISTORY_KEY, JSON.stringify({ nope: 1 }))
assert.deepEqual(loadHistory(), [])
storage.setItem(
  HISTORY_KEY,
  JSON.stringify([
    // 早期扁平格式（只有 title/author/score，没有 article 快照）→ 丢弃
    { cid: '1', title: '旧扁平格式', author: '甲', score: '7', category: '连载', readAt: 1, count: 1 },
    makeHistoryEntry(article({ cid: '2' }), 5), // 合法
    { cid: '3', readAt: 5, article: { title: '缺 cid' } }, // 快照缺 cid → 丢弃
    { cid: '4', readAt: 'x', article: article({ cid: '4' }) }, // readAt 非法 → 丢弃
    'junk',
    null
  ])
)
assert.deepEqual(loadHistory().map((e) => e.cid), ['2'])

/* ---- 缺字段就地补齐（旧快照不让卡片渲染崩） ---- */
storage.setItem(
  HISTORY_KEY,
  JSON.stringify([{ cid: '4', readAt: 9, count: 0, article: { cid: '4', title: '缺字段' } }])
)
const fixed = loadHistory()[0]
assert.deepEqual(
  {
    count: fixed.count,
    title: fixed.article.title,
    text: fixed.article.text,
    type: fixed.article.type,
    status: fixed.article.status,
    score: fixed.article.score,
    authorId: fixed.article.authorId,
    views: fixed.article.views,
    likes: fixed.article.likes,
    commentsNum: fixed.article.commentsNum,
    created: fixed.article.created,
    modified: fixed.article.modified
  },
  {
    count: 1,
    title: '缺字段',
    text: '',
    type: 'post',
    status: '',
    score: '',
    authorId: '',
    views: 0,
    likes: 0,
    commentsNum: 0,
    created: 0,
    modified: 0
  }
)

/* ---- 不可用：读/写都不抛错 ---- */
storage.failReads = true
assert.deepEqual(loadHistory(), [])
storage.failReads = false
storage.failWrites = true
saveHistory([makeHistoryEntry(article(), 1)]) // 不应抛错
storage.failWrites = false

console.log('read history: all assertions passed')
