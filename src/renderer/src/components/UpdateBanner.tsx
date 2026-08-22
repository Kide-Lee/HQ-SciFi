import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { UpdateState } from '../../../shared/types'

/** v0.1.10：发现新版时顶部横幅，提供「前往下载」或安装提示。 */
export function UpdateBanner(): React.JSX.Element | null {
  const [state, setState] = useState<UpdateState>({ status: 'idle' })
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    void window.hqsf.getUpdateState().then((res) => {
      if (res.ok) setState(res.data)
    })
    return window.hqsf.onUpdateState((s) => {
      setState(s)
      if (s.status === 'available') setDismissed(false)
    })
  }, [])

  if (state.status !== 'available' || dismissed) return null

  return (
    <div className="update-banner">
      <span className="update-banner-text">
        发现新版本 v{state.version}
        {state.notes ? `：${state.notes.slice(0, 80)}` : ''}
      </span>
      <button
        className="primary-btn update-banner-btn"
        onClick={() => {
          void window.hqsf.downloadUpdate()
        }}
      >
        前往下载
      </button>
      <button className="update-banner-close" title="稍后提醒" onClick={() => setDismissed(true)}>
        <X size={14} />
      </button>
    </div>
  )
}
