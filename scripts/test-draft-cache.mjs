/**
 * 未提交草稿缓存（renderer `lib/draftCache.ts`）回归：
 * key 分区（类别/账号/文章/细分）、写读往返、账号隔离、过期与超限淘汰、
 * 损坏数据与 localStorage 不可用时的兜底。
 */
import assert from 'node:assert/strict'

/** 最小 localStorage 替身（含失效开关，用于验证兜底路径） */
class MemoryStorage {
  #map = new Map()
  /** true 时所有写操作抛错（模拟容量超限） */
  failWrites = false
  /** true 时所有读操作抛错（模拟 localStorage 不可用） */
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

const {
  DRAFT_TTL_MS,
  DEFAULT_REVIEW_SCORE,
  clearDraft,
  draftStorageKey,
  emptyReviewDraft,
  isEmptyCommentDraft,
  isEmptyReviewDraft,
  pruneDrafts,
  readCommentDraft,
  readReviewDraft,
  sameReviewDraft,
  writeDraft
} = await import('../src/renderer/src/lib/draftCache.ts')

const draft = (over = {}) => ({
  ...emptyReviewDraft(),
  dianzi: '设定自洽',
  dianziScore: 8,
  ...over
})

/* ---- key 分区：类别 / 账号 / 文章 / 细分互不覆盖 ---- */
const base = { kind: 'review', uid: '7', cid: '11', sub: 'new' }
assert.equal(draftStorageKey(base), 'hqsf-draft:review:7:11:new')
assert.equal(draftStorageKey({ ...base, sub: 'edit:33' }), 'hqsf-draft:review:7:11:edit:33')
assert.equal(draftStorageKey({ ...base, kind: 'comment' }), 'hqsf-draft:comment:7:11:new')
// 评审内嵌评论框按评审 id 细分
assert.equal(
  draftStorageKey({ kind: 'review-comment', uid: '7', cid: '11', sub: '77' }),
  'hqsf-draft:review-comment:7:11:77'
)
assert.equal(draftStorageKey({ ...base, cid: '12' }), 'hqsf-draft:review:7:12:new')
assert.equal(draftStorageKey({ ...base, uid: '8' }), 'hqsf-draft:review:8:11:new')
// 未登录归入 anon 分区，不与任何真实 uid 混用
assert.equal(draftStorageKey({ ...base, uid: '' }), 'hqsf-draft:review:anon:11:new')
assert.equal(draftStorageKey({ ...base, uid: null }), 'hqsf-draft:review:anon:11:new')

/* ---- 评审草稿写读往返 ---- */
writeDraft(base, draft())
assert.deepEqual(readReviewDraft(base), draft())
// 未写过的定位读不到（不串到别的文章/账号）
assert.equal(readReviewDraft({ ...base, cid: '99' }), null)
assert.equal(readReviewDraft({ ...base, uid: '8' }), null)
assert.equal(readCommentDraft({ ...base, kind: 'comment' }), null)

/* ---- 编辑态与新评审互不覆盖 ---- */
const editRef = { ...base, sub: 'edit:33' }
writeDraft(editRef, draft({ zonghe: '编辑中的修改' }))
assert.equal(readReviewDraft(base).zonghe, '')
assert.equal(readReviewDraft(editRef).zonghe, '编辑中的修改')

/* ---- 评论草稿（正文 + 回复目标）写读往返 ---- */
const commentRef = { kind: 'comment', uid: '7', cid: '11' }
writeDraft(commentRef, { text: '写到一半的评论', parent: '88', parentAuthor: '某人' })
assert.deepEqual(readCommentDraft(commentRef), { text: '写到一半的评论', parent: '88', parentAuthor: '某人' })
// 老格式（缺 parent/parentAuthor）按空值补齐，不整条丢弃
storage.setItem(draftStorageKey(commentRef), JSON.stringify({ v: { text: '旧数据' }, at: Date.now() }))
assert.deepEqual(readCommentDraft(commentRef), { text: '旧数据', parent: '', parentAuthor: '' })

/* ---- 清除 ---- */
writeDraft(commentRef, { text: '待清除', parent: '', parentAuthor: '' })
clearDraft(commentRef)
assert.equal(readCommentDraft(commentRef), null)

/* ---- 损坏数据：读回 null 并顺手清掉 ---- */
const reviewKey = draftStorageKey(base)
storage.setItem(reviewKey, '{ 不是 JSON')
assert.equal(readReviewDraft(base), null)
assert.equal(storage.getItem(reviewKey), null)
// 结构不合法（缺字段/类型错）同样丢弃
storage.setItem(reviewKey, JSON.stringify({ v: { dianzi: '只有一段' }, at: Date.now() }))
assert.equal(readReviewDraft(base), null)
assert.equal(storage.getItem(reviewKey), null)

/* ---- 过期（30 天未编辑）：读回 null 并删除；写入时顺带清理 ---- */
storage.setItem(reviewKey, JSON.stringify({ v: draft(), at: Date.now() - DRAFT_TTL_MS - 1000 }))
assert.equal(readReviewDraft(base), null)
assert.equal(storage.getItem(reviewKey), null)
writeDraft(base, draft({ zonghe: '刚写的' }))
storage.setItem(draftStorageKey(editRef), JSON.stringify({ v: draft(), at: Date.now() - DRAFT_TTL_MS - 1000 }))
storage.setItem('hqsf-unrelated', 'keep-me')
assert.ok(pruneDrafts() >= 1)
assert.equal(readReviewDraft(editRef), null)
assert.equal(readReviewDraft(base).zonghe, '刚写的') // 未过期的保留
assert.equal(storage.getItem('hqsf-unrelated'), 'keep-me') // 非草稿键不动

/* ---- 超限（>200 条）淘汰最久未编辑的 ---- */
storage.clear()
const t0 = Date.now() - 500
for (let i = 0; i < 201; i++) {
  const ref = { kind: 'comment', uid: '7', cid: String(i) }
  storage.setItem(draftStorageKey(ref), JSON.stringify({ v: { text: `第${i}条` }, at: t0 + i }))
}
assert.equal(pruneDrafts(t0 + 201), 1)
assert.equal(storage.getItem(draftStorageKey({ kind: 'comment', uid: '7', cid: '0' })), null) // 最旧的一条被淘汰
assert.deepEqual(readCommentDraft({ kind: 'comment', uid: '7', cid: '200' }), {
  text: '第200条',
  parent: '',
  parentAuthor: ''
})

/* ---- 写失败（容量超限）与 localStorage 不可用：静默兜底，不抛错 ---- */
storage.clear()
storage.failWrites = true
writeDraft(base, draft()) // 不应抛错
assert.equal(storage.length, 0)
storage.failWrites = false
storage.failReads = true
assert.equal(readReviewDraft(base), null) // 读不可用按无草稿处理
assert.equal(readCommentDraft(commentRef), null)
storage.failReads = false
clearDraft(base) // 未缓存的清除也应安全

/* ---- 表单判定：空表单不算草稿、与基线一致不算未提交 ---- */
assert.equal(isEmptyReviewDraft(emptyReviewDraft()), true)
assert.equal(isEmptyReviewDraft(draft()), false)
assert.equal(isEmptyReviewDraft({ ...emptyReviewDraft(), dianziScore: 6 }), false) // 只动了滑杆也算未提交的输入
assert.equal(isEmptyReviewDraft({ ...emptyReviewDraft(), zonghe: '   ' }), true) // 纯空白不算
assert.equal(sameReviewDraft(draft(), draft({ dianzi: '改了' })), false)
assert.equal(sameReviewDraft(draft(), draft()), true)
assert.equal(DEFAULT_REVIEW_SCORE, 5)
assert.equal(isEmptyCommentDraft({ text: '  ', parent: '', parentAuthor: '' }), true)
assert.equal(isEmptyCommentDraft({ text: '', parent: '88', parentAuthor: '某人' }), false) // 只选了回复对象也算草稿

console.log('draft cache: all assertions passed')
