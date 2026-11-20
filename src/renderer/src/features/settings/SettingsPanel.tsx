import { useEffect, useState } from 'react'
import { AgreementModal } from '../auth/AgreementModal'
import { ChangelogModal } from './ChangelogModal'
import { InterfacePanel } from './InterfacePanel'
import { SystemPanel } from './SystemPanel'
import { UserPanel } from './UserPanel'
import { useSettingsStore } from '../../stores/settings'
import { useUiStore } from '../../stores/ui'

type SettingsTab = 'system' | 'interface' | 'user'

const SETTINGS_TABS: Array<{ key: SettingsTab; label: string }> = [
  { key: 'system', label: '系统' },
  { key: 'interface', label: '界面' },
  { key: 'user', label: '用户' }
]

interface AgreementView {
  title: string
  html: string
  error?: string
}

/**
 * v0.1.11：右栏「设置」tab——原先的独立设置弹窗改为右栏内嵌面板。
 * 面板内再分 系统 / 界面 / 用户 三个子分页（样式与消息面板的分类 tab 一致），
 * 内容复用 SystemPanel / InterfacePanel / UserPanel。
 */
export function SettingsPanel(): React.JSX.Element {
  const closePanel = useUiStore((s) => s.closePanel)
  const [tab, setTab] = useState<SettingsTab>('system')
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [agreement, setAgreement] = useState<AgreementView | null>(null)
  const [agreementLoading, setAgreementLoading] = useState(false)

  useEffect(() => {
    void useSettingsStore.getState().loadAppSettings()
  }, [])

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
    <div className="settings-panel-wrap">
      <div className="settings-subtabs">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.key}
            className={`settings-subtab${t.key === tab ? ' active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="settings-panel-scroll">
        {agreementLoading && agreement == null ? (
          <div className="settings-hint">正在加载协议 …</div>
        ) : null}
        {tab === 'system' && (
          <SystemPanel
            onOpenChangelog={() => setChangelogOpen(true)}
            onOpenOwnAgreement={() => void openOwnAgreement()}
            onClose={closePanel}
          />
        )}
        {tab === 'interface' && <InterfacePanel />}
        {tab === 'user' && <UserPanel onClose={closePanel} />}
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