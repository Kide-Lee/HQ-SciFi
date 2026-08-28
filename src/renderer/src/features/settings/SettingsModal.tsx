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
import { AgreementModal } from '../auth/AgreementModal'

type PanelKey = 'system' | 'interface' | 'user'

interface AgreementView {
  title: string
  html: string
  error?: string
}

import { SystemPanel } from './SystemPanel'
import { InterfacePanel } from './InterfacePanel'
import { UserPanel } from './UserPanel'
import { ChangelogModal } from './ChangelogModal'

export function SettingsModal(): React.JSX.Element | null {
  const open = useUiStore((s) => s.settingsOpen)
  const close = useUiStore((s) => s.closeSettings)
  const [panel, setPanel] = useState<PanelKey>('system')
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [agreement, setAgreement] = useState<AgreementView | null>(null)
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
          {agreementLoading && agreement == null ? (
            <div className="settings-hint">正在加载协议 …</div>
          ) : null}
          {panel === 'system' && (
            <SystemPanel
              onOpenChangelog={() => setChangelogOpen(true)}
              onOpenOwnAgreement={() => void openOwnAgreement()}
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
    </div>
  )
}
