import { create } from 'zustand'
import type { AppSettings, ThemeMode, UiSettings } from '../../../shared/types'

/**
 * v0.1.10 设置 store。
 * 渲染层 UI 外观设置（主题/主题色/字体/字号）用 localStorage 持久化并在启动时同步应用；
 * 主进程级设置（自动更新/硬件加速/缩放/自定义代码）通过 view 桥接口读写 settings.json。
 */

export const UI_SETTINGS_KEY = 'hqsf-ui-settings'

export const DEFAULT_UI_SETTINGS: UiSettings = {
  theme: 'system',
  themeColor: '#4a6cf7',
  uiFont: '',
  contentFont: '',
  codeFont: '',
  fontSize: 14
}

export const THEME_COLORS = [
  { key: 'blue', value: '#4a6cf7', label: '蓝' },
  { key: 'purple', value: '#7c5cff', label: '紫' },
  { key: 'green', value: '#22a06b', label: '绿' },
  { key: 'orange', value: '#f08c00', label: '橙' },
  { key: 'pink', value: '#e64980', label: '粉' }
] as const

export const FONT_CANDIDATES = [
  { value: '', label: '系统默认' },
  { value: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif', label: '系统字族' },
  { value: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif', label: 'PingFang/雅黑' },
  { value: '"Noto Serif CJK SC", "Source Han Serif SC", serif', label: '思源宋体' },
  { value: '"KaiTi", "STKaiti", "楷体", serif', label: '楷体' }
] as const

export const CODE_FONT_CANDIDATES = [
  { value: '', label: '系统默认' },
  { value: 'ui-monospace, "Cascadia Code", Consolas, monospace', label: '等宽默认' },
  { value: '"JetBrains Mono", "Cascadia Code", Consolas, monospace', label: 'JetBrains Mono' },
  { value: '"Fira Code", Consolas, monospace', label: 'Fira Code' }
] as const

function loadUiSettings(): UiSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(UI_SETTINGS_KEY) ?? '{}') as Partial<UiSettings>
    const theme: ThemeMode =
      raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system' ? raw.theme : DEFAULT_UI_SETTINGS.theme
    const fontSize = Number(raw.fontSize)
    return {
      theme,
      themeColor: typeof raw.themeColor === 'string' && raw.themeColor ? raw.themeColor : DEFAULT_UI_SETTINGS.themeColor,
      uiFont: typeof raw.uiFont === 'string' ? raw.uiFont : DEFAULT_UI_SETTINGS.uiFont,
      contentFont: typeof raw.contentFont === 'string' ? raw.contentFont : DEFAULT_UI_SETTINGS.contentFont,
      codeFont: typeof raw.codeFont === 'string' ? raw.codeFont : DEFAULT_UI_SETTINGS.codeFont,
      fontSize: Number.isFinite(fontSize) ? Math.min(20, Math.max(11, fontSize)) : DEFAULT_UI_SETTINGS.fontSize
    }
  } catch {
    return { ...DEFAULT_UI_SETTINGS }
  }
}

function resolvedTheme(theme: ThemeMode): 'light' | 'dark' {
  if (theme !== 'system') return theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyUiSettings(ui: UiSettings): void {
  const root = document.documentElement
  root.dataset.theme = resolvedTheme(ui.theme)
  const uiFont = ui.uiFont || 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
  root.style.setProperty('--font', uiFont)
  root.style.setProperty('--font-content', ui.contentFont || uiFont)
  root.style.setProperty('--font-code', ui.codeFont || 'ui-monospace, "Cascadia Code", Consolas, monospace')
  root.style.setProperty('--font-size', `${ui.fontSize}px`)
  root.style.setProperty('--accent', ui.themeColor)
  const dark = resolvedTheme(ui.theme) === 'dark'
  root.style.setProperty('--accent-soft', `color-mix(in srgb, ${ui.themeColor} ${dark ? 20 : 12}%, ${dark ? '#16181d' : 'white'})`)
}

interface SettingsState {
  ui: UiSettings
  app: AppSettings
  appLoading: boolean
  error: string | null
  setUi: (patch: Partial<UiSettings>) => void
  loadAppSettings: () => Promise<void>
  updateAppSettings: (patch: Partial<AppSettings>) => Promise<boolean>
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ui: loadUiSettings(),
  app: {
    autoUpdate: false,
    hardwareAccel: true,
    zoomFactor: 1,
    customCss: '',
    customJs: ''
  },
  appLoading: true,
  error: null,

  setUi: (patch) => {
    const next = { ...get().ui, ...patch }
    localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify(next))
    applyUiSettings(next)
    set({ ui: next })
  },

  loadAppSettings: async () => {
    const res = await window.hqsf.getSettings()
    if (res.ok) set({ app: res.data, appLoading: false, error: null })
    else set({ appLoading: false, error: res.error })
  },

  updateAppSettings: async (patch) => {
    const res = await window.hqsf.updateSettings(patch)
    if (res.ok) {
      set({ app: res.data, error: null })
      return true
    }
    set({ error: res.error })
    return false
  }
}))

/** 启动时同步应用 localStorage 中的 UI 设置（App 挂载前调用） */
export function applyInitialSettings(): void {
  applyUiSettings(useSettingsStore.getState().ui)
}
