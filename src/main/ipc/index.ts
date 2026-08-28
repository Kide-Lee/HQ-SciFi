import { registerAgreementHandlers } from './agreement.handlers'
import { registerAuthHandlers } from './auth.handlers'
import { registerBrowseHandlers } from './browse.handlers'
import { registerChatHandlers } from './chat.handlers'
import { registerCommentHandlers } from './comment.handlers'
import { registerDocsHandlers } from './docs.handlers'
import { registerInteractHandlers } from './interact.handlers'
import { registerMediaHandlers } from './media.handlers'
import { registerNotifyHandlers } from './notify.handlers'
import { registerReadHandlers } from './read.handlers'
import { registerReviewHandlers } from './review.handlers'
import { registerSearchHandlers } from './search.handlers'
import { registerSettingsHandlers } from './settings.handlers'
import { registerSyncHandlers } from './sync.handlers'
import { registerSystemHandlers } from './system.handlers'
import { registerUpdaterHandlers } from './updater.handlers'
import { registerUserHandlers } from './user.handlers'
import { registerWindowHandlers } from './window.handlers'

/**
 * 注册全部领域 IPC handler。
 * 阶段 2 后 `src/main/ipc.ts` 只保留本文件入口，不再包含业务 handler。
 */
export function registerAllIpcHandlers(): void {
  registerSystemHandlers()
  registerWindowHandlers()
  registerAgreementHandlers()
  registerAuthHandlers()
  registerSyncHandlers()
  registerDocsHandlers()
  registerReadHandlers()
  registerReviewHandlers()
  registerBrowseHandlers()
  registerSearchHandlers()
  registerCommentHandlers()
  registerInteractHandlers()
  registerUserHandlers()
  registerNotifyHandlers()
  registerChatHandlers()
  registerSettingsHandlers()
  registerUpdaterHandlers()
  registerMediaHandlers()
}
