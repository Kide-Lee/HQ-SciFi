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

export function InterfacePanel(): React.JSX.Element {
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

export function CustomCodeModal({ mode, onClose }: { mode: 'css' | 'js'; onClose: () => void }): React.JSX.Element {
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
