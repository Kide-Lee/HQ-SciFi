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

console.log('commentsAdd 请求契约正确')
