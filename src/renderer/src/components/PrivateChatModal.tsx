import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useChatStore } from '../stores/chat'
import { cachedImageUrl, formatTs } from '../lib/sanitize'
import { useAuthStore } from '../stores/auth'
import type { ChatMessage } from '../../../shared/types'

/**
 * v0.0.9：私聊弹窗。
 * 打开后通过 getPrivateChat 获取/创建会话，再拉取消息列表；支持发送消息。
 */
export function PrivateChatModal(): React.JSX.Element | null {
  const target = useChatStore((s) => s.target)
  const close = useChatStore((s) => s.close)
  const session = useAuthStore((s) => s.session)
  const myUid = String(session?.userinfo?.uid ?? session?.userinfo?.id ?? '')

  const [chatid, setChatid] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!target) return
    let alive = true
    setChatid('')
    setMessages([])
    setInput('')
    setError(null)
    setLoading(true)
    void (async () => {
      try {
        const chatRes = await window.hqsf.getPrivateChat(target.uid)
        if (!alive) return
        if (!chatRes.ok) {
          setError(chatRes.error)
          return
        }
        setChatid(chatRes.data.chatid)
        const msgRes = await window.hqsf.listChatMessages(chatRes.data.chatid)
        if (!alive) return
        if (msgRes.ok) {
          setMessages([...msgRes.data.items].sort((a, b) => a.created - b.created))
        } else {
          setError(msgRes.error)
        }
      } catch (err) {
        if (alive) setError((err as Error).message)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [target])

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages])

  // v0.0.9：私聊简单轮询，对方新消息能自动出现
  useEffect(() => {
    if (!chatid) return
    const timer = window.setInterval(() => {
      void window.hqsf.listChatMessages(chatid).then((res) => {
        if (res.ok) setMessages([...res.data.items].sort((a, b) => a.created - b.created))
      })
    }, 5000)
    return () => window.clearInterval(timer)
  }, [chatid])

  if (!target) return null

  async function handleSend(): Promise<void> {
    const text = input.trim()
    if (!text || !chatid || sending) return
    setSending(true)
    const res = await window.hqsf.sendChatMessage(chatid, text)
    setSending(false)
    if (res.ok) {
      setInput('')
      const msgRes = await window.hqsf.listChatMessages(chatid)
      if (msgRes.ok) setMessages([...msgRes.data.items].sort((a, b) => a.created - b.created))
    } else {
      setError(res.error)
    }
  }

  const avatar = target.avatar && /^https?:\/\//i.test(target.avatar) ? cachedImageUrl(target.avatar) : undefined

  return (
    <div className="chat-modal-backdrop" onClick={close}>
      <div className="chat-modal" onClick={(e) => e.stopPropagation()}>
        <div className="chat-modal-head">
          {avatar ? <img className="chat-modal-avatar" src={avatar} alt="" /> : <span className="chat-modal-avatar chat-modal-avatar-fallback">{target.name.slice(0, 1)}</span>}
          <span className="chat-modal-name">{target.name}</span>
          <button className="chat-modal-close" onClick={close} title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="chat-modal-body" ref={listRef}>
          {loading && <div className="muted chat-modal-empty">加载中…</div>}
          {!loading && messages.length === 0 && <div className="muted chat-modal-empty">（暂无消息，打个招呼吧）</div>}
          {messages.map((m) => {
            const mine = String(m.uid) === myUid
            return (
              <div key={String(m.id)} className={`chat-msg${mine ? ' mine' : ''}`}>
                <div className="chat-msg-bubble">{m.text}</div>
                <div className="chat-msg-time">{formatTs(m.created)}</div>
              </div>
            )
          })}
        </div>

        {error && <div className="chat-modal-error">{error}</div>}

        <div className="chat-modal-input-row">
          <input
            className="chat-modal-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSend()
              }
            }}
            placeholder="输入消息…"
            disabled={!chatid}
          />
          <button className="chat-modal-send" onClick={() => void handleSend()} disabled={!chatid || sending || !input.trim()}>
            {sending ? '发送中…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  )
}
