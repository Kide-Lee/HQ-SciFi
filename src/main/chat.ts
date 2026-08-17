import { apiRequest, endpoint } from './net/api'
import { num, normTs, str } from './read'
import type { ChatMessage } from '../shared/types'

function toChatMessage(item: Record<string, unknown>): ChatMessage {
  return {
    id: str(item.id ?? ''),
    type: num(item.type),
    uid: str(item.uid ?? ''),
    text: str(item.text ?? item.msg ?? ''),
    created: normTs(item.created),
    userJson: (item.userJson as Record<string, unknown> | undefined) ?? undefined
  }
}

/** 获取或创建与某用户的私聊会话，返回 chatid */
export async function getPrivateChat(token: string, touid: number | string): Promise<string> {
  const resp = await apiRequest<unknown>(endpoint('getPrivateChat').path, {
    method: 'GET',
    query: { touid: String(touid), token }
  })
  const data = resp.data
  if (data != null && typeof data === 'object') {
    const o = data as Record<string, unknown>
    return str(o.chatid ?? o.id ?? '')
  }
  return str(data ?? '')
}

/** 拉取私聊消息列表（按时间倒序返回，渲染层可反转展示） */
export async function listChatMessages(token: string, chatid: string, limit = 200): Promise<ChatMessage[]> {
  const resp = await apiRequest<Record<string, unknown>[]>(endpoint('msgList').path, {
    method: 'GET',
    query: { token, chatid, limit, page: 1 }
  })
  return (resp.data ?? []).map(toChatMessage)
}

/** 发送私聊消息 */
export async function sendChatMessage(token: string, chatid: string, msg: string): Promise<void> {
  const resp = await apiRequest(endpoint('sendMsg').path, {
    method: 'POST',
    body: { chatid, token, msg, type: 0 }
  })
  if (resp.code !== 1) throw new Error(resp.msg || '发送失败')
}
