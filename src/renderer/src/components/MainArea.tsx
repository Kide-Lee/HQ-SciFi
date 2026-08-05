import { useEffect, useState } from 'react'
import { SECTION_LABELS, useUiStore } from '../stores/ui'

/**
 * M0 主界面占位：验证 IPC（ping / getAppInfo）与主进程网络代理（荒启公开接口）。
 * 真实视图（写作/阅读/评审）在 M1-M3 接入。
 */
export function MainArea(): React.JSX.Element {
  const section = useUiStore((s) => s.section)
  const selectedId = useUiStore((s) => s.selectedId)

  const [appInfo, setAppInfo] = useState<string>('')
  const [probe, setProbe] = useState<string>('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.hqsf.getAppInfo().then((info) => {
      setAppInfo(`平台 ${info.platform}/${info.arch} · 应用 v${info.version}${info.packaged ? '（已打包）' : '（开发模式）'}`)
    })
  }, [])

  async function runProbe(): Promise<void> {
    setBusy(true)
    setProbe('正在探测 …')
    try {
      const pong = await window.hqsf.ping()
      const site = await window.hqsf.apiRequest<{ name?: string; version?: string }>('system/app', {
        method: 'POST',
        body: { key: 'QyAPIZKw' }
      })
      if (site.ok) {
        const siteName = site.data?.name ?? '?'
        const siteVersion = site.data?.version ? site.data.version.replace(/^v/i, '') : '?'
        setProbe(`IPC: ${pong} ✓ · 荒启 API 连通（${siteName} v${siteVersion}）✓`)
      } else {
        setProbe(`IPC: ${pong} ✓ · 荒启 API 失败: ${site.error}`)
      }
    } catch (err) {
      setProbe(`探测异常: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="main-area">
      <header className="main-header">
        <h1>{SECTION_LABELS[section]}</h1>
        {selectedId && <span className="crumb"> / {selectedId}</span>}
      </header>

      <div className="main-content">
        <div className="placeholder-card">
          <h2>{selectedId ?? SECTION_LABELS[section]}</h2>
          <p className="muted">M0 脚手架占位 —— 该视图将在 M1–M3 实现。</p>
        </div>

        <div className="probe-card">
          <div className="probe-info">{appInfo || '加载应用信息 …'}</div>
          <button className="probe-btn" onClick={runProbe} disabled={busy}>
            {busy ? '探测中 …' : '连通性自检（IPC + 荒启 API）'}
          </button>
          {probe && <pre className="probe-result">{probe}</pre>}
        </div>
      </div>
    </main>
  )
}
