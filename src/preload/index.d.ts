import type { AppInfo, HqsfApi, WindowControls } from '../shared/contracts/hqsf-api'

export type { AppInfo, HqsfApi, WindowControls }

/** 兼容历史：领域类型仍可从 preload 类型声明处导出 */
export * from '../shared/domain'

declare global {
  interface Window {
    hqsf: HqsfApi
  }
}

export {}
