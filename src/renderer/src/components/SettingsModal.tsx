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
import { useAuthStore } from '../stores/auth'
import { useUiStore } from '../stores/ui'
import { useSettingsStore, THEME_COLORS, FONT_CANDIDATES, CODE_FONT_CANDIDATES } from '../stores/settings'
import { useDocsStore } from '../stores/docs'
import type { UpdateState } from '../../../shared/types'
import { AgreementModal } from './AgreementModal'

type PanelKey = 'system' | 'interface' | 'user'

interface AgreementView {
  title: string
  html: string
  error?: string
}

export function SettingsModal(): React.JSX.Element | null {
  const open = useUiStore((s) => s.settingsOpen)
  const close = useUiStore((s) => s.closeSettings)
  const [panel, setPanel] = useState<PanelKey>('system')
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [agreement, setAgreement] = useState<AgreementView | null>(null)
  const [hqAgreement, setHqAgreement] = useState<AgreementView | null>(null)
  const [agreementLoading, setAgreementLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    void useSettingsStore.getState().loadAppSettings()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open) return null

  async function openOwnAgreement(): Promise<void> {
    setAgreementLoading(true)
    try {
      const res = await window.hqsf.getAgreement()
      if (res.ok) {
        setAgreement({ title: '「黄芪饮片」的用户协议', html: res.data.html })
      } else {
        setAgreement({ title: '「黄芪饮片」的用户协议', html: '', error: res.error })
      }
    } catch (err) {
      setAgreement({ title: '「黄芪饮片」的用户协议', html: '', error: (err as Error).message })
    } finally {
      setAgreementLoading(false)
    }
  }

  async function openHqAgreement(): Promise<void> {
    setAgreementLoading(true)
    try {
      const res = await window.hqsf.getHuangqiAgreement()
      if (res.ok) {
        setHqAgreement({ title: '「荒启科幻」的用户协议', html: res.data.html })
      } else {
        setHqAgreement({ title: '「荒启科幻」的用户协议', html: '', error: res.error })
      }
    } catch (err) {
      setHqAgreement({ title: '「荒启科幻」的用户协议', html: '', error: (err as Error).message })
    } finally {
      setAgreementLoading(false)
    }
  }

  return (
    <div className="settings-mask">
      <div className="settings-modal">
        <button className="settings-close-btn settings-close-top" onClick={close} title="关闭">
          <X size={16} />
        </button>
        <aside className="settings-nav">
          <div className="settings-nav-title">设置</div>
          <button className={panel === 'system' ? 'active' : ''} onClick={() => setPanel('system')}>
            <SettingsIcon size={16} /> 系统
          </button>
          <button className={panel === 'interface' ? 'active' : ''} onClick={() => setPanel('interface')}>
            <Paintbrush size={16} /> 界面
          </button>
          <button className={panel === 'user' ? 'active' : ''} onClick={() => setPanel('user')}>
            <User size={16} /> 用户
          </button>
          <div className="settings-nav-spacer" />
        </aside>
        <section className="settings-content">
          {agreementLoading && agreement == null && hqAgreement == null ? (
            <div className="settings-hint">正在加载协议 …</div>
          ) : null}
          {panel === 'system' && (
            <SystemPanel
              onOpenChangelog={() => setChangelogOpen(true)}
              onOpenOwnAgreement={() => void openOwnAgreement()}
              onOpenHqAgreement={() => void openHqAgreement()}
            />
          )}
          {panel === 'interface' && <InterfacePanel />}
          {panel === 'user' && <UserPanel onClose={close} />}
        </section>
      </div>
      {changelogOpen && <ChangelogModal onClose={() => setChangelogOpen(false)} />}
      {agreement && (
        <AgreementModal
          title={agreement.title}
          state={agreement.html ? 'ok' : 'fail'}
          html={agreement.html}
          error={agreement.error}
          onCancel={() => setAgreement(null)}
          onDone={() => setAgreement(null)}
          doneText="关闭"
        />
      )}
      {hqAgreement && (
        <AgreementModal
          title={hqAgreement.title}
          state={hqAgreement.html ? 'ok' : 'fail'}
          html={hqAgreement.html}
          error={hqAgreement.error}
          onCancel={() => setHqAgreement(null)}
          onDone={() => setHqAgreement(null)}
          doneText="关闭"
        />
      )}
    </div>
  )
}

function SystemPanel({
  onOpenChangelog,
  onOpenOwnAgreement,
  onOpenHqAgreement
}: {
  onOpenChangelog: () => void
  onOpenOwnAgreement: () => void
  onOpenHqAgreement: () => void
}): React.JSX.Element {
  const app = useSettingsStore((s) => s.app)
  const updateAppSettings = useSettingsStore((s) => s.updateAppSettings)
  const close = useUiStore((s) => s.closeSettings)
  const openUserPage = useUiStore((s) => s.openUserPage)
  const refreshLocal = useDocsStore((s) => s.refreshLocal)
  const [version, setVersion] = useState('')
  const [isDeb, setIsDeb] = useState(false)
  const [docsRoot, setDocsRoot] = useState('')
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' })
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void window.hqsf.getAppInfo().then((info) => {
      setVersion(info.version)
      setIsDeb(!!info.packaged && info.platform === 'linux' && !info.isAppImage)
    })
    void window.hqsf.getDocsRoot().then((res) => {
      if (res.ok) setDocsRoot(res.data)
    })
    void window.hqsf.getUpdateState().then((res) => {
      if (res.ok) setUpdateState(res.data)
    })
    return window.hqsf.onUpdateState((s) => setUpdateState(s))
  }, [])

  async function checkUpdate(): Promise<void> {
    setBusy('check')
    setUpdateState({ status: 'checking' })
    const res = await window.hqsf.checkForUpdates()
    setBusy(null)
    if (res.ok) setUpdateState(res.data)
    else setUpdateState({ status: 'error', message: res.error })
  }

  async function downloadUpdate(): Promise<void> {
    setBusy('download')
    await window.hqsf.downloadUpdate()
    setBusy(null)
  }

  async function chooseDocsRoot(): Promise<void> {
    const res = await window.hqsf.chooseDocsDir()
    if (res.ok && res.data) {
      setDocsRoot(res.data)
      await refreshLocal()
      await window.hqsf.showMessageBox({
        type: 'info',
        title: '本地存档目录已更改',
        message: '新目录已生效。旧目录中的文件不会被迁移或删除。',
        detail: `新目录：${res.data}`,
        buttons: ['知道了']
      })
    }
  }

  async function clearCache(): Promise<void> {
    const confirm = await window.hqsf.showMessageBox({
      type: 'question',
      title: '清除缓存',
      message: '将清除图片缓存、阅读缓存和网络缓存，不会删除本地文档与登录状态。',
      buttons: ['取消', '清除'],
      defaultId: 1,
      cancelId: 0
    })
    if (!confirm.ok) return
    if (confirm.data.response !== 1) return
    setBusy('cache')
    const res = await window.hqsf.clearCache()
    setBusy(null)
    if (res.ok) {
      await window.hqsf.showMessageBox({
        type: 'info',
        title: '已清除缓存',
        message: `已释放约 ${(res.data.freedBytes / 1024).toFixed(1)} KB 图片缓存空间。`,
        buttons: ['知道了']
      })
    } else {
      await window.hqsf.showMessageBox({ type: 'error', title: '清除缓存失败', message: res.error, buttons: ['知道了'] })
    }
  }

  async function requestUninstall(): Promise<void> {
    const confirm = await window.hqsf.showMessageBox({
      type: 'warning',
      title: '卸载「黄芪饮片」',
      message: '确定要卸载吗？此操作会关闭应用并启动卸载程序。',
      buttons: ['取消', '卸载'],
      defaultId: 1,
      cancelId: 0
    })
    if (!confirm.ok || confirm.data.response !== 1) return
    const res = await window.hqsf.uninstall()
    if (!res.ok) {
      await window.hqsf.showMessageBox({ type: 'info', title: '无法自动卸载', message: res.error, buttons: ['知道了'] })
    }
  }

  return (
    <div className="settings-panel">
      <h2>系统</h2>
      <section className="settings-section">
        <h3>更新</h3>
        <div className="settings-row">
          <span className="settings-label">当前版本</span>
          <button className="settings-link" onClick={onOpenChangelog}>
            {version || '…'}
          </button>
        </div>
        <div className="settings-row">
          <span className="settings-label">自动更新</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={app.autoUpdate}
              disabled={isDeb}
              onChange={(e) => void updateAppSettings({ autoUpdate: e.target.checked })}
            />
            <span />
          </label>
          {isDeb && <span className="settings-hint">deb 包不支持自动更新，请前往 GitHub Releases 下载。</span>}
        </div>
        <div className="settings-row">
          <span className="settings-label">检查更新</span>
          <button className="ghost-btn" disabled={busy === 'check'} onClick={() => void checkUpdate()}>
            {updateState.status === 'checking' ? '检查中…' : '检查更新'}
          </button>
        </div>
        {updateState.status === 'available' && (
          <div className="settings-card settings-update">
            <strong>发现新版本 v{updateState.version}</strong>
            <div>{updateState.notes || '请前往发布页下载。'}</div>
            <button className="primary-btn" onClick={() => void downloadUpdate()}>
              前往下载
            </button>
          </div>
        )}
        {updateState.status === 'not-available' && <div className="settings-hint">当前已经是最新版本。</div>}
        {updateState.status === 'error' && <div className="settings-hint error">{updateState.message}</div>}
      </section>

      <section className="settings-section">
        <h3>功能</h3>
        <div className="settings-row">
          <span className="settings-label">本地存档</span>
          <span className="settings-value">{docsRoot || '…'}</span>
          <button className="ghost-btn" onClick={() => void chooseDocsRoot()}>
            更改
          </button>
        </div>
        <div className="settings-row">
          <span className="settings-label">清除缓存</span>
          <button className="ghost-btn" disabled={busy === 'cache'} onClick={() => void clearCache()}>
            {busy === 'cache' ? '清除中…' : '清除缓存'}
          </button>
        </div>
        <div className="settings-row">
          <span className="settings-label">卸载</span>
          <button className="ghost-btn danger" onClick={() => void requestUninstall()}>
            <Trash2 size={14} /> 卸载
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h3>关于「黄芪饮片」</h3>
        <div className="settings-link-row">
          <button className="settings-link" onClick={() => window.open('https://github.com/Kide-Lee/HQ-SciFi', '_blank')}>
            Github 页面
          </button>
          <button
            className="settings-link"
            onClick={() => {
              close()
              openUserPage(2369)
            }}
          >
            查看开发者的主页
          </button>
          <button className="settings-link" onClick={() => window.open('https://qm.qq.com/q/gsTXRe5yx2', '_blank')}>
            加入「黄芪饮片」的 QQ 群
          </button>
          <button className="settings-link" onClick={onOpenOwnAgreement}>
            「黄芪饮片」的用户协议
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h3>关于「荒启科幻」</h3>
        <div className="settings-link-row">
          <button className="settings-link" onClick={() => window.open('https://qm.qq.com/q/xaRbUQGOEq', '_blank')}>
            加入「荒启科幻」的 QQ 群
          </button>
          <button className="settings-link" onClick={onOpenHqAgreement}>
            「荒启科幻」的用户协议
          </button>
        </div>
      </section>
    </div>
  )
}

function InterfacePanel(): React.JSX.Element {
  const ui = useSettingsStore((s) => s.ui)
  const app = useSettingsStore((s) => s.app)
  const appLoading = useSettingsStore((s) => s.appLoading)
  const setUi = useSettingsStore((s) => s.setUi)
  const updateAppSettings = useSettingsStore((s) => s.updateAppSettings)
  const [customOpen, setCustomOpen] = useState<'css' | 'js' | null>(null)
  const [showRestart, setShowRestart] = useState(false)

  async function toggleHardwareAccel(value: boolean): Promise<void> {
    await updateAppSettings({ hardwareAccel: value })
    setShowRestart(true)
  }

  return (
    <div className="settings-panel">
      <h2>界面</h2>
      {appLoading && <div className="settings-hint">正在加载系统设置 …</div>}
      <section className="settings-section">
        <h3>外观</h3>
        <div className="settings-row">
          <span className="settings-label">主题</span>
          <div className="settings-options">
            {(['light', 'dark', 'system'] as const).map((t) => (
              <button
                key={t}
                className={`settings-option ${ui.theme === t ? 'active' : ''}`}
                onClick={() => setUi({ theme: t })}
              >
                {t === 'light' ? '浅色' : t === 'dark' ? '深色' : '跟随系统'}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-label">主题色</span>
          <div className="settings-theme-colors">
            {THEME_COLORS.map((c) => (
              <button
                key={c.value}
                title={c.label}
                className={`settings-color-dot ${ui.themeColor === c.value ? 'active' : ''}`}
                style={{ background: c.value }}
                onClick={() => setUi({ themeColor: c.value })}
              >
                {ui.themeColor === c.value && <Check size={12} />}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h3>字体</h3>
        <div className="settings-row">
          <span className="settings-label">界面字体</span>
          <select value={ui.uiFont} onChange={(e) => setUi({ uiFont: e.target.value })}>
            {FONT_CANDIDATES.map((f) => (
              <option key={f.label} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-row">
          <span className="settings-label">正文字体</span>
          <select value={ui.contentFont} onChange={(e) => setUi({ contentFont: e.target.value })}>
            {FONT_CANDIDATES.map((f) => (
              <option key={f.label} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-row">
          <span className="settings-label">代码字体</span>
          <select value={ui.codeFont} onChange={(e) => setUi({ codeFont: e.target.value })}>
            {CODE_FONT_CANDIDATES.map((f) => (
              <option key={f.label} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-row">
          <span className="settings-label">字体大小</span>
          <input
            type="range"
            min={11}
            max={20}
            step={1}
            value={ui.fontSize}
            onChange={(e) => setUi({ fontSize: Number(e.target.value) })}
          />
          <span className="settings-value">{ui.fontSize}px</span>
        </div>
      </section>

      <section className="settings-section">
        <h3>高级</h3>
        <div className="settings-row">
          <span className="settings-label">缩放比例</span>
          <input
            type="range"
            min={0.8}
            max={1.5}
            step={0.1}
            value={app.zoomFactor}
            onChange={(e) => void updateAppSettings({ zoomFactor: Number(e.target.value) })}
          />
          <span className="settings-value">{Math.round(app.zoomFactor * 100)}%</span>
        </div>
        <div className="settings-row">
          <span className="settings-label">硬件加速</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={app.hardwareAccel}
              onChange={(e) => void toggleHardwareAccel(e.target.checked)}
            />
            <span />
          </label>
        </div>
        {showRestart && <div className="settings-hint">硬件加速将在下次启动应用时生效。</div>}
        <div className="settings-row">
          <span className="settings-label">自定义 CSS</span>
          <button className="ghost-btn" disabled={appLoading} onClick={() => setCustomOpen('css')}>
            {app.customCss ? '编辑' : '添加'}
          </button>
        </div>
        <div className="settings-row">
          <span className="settings-label">自定义 JS</span>
          <button className="ghost-btn" disabled={appLoading} onClick={() => setCustomOpen('js')}>
            {app.customJs ? '编辑' : '添加'}
          </button>
        </div>
        <div className="settings-hint warning">
          <AlertTriangle size={14} /> 自定义 JS 将以应用界面同等权限运行，请只加载可信脚本。
        </div>
      </section>

      {customOpen && <CustomCodeModal mode={customOpen} onClose={() => setCustomOpen(null)} />}
    </div>
  )
}

function CustomCodeModal({ mode, onClose }: { mode: 'css' | 'js'; onClose: () => void }): React.JSX.Element {
  const app = useSettingsStore((s) => s.app)
  const updateAppSettings = useSettingsStore((s) => s.updateAppSettings)
  const [value, setValue] = useState(mode === 'css' ? app.customCss : app.customJs)
  const [busy, setBusy] = useState(false)

  async function save(): Promise<void> {
    setBusy(true)
    const ok = await updateAppSettings(mode === 'css' ? { customCss: value } : { customJs: value })
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <div className="settings-code-mask">
      <div className="settings-code-modal">
        <h3>{mode === 'css' ? '自定义 CSS' : '自定义 JS'}</h3>
        <textarea
          className="settings-code-editor"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={mode === 'css' ? '/* 你的 CSS */' : '// 你的 JS'}
        />
        <div className="settings-code-footer">
          <button className="ghost-btn" onClick={onClose}>
            取消
          </button>
          <button className="primary-btn" disabled={busy} onClick={() => void save()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

function UserPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
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

function ChangelogModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [content, setContent] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState('')
  const md = useMemo(() => new MarkdownIt({ html: false, linkify: true, breaks: true }), [])

  useEffect(() => {
    void window.hqsf.getChangelog().then((res) => {
      if (res.ok) {
        setContent(res.data.markdown)
        setVersion(res.data.version)
      } else {
        setError(res.error)
      }
    })
  }, [])

  return (
    <div className="settings-code-mask">
      <div className="settings-code-modal">
        <h3>更新日志（v{version || '…'}）</h3>
        {error && <div className="settings-hint error">{error}</div>}
        <div
          className="settings-changelog"
          dangerouslySetInnerHTML={{ __html: content ? md.render(content) : '正在加载…' }}
        />
        <div className="settings-code-footer">
          <button className="primary-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
