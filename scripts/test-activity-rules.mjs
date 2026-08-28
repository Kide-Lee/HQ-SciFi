/**
 * 高风险纯函数回归测试：活动期评分隔离、评审脱敏、评论脱敏。
 * 运行：node --experimental-strip-types scripts/test-activity-rules.mjs
 */
import assert from 'node:assert/strict'
import {
  sanitizeArticleList,
  sanitizeReviewList,
  sanitizeCommentList
} from '../src/main/domain/activity-rules.ts'

// 1. 文章列表脱敏
const articles = [
  { cid: 'a1', score: '8.5', active: [{ mid: 10, name: '第10期' }], authorInfo: { uid: '123', name: '作者A', avatar: 'https://x/a.png' } },
  { cid: 'a2', score: '9.0', active: [{ mid: 99, name: '结束活动' }], authorInfo: { uid: '456', name: '作者B', avatar: 'https://x/b.png' } }
]
sanitizeArticleList(articles, new Set(['10']))
assert.equal(articles[0].score, '-.-')
assert.equal(articles[0].hideScore, true)
assert.equal(articles[0].authorInfo.name, '匿名用户')
assert.equal(articles[1].score, '9.0', '未命中活动不应脱敏')

// 2. 评审列表：自己的保留，他人活动隐藏
const reviews = [
  { id: 1, uid: 'u1', activeid: 10, actualscore: '8.0', score: '8,8,8,8,8', hideScore: false },
  { id: 2, uid: 'u2', activeid: 10, actualscore: '7.5', score: '7,8,7,8,8', hideScore: false },
  { id: 3, uid: 'u1', activeid: 99, actualscore: '9.0', score: '9,9,9,9,9', hideScore: false }
]
sanitizeReviewList(reviews, new Set(['10']), 'u1')
assert.equal(reviews[0].actualscore, '8.0')
assert.equal(reviews[1].actualscore, '-.-')
assert.equal(reviews[1].score, '-.-,-.-,-.-,-.-,-.-')
assert.equal(reviews[2].actualscore, '9.0')

// 3. 评论列表：过滤占位 + 匿名作者本人脱敏
const comments = [
  { cid: 'c1', text: '活动期间，作者评论回复暂时隐藏', author: '作者A', avatar: 'x', authorId: '123', articleAuthorId: '123' },
  { cid: 'c1', text: '正常评论', author: '作者A', avatar: 'x', authorId: '123', articleAuthorId: '123' },
  { cid: 'c2', text: '非匿名', author: '作者B', avatar: 'x', authorId: '456', articleAuthorId: '456' }
]
const filtered = sanitizeCommentList(comments, new Set(['c1']))
assert.equal(filtered.length, 2)
assert.equal(filtered[0].author, '匿名用户')
assert.equal(filtered[0].avatar, undefined)
assert.equal(filtered[1].author, '作者B')

console.log('activity-rules tests passed')
