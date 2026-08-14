import assert from 'node:assert/strict'
import { buildCommentRequest } from '../src/main/comment-request.ts'

const request = buildCommentRequest('test-token', {
  cid: '42',
  text: '这是一条测试评论',
  parent: 7,
  reviewid: 9
})

assert.equal(request.method, 'GET')
assert.equal(request.query.token, 'test-token')
assert.equal(request.query.text, '这是一条测试评论')

const params = JSON.parse(request.query.params)
assert.deepEqual(params, { cid: '42', parent: 7, reviewid: 9 })
assert.equal('text' in params, false, '评论正文不能放进 params JSON，服务端只读取顶层 text 参数')

// 2026-08-14 实测：定制版服务端要求 parent 恒在 params 中（顶层评论为 0），
// 缺省会抛「接口请求异常」；reviewid 同样恒写（0=普通评论）。
const topLevel = buildCommentRequest('test-token', { cid: '42', text: '顶层评论' })
assert.deepEqual(
  JSON.parse(topLevel.query.params),
  { cid: '42', parent: 0, reviewid: 0 },
  '顶层评论必须显式携带 parent:0 / reviewid:0，否则服务端抛「接口请求异常」'
)

console.log('commentsAdd 请求契约正确')
