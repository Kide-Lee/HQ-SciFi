import type { ApiRequestOptions } from '../shared/types'

export interface CommentRequestPayload {
  cid: string
  text: string
  parent?: number | string
  reviewid?: number | string
}

/**
 * 按荒启 commentsAdd 契约组装请求：cid/parent/reviewid 放入 params JSON，
 * token/text 是与 params 同级的查询参数。
 *
 * 2026-08-14 实测修复：parent 必须始终出现在 params 中（顶层评论传 0）。
 * 定制版服务端对缺 parent 的请求会抛异常返回「接口请求异常，请联系管理员」（code 0），
 * 此前仅在 parent 非 0 时写入导致顶层评论发布必败；reviewid 同理恒写（0=普通评论）。
 */
export function buildCommentRequest(token: string, payload: CommentRequestPayload): ApiRequestOptions {
  const params: Record<string, unknown> = {
    cid: String(payload.cid),
    parent: payload.parent != null && String(payload.parent) !== '0' ? payload.parent : 0,
    reviewid: payload.reviewid != null && String(payload.reviewid) !== '0' ? payload.reviewid : 0
  }

  return {
    method: 'GET',
    query: { params: JSON.stringify(params), token, text: payload.text }
  }
}
