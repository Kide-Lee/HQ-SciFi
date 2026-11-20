import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useUiStore } from '../../stores/ui'
import { useSettingsStore } from '../../stores/settings'
import { useDocsStore } from '../../stores/docs'
import type { UpdateState } from '../../../../shared/types'

export function SystemPanel({
  onOpenChangelog,
  onOpenOwnAgreement,
  onClose
}: {
  onOpenChangelog: () => void
  onOpenOwnAgreement: () => void
  onClose: () => void
}): React.JSX.Element {
  const app = useSettingsStore((s) => s.app)
  const updateAppSettings = useSettingsStore((s) => s.updateAppSettings)
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
              onClose()
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
        </div>
      </section>
    </div>
  )
}
