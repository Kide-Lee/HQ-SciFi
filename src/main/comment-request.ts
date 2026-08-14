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
 */
export function buildCommentRequest(token: string, payload: CommentRequestPayload): ApiRequestOptions {
  const params: Record<string, unknown> = { cid: String(payload.cid) }
  if (payload.parent != null && String(payload.parent) !== '0') params.parent = payload.parent
  if (payload.reviewid != null && String(payload.reviewid) !== '0') params.reviewid = payload.reviewid

  return {
    method: 'GET',
    query: { params: JSON.stringify(params), token, text: payload.text }
  }
}
