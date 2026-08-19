import { apiRequest, endpoint } from './net/api'
import { num, normTs, str } from './read'
import type { ChatMessage, ChatSession } from '../shared/types'

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

function toChatSession(item: Record<string, unknown>): ChatSession {
  const userJson = (item.userJson as Record<string, unknown> | undefined) ?? {}
  const lastMsgRaw = item.lastMsg as Record<string, unknown> | undefined
  // myChat 中 userJson 恒为对方用户；uid 优先取 userJson.uid，缺失时再回退 toid
  const uid = str(userJson.uid ?? item.toid ?? item.uid ?? '')
  return {
    chatid: str(item.id ?? ''),
    uid,
    name: str(item.name ?? userJson.name ?? userJson.nickname ?? `UID ${uid}`),
    avatar: str(userJson.avatar ?? userJson.headImg ?? userJson.avatarUrl ?? '') || undefined,
    lastTime: normTs(item.lastTime ?? item.created ?? 0),
    lastMsg: lastMsgRaw ? str(lastMsgRaw.text ?? '') : str(item.lastMsgText ?? '') || undefined,
    unread: num(item.myUnRead ?? item.unread ?? 0)
  }
}

/** 拉取私聊会话列表（hqChat/myChat），供消息中心「私聊」tab 展示用户卡片 */
export async function listChatSessions(token: string): Promise<ChatSession[]> {
  const resp = await apiRequest<Record<string, unknown>[]>(endpoint('myChat').path, {
    method: 'GET',
    query: { token }
  })
  const data = resp.data
  const raw = Array.isArray(data)
    ? data
    : Array.isArray((data as { list?: unknown } | null)?.list)
      ? ((data as { list: unknown[] }).list)
      : Array.isArray((data as { items?: unknown } | null)?.items)
        ? ((data as { items: unknown[] }).items)
        : []
  return raw.map((it) => toChatSession((it ?? {}) as Record<string, unknown>))
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
