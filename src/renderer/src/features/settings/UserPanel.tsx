import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Circle,
  LogOut,
  Paintbrush,
  Settings as SettingsIcon,
  Trash2,
  User,
  X
} from 'lucide-react'
import MarkdownIt from 'markdown-it'
import { useAuthStore } from '../../stores/auth'
import { useUiStore } from '../../stores/ui'
import { useSettingsStore, THEME_COLORS, FONT_CANDIDATES, CODE_FONT_CANDIDATES } from '../../stores/settings'
import { useDocsStore } from '../../stores/docs'
import type { UpdateState } from '../../../../shared/types'

export function UserPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const session = useAuthStore((s) => s.session)
  const openLogin = useUiStore((s) => s.openLogin)
  const logout = useAuthStore((s) => s.logout)
  const [form, setForm] = useState({
    screenName: '',
    avatar: '',
    userBg: '',
    introduce: '',
    mail: '',
    phone: ''
  })
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!session) return
    setLoading(true)
    void window.hqsf.getSelfStatus().then((res) => {
      setLoading(false)
      if (res.ok && res.data) {
        const p = res.data
        const info = (session.userinfo ?? {}) as Record<string, unknown>
        const str = (v: unknown): string => (typeof v === 'string' ? v : '')
        setForm({
          screenName: str(p.screenName ?? info.screenName ?? info.name ?? ''),
          avatar: str(p.avatar ?? info.avatar ?? ''),
          userBg: str(p.userBg ?? info.userBg ?? ''),
          introduce: str(p.introduce ?? info.introduce ?? ''),
          mail: str(p.mail ?? info.mail ?? ''),
          phone: str(p.phone ?? info.phone ?? '')
        })
      } else if (!res.ok) {
        setError(res.error)
      }
    })
  }, [session])

  if (!session) {
    return (
      <div className="settings-panel">
        <h2>用户</h2>
        <div className="settings-hint">当前未登录。</div>
        <button
          className="primary-btn"
          onClick={() => {
            onClose()
            openLogin()
          }}
        >
          去登录
        </button>
      </div>
    )
  }

  async function uploadImage(field: 'avatar' | 'userBg'): Promise<void> {
    const res = await window.hqsf.pickUploadUserImage()
    if (res.ok && res.data?.url) {
      setForm((f) => ({ ...f, [field]: res.data!.url }))
    } else if (!res.ok) {
      setError(res.error)
    }
  }

  async function saveProfile(): Promise<void> {
    setSaving(true)
    setError(null)
    const res = await window.hqsf.userUpdateProfile(form)
    setSaving(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    // 同步渲染层会话缓存（侧栏昵称/头像立即更新）
    const sessionRes = await window.hqsf.getSession()
    if (sessionRes.ok) useAuthStore.setState({ session: sessionRes.data })
    // 主进程已更新 session.userinfo；渲染层会话已同步，无需再拉公开资料
  }

  return (
    <div className="settings-panel">
      <h2>用户</h2>
      <section className="settings-section">
        <h3>用户</h3>
        {loading && <div className="settings-hint">正在加载资料 …</div>}
        <div className="settings-row">
          <span className="settings-label">昵称</span>
          <input value={form.screenName} onChange={(e) => setForm({ ...form, screenName: e.target.value })} />
        </div>
        <div className="settings-row">
          <span className="settings-label">头像</span>
          {form.avatar ? <img className="settings-avatar" src={form.avatar} alt="头像" /> : <Circle size={24} />}
          <button className="ghost-btn" onClick={() => void uploadImage('avatar')}>
            上传
          </button>
        </div>
        <div className="settings-row">
          <span className="settings-label">主页背景图</span>
          {form.userBg ? <span className="settings-value">{form.userBg}</span> : null}
          <button className="ghost-btn" onClick={() => void uploadImage('userBg')}>
            上传
          </button>
        </div>
        <div className="settings-row">
          <span className="settings-label">个人简介</span>
          <textarea
            value={form.introduce}
            onChange={(e) => setForm({ ...form, introduce: e.target.value })}
            rows={3}
          />
        </div>
      </section>

      <section className="settings-section">
        <h3>账号</h3>
        <div className="settings-row">
          <span className="settings-label">邮箱</span>
          <input value={form.mail} onChange={(e) => setForm({ ...form, mail: e.target.value })} />
        </div>
        <div className="settings-row">
          <span className="settings-label">手机号</span>
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
        <div className="settings-row">
          <span className="settings-label">退出登录</span>
          <button className="ghost-btn danger" onClick={() => void logout()}>
            <LogOut size={14} /> 退出登录
          </button>
        </div>
      </section>

      {error && <div className="settings-hint error">{error}</div>}
      <button className="primary-btn settings-save" disabled={saving} onClick={() => void saveProfile()}>
        {saving ? '保存中…' : '保存修改'}
      </button>
    </div>
  )
}
