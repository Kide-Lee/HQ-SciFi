# IPC 契约与通道清单

> 本文件是 `doc/design-1.md` 的子系统文档之一，用于阶段 1（共享契约先行）与阶段 2（IPC 切分）执行。
> 数据来源：当前 `src/main/ipc.ts` 与 `src/preload/index.ts` 实扫。

## 1. 当前规模

- `src/main/ipc.ts` 中 `ipcMain.handle`：**79 个**。
- `src/preload/index.ts` 中 `ipcRenderer.invoke`/`on`：约 **81 个**。
- `AGENTS.md` 中“44 个 handler”已过时，需在阶段 0 修正。

## 2. 通道分组与目标 handler 文件

### 2.1 系统与窗口（`system.handlers.ts` / `window.handlers.ts`）

| 当前 channel | preload 方法 | 目标文件 | 备注 |
| --- | --- | --- | --- |
| `hqsf:ping` | `ping` | `system.handlers.ts` | 兼容历史裸值接口 |
| `hqsf:get-app-info` | `getAppInfo` | `system.handlers.ts` | 兼容历史裸值接口 |
| `hqsf:copy-text` | `copyText` | `system.handlers.ts` | |
| `hqsf:show-message-box` | `showMessageBox` | `system.handlers.ts` | 原生弹窗 |
| `hqsf:window-minimize` | `windowControls.minimize` | `window.handlers.ts` | |
| `hqsf:window-maximize-toggle` | `windowControls.toggleMaximize` | `window.handlers.ts` | |
| `hqsf:window-close` | `windowControls.close` | `window.handlers.ts` | |
| `hqsf:window-is-maximized` | `windowControls.isMaximized` | `window.handlers.ts` | |
| `hqsf:window-maximized-changed` | `windowControls.onMaximizedChanged` | `window.handlers.ts` | 主进程 → 渲染层事件 |

### 2.2 协议门（`agreement.handlers.ts`）

| 当前 channel | preload 方法 | 目标文件 | 备注 |
| --- | --- | --- | --- |
| `hqsf:get-agreement` | `getAgreement` | `agreement.handlers.ts` | |

### 2.3 认证与会话（`auth.handlers.ts`）

| 当前 channel | preload 方法 | 目标文件 |
| --- | --- | --- |
| `hqsf:login-password` | `loginPassword` | `auth.handlers.ts` |
| `hqsf:get-session` | `getSession` | `auth.handlers.ts` |
| `hqsf:verify-session` | `verifySession` | `auth.handlers.ts` |
| `hqsf:logout` | `logout` | `auth.handlers.ts` |

### 2.4 同步（`sync.handlers.ts`）

| 当前 channel | preload 方法 | 目标文件 |
| --- | --- | --- |
| `hqsf:sync-pull` | `syncPull` | `sync.handlers.ts` |
| `hqsf:sync-push` | `syncPush` | `sync.handlers.ts` |
| `hqsf:convert-to-draft` | `convertToDraft` | `sync.handlers.ts` |
| `hqsf:edit-remote-article` | `editRemoteArticle` | `sync.handlers.ts` |

### 2.5 本地存档（`docs.handlers.ts`）

| 当前 channel | preload 方法 | 目标文件 |
| --- | --- | --- |
| `hqsf:get-docs-root` | `getDocsRoot` | `docs.handlers.ts` |
| `hqsf:open-docs-dir` | `openDocsDir` | `docs.handlers.ts` |
| `hqsf:list-local-docs` | `listLocalDocs` | `docs.handlers.ts` |
| `hqsf:read-local-file` | `readLocalFile` | `docs.handlers.ts` |
| `hqsf:file-exists` | `fileExists` | `docs.handlers.ts` |
| `hqsf:write-local-file` | `writeLocalFile` | `docs.handlers.ts` |
| `hqsf:create-local-draft` | `createLocalDraft` | `docs.handlers.ts` |
| `hqsf:delete-local-file` | `deleteLocalDoc` | `docs.handlers.ts` |
| `hqsf:rename-local-node` | `renameLocalNode` | `docs.handlers.ts` |
| `hqsf:create-local-dir` | `createLocalDir` | `docs.handlers.ts` |
| `hqsf:choose-docs-dir` | `chooseDocsDir` | `docs.handlers.ts` |

### 2.6 四态索引（`docs.handlers.ts`）

| 当前 channel | preload 方法 | 目标文件 |
| --- | --- | --- |
| `hqsf:list-articles` | `listArticles` | `docs.handlers.ts` |

### 2.7 文章与阅读（`read.handlers.ts`）

| 当前 channel | preload 方法 | 目标文件 |
| --- | --- | --- |
| `hqsf:list-remote-articles` | `listRemoteArticles` | `read.handlers.ts` |
| `hqsf:get-remote-article` | `getRemoteArticle` | `read.handlers.ts` |

### 2.8 评审（`review.handlers.ts`）

| 当前 channel | preload 方法 | 目标文件 |
| --- | --- | --- |
| `hqsf:list-reviews` | `listReviews` | `review.handlers.ts` |
| `hqsf:submit-review` | `submitReview` | `review.handlers.ts` |
| `hqsf:set-review-attitude` | `setReviewAttitude` | `review.handlers.ts` |
| `hqsf:list-review-tasks` | `listReviewTasks` | `review.handlers.ts` |
| `hqsf:list-my-reviews` | `listMyReviews` | `review.handlers.ts` |

### 2.9 内容浏览与栏目（`browse.handlers.ts`）

| 当前 channel | preload 方法 | 目标文件 |
| --- | --- | --- |
| `hqsf:list-metas` | `listMetas` | `browse.handlers.ts` |
| `hqsf:list-categories` | `listCategories` | `browse.handlers.ts` |
| `hqsf:check-forbidden` | `checkForbidden` | `browse.handlers.ts` |
| `hqsf:list-gpt-models` | `listGptModels` | `browse.handlers.ts` |

### 2.10 全局搜索（`search.handlers.ts`）

作品库首页的全局搜索（搜索评论/评审/用户）单独归 `search.handlers.ts`：

| 当前 channel | preload 方法 | 目标文件 |
| --- | --- | --- |
| `hqsf:search-comments` | `searchComments` | `search.handlers.ts` |
| `hqsf:search-reviews` | `searchReviews` | `search.handlers.ts` |
| `hqsf:search-users` | `searchUsers` | `search.handlers.ts` |

### 2.11 评论（`comment.handlers.ts`）

| 当前 channel | preload 方法 | 目标文件 |
| --- | --- | --- |
| `hqsf:list-comments` | `listComments` | `comment.handlers.ts` |
| `hqsf:list-recent-comments` | `listRecentComments` | `comment.handlers.ts` |
| `hqsf:add-comment` | `addComment` | `comment.handlers.ts` |

### 2.12 用户互动（`interact.handlers.ts`）

| 当前 channel | preload 方法 | 目标文件 |
| --- | --- | --- |
| `hqsf:add-log` | `addLog` | `interact.handlers.ts` |
| `hqsf:is-mark` | `isMark` | `interact.handlers.ts` |
| `hqsf:remove-log` | `removeLog` | `interact.handlers.ts` |

### 2.13 用户系统（`user.handlers.ts`）

| 当前 channel | preload 方法 | 目标文件 |
| --- | --- | --- |
| `hqsf:user-profile` | `getUserProfile` | `user.handlers.ts` |
| `hqsf:user-stats` | `getUserStats` | `user.handlers.ts` |
| `hqsf:user-self-status` | `getSelfStatus` | `user.handlers.ts` |
| `hqsf:user-follow-state` | `getFollowState` | `user.handlers.ts` |
| `hqsf:user-follow` | `followUser` | `user.handlers.ts` |
| `hqsf:user-follow-list` | `listFollows` | `user.handlers.ts` |
| `hqsf:user-fan-list` | `listFans` | `user.handlers.ts` |
| `hqsf:user-marks` | `listMarks` | `user.handlers.ts` |
| `hqsf:user-articles` | `listUserArticles` | `user.handlers.ts` |
| `hqsf:user-reviews` | `listUserReviews` | `user.handlers.ts` |
| `hqsf:user-comments` | `listUserComments` | `user.handlers.ts` |
| `hqsf:user-feed` | `listFollowFeed` | `user.handlers.ts` |
| `hqsf:user-clock` | `clockIn` | `user.handlers.ts` |
| `hqsf:user-update-profile` | `userUpdateProfile` | `user.handlers.ts` |
| `hqsf:pick-upload-user-image` | `pickUploadUserImage` | `user.handlers.ts` |

### 2.14 通知（`notify.handlers.ts`）

| 当前 channel | preload 方法 | 目标文件 |
| --- | --- | --- |
| `hqsf:list-notifications` | `listNotifications` | `notify.handlers.ts` |
| `hqsf:get-unread-count` | `getUnreadCount` | `notify.handlers.ts` |
| `hqsf:mark-notifications-read` | `markNotificationsRead` | `notify.handlers.ts` |

### 2.15 私聊（`chat.handlers.ts`）

| 当前 channel | preload 方法 | 目标文件 |
| --- | --- | --- |
| `hqsf:get-private-chat` | `getPrivateChat` | `chat.handlers.ts` |
| `hqsf:list-chat-sessions` | `listChatSessions` | `chat.handlers.ts` |
| `hqsf:list-chat-messages` | `listChatMessages` | `chat.handlers.ts` |
| `hqsf:send-chat-message` | `sendChatMessage` | `chat.handlers.ts` |

### 2.16 设置与更新（`settings.handlers.ts` / `updater.handlers.ts`）

| 当前 channel | preload 方法 | 目标文件 |
| --- | --- | --- |
| `hqsf:get-settings` | `getSettings` | `settings.handlers.ts` |
| `hqsf:update-settings` | `updateSettings` | `settings.handlers.ts` |
| `hqsf:get-changelog` | `getChangelog` | `settings.handlers.ts` |
| `hqsf:clear-cache` | `clearCache` | `settings.handlers.ts` |
| `hqsf:uninstall` | `uninstall` | `settings.handlers.ts` |
| `hqsf:update-state` | `getUpdateState` | `updater.handlers.ts` |
| `hqsf:update-check` | `checkForUpdates` | `updater.handlers.ts` |
| `hqsf:update-download` | `downloadUpdate` | `updater.handlers.ts` |
| `hqsf:update-install` | `installUpdate` | `updater.handlers.ts` |
| `hqsf:update-state`（推送） | `onUpdateState` | `updater.handlers.ts` |

### 2.17 媒体（`media.handlers.ts`）

| 当前 channel | preload 方法 | 目标文件 |
| --- | --- | --- |
| `media:pick-upload-image` | `pickUploadImage` | `media.handlers.ts` |

## 3. 通道命名迁移建议

- 阶段 2 保持现状：只按目标文件切分，不改 channel 名、不改 preload 方法名。
- 阶段 5 统一为 `domain:action`：
  - `system:ping`、`system:get-app-info`
  - `auth:login`、`auth:get-session`
  - `docs:list`、`docs:read-file`
  - `sync:pull`、`sync:push`
  - `read:list`、`read:article`
  - `review:list`、`review:submit`
  - `comment:list`、`comment:add`
  - `user:profile`、`user:follow`
  - `notify:list`、`notify:unread`
  - `chat:list`、`chat:send`
  - `settings:get`、`update:check`
  - `window:minimize`
  - `media:pick-upload-image`
- 迁移时保留旧方法名兼容层一个发布周期。

## 4. 待办清单

- [ ] 在阶段 1 中把本表固化为 `shared/contracts/ipc.ts` 的 Request/Response 类型。
- [ ] 在阶段 2 中按本表创建对应 handler 文件。
- [ ] 在阶段 5 中统一 channel 命名并更新本表。
