# Tauri 命令契约（冻结）

> 状态：**已冻结**（P1 契约冻结产物）。冻结基线：仓库 `07bc9af`，提交时间 `2026-11-21T12:48:00+08:00`。
> 权威来源：`src/shared/contracts/ipc.ts`（`IPC_CHANNEL_BY_METHOD`）、`src/shared/contracts/hqsf-api.ts`（`HqsfApi`）、`src/preload/index.ts`、`src/main/ipc/*.handlers.ts`（18 个文件）、`src/main/ipc/shared.ts`、`src/shared/domain/index.ts`、`src/shared/frontmatter.ts`。
> 本文档是后续 8 个并行迁移 lane 的**唯一契约依据**。通道名、渲染层方法名、参数名一律照抄源码（不做 `cid → contentId` 之类改写）；类型名取源码真实名字；缺陷/异常不修复、只记录（`src/` 零改动）。

**统计口径**：invoke 通道 **85** 条；事件通道 **2** 条；唯一通道名 **86** 个（`hqsf:update-state` 被 invoke 与事件复用）；`IPC_CHANNEL_BY_METHOD` 方法键 **87** 个（85 invoke + 2 事件订阅方法）。

**方法命名说明**：表中「渲染层方法」= `HqsfApi` 的方法名；实际调用形如 `window.hqsf.<method>(...)`。`windowControls` 为嵌套对象，调用形如 `window.hqsf.windowControls.<method>(...)`；`onMaximizedChanged` / `onUpdateState` 是事件订阅方法，返回取消订阅函数（非 invoke）。

---

## 1. 返回信封约定

| 项 | 约定 | 源码 |
| --- | --- | --- |
| 成功 | `{ ok: true, data: T }`（`ApiResult` 另允许顶层可选 `total?: number`） | `src/shared/domain/index.ts:22`；`src/main/ipc/shared.ts:6-8` |
| 失败 | `{ ok: false, error: string }` | `src/main/ipc/shared.ts:10-12` |
| 错误取值 | `fail(error)` 返回 `error: (error as Error).message`；**传字符串时 `.message` 为 `undefined`**（见异常 A3） | `src/main/ipc/shared.ts:10-12` |
| 裸值接口 | `ping` → `string`；`getAppInfo` → `AppInfo`；`windowControls.*` → `void`/`boolean`；**不包信封** | `src/preload/index.ts:54-56, 103-114` |
| 业务级失败 | `LoginResult.ok` / `PushResult.ok` / `ReviewSubmitResult.ok` / `CommentSubmitResult.ok` / `LogOpResult.ok` / `ClockResult.ok` / `followUser {ok,error?}` 是 **data 载荷内字段**，不是信封失败 | `src/shared/domain/index.ts:116-121, 135-141, 364-367, 485-488, 493-496, 630-639` |
| Rust 侧 | 命令返回 `Result<T, CommandError>`，由桥接层 `src/bridge/hqsf.ts` 统一包成上述信封；Rust 不直接产生 `{ok,...}` | `doc/design/Tauri迁移计划.md` §1.4 |

`ApiResult<T>` 精确定义（`src/shared/domain/index.ts:22`）：

```ts
export type ApiResult<T> = { ok: true; data: T; total?: number } | { ok: false; error: string }
```

---

## 2. 主表：85 条 invoke 通道

「实现位置」为 `ipcMain.handle` 注册行；「失败情形」只列源码真实存在的分支（`trusted` 拒绝 = `isTrustedSender` 为 false，见 `src/main/ipc/shared.ts:15-23`）。
`trusted` 拒绝时返回的错误文案 `'非法调用来源'` 定义于 `src/main/ipc/shared.ts:22`（`new Error('非法调用来源')`）；表中「trusted 拒绝」行引用的是各 handler 内的校验分支。

| 通道 | 渲染层方法 | 入参（TS 类型，对象展开到字段级） | 成功载荷类型 | 失败情形 | 实现位置 | Rust 命令名 | Rust 模块 | lane |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `hqsf:ping` | `ping` | 无 | string（裸值，非 ApiResult） | 无失败分支：直接返回 'pong'，不校验来源、无 try/catch（src/main/ipc/system.handlers.ts:5） | `src/main/ipc/system.handlers.ts:5` | `ping` | `system` | L1 |
| `hqsf:copy-text` | `copyText` | `text: string` | null | 无失败分支：clipboard.writeText 后恒 ok(null)（src/main/ipc/system.handlers.ts:6-9） | `src/main/ipc/system.handlers.ts:6` | `copy_text` | `system` | L1 |
| `hqsf:read-clipboard-text` | `readClipboardText` | 无 | string | 无失败分支：恒 ok(clipboard.readText())（src/main/ipc/system.handlers.ts:10） | `src/main/ipc/system.handlers.ts:10` | `read_clipboard_text` | `system` | L1 |
| `hqsf:read-clipboard-html` | `readClipboardHtml` | 无 | string | 无失败分支：恒 ok(clipboard.readHTML())（src/main/ipc/system.handlers.ts:11） | `src/main/ipc/system.handlers.ts:11` | `read_clipboard_html` | `system` | L1 |
| `hqsf:get-app-info` | `getAppInfo` | 无 | AppInfo（hqsf-api.ts:45-51：version:string; platform:string; arch:string; packaged:boolean; isAppImage?:boolean）（裸值，非 ApiResult） | 无失败分支：直接返回对象（src/main/ipc/system.handlers.ts:12-18） | `src/main/ipc/system.handlers.ts:12` | `get_app_info` | `system` | L1 |
| `hqsf:show-message-box` | `showMessageBox` | options: {<br>`type?: 'none' \| 'info' \| 'error' \| 'question' \| 'warning'`<br>`title?: string`<br>`message: string`<br>`detail?: string`<br>`buttons?: string[]`<br>`cancelId?: number`<br>`defaultId?: number`<br>} | { response: number } | trusted 拒绝 → '非法调用来源'（src/main/ipc/system.handlers.ts:33-34；src/main/ipc/shared.ts:21-23）<br>dialog.showMessageBox 抛错 → catch fail(err)（src/main/ipc/system.handlers.ts:53-54） | `src/main/ipc/system.handlers.ts:19` | `show_message_box` | `system` | L1 |
| `hqsf:window-minimize` | `windowControls.minimize` | 无 | void（裸值） | 无失败分支：windowOf(event)?.minimize()，无窗口时静默（src/main/ipc/window.handlers.ts:5-7） | `src/main/ipc/window.handlers.ts:5` | `window_minimize` | `window` | L1 |
| `hqsf:window-maximize-toggle` | `windowControls.toggleMaximize` | 无 | boolean（裸值） | 无失败分支：无窗口时返回 false（src/main/ipc/window.handlers.ts:8-14） | `src/main/ipc/window.handlers.ts:8` | `window_maximize_toggle` | `window` | L1 |
| `hqsf:window-close` | `windowControls.close` | 无 | void（裸值） | 无失败分支：windowOf(event)?.close()，无窗口时静默（src/main/ipc/window.handlers.ts:15-17） | `src/main/ipc/window.handlers.ts:15` | `window_close` | `window` | L1 |
| `hqsf:window-is-maximized` | `windowControls.isMaximized` | 无 | boolean（裸值） | 无失败分支：无窗口时返回 false（src/main/ipc/window.handlers.ts:18-20） | `src/main/ipc/window.handlers.ts:18` | `window_is_maximized` | `window` | L1 |
| `hqsf:toggle-devtools` | `toggleDevTools` | 无 | null | 窗口不存在 → fail(new Error('窗口不存在'))（src/main/ipc/window.handlers.ts:24） | `src/main/ipc/window.handlers.ts:22` | `toggle_devtools` | `window` | L1 |
| `hqsf:get-agreement` | `getAgreement` | 无 | AgreementData（domain:509-512：version:string; html:string） | 协议文件缺失 → 「未找到用户协议文件（已尝试: ${agreementPaths().join(', ')}）」（src/main/adapters/agreement.adapter.ts:38）<br>无版本号 → 「用户协议中未找到版本号（${file}，需在首部标注「版本：vX.Y」）」（src/main/adapters/agreement.adapter.ts:43）<br>catch → fail(err)（src/main/ipc/agreement.handlers.ts:9-11） | `src/main/ipc/agreement.handlers.ts:6` | `get_agreement` | `agreement` | L7c |
| `hqsf:login-password` | `loginPassword` | `name: string`<br>`password: string` | LoginResult（domain:116-121：ok:boolean; userinfo?:Record<string,unknown>; insecure?:boolean; error?:string） | trusted 拒绝 → '非法调用来源'（src/main/ipc/auth.handlers.ts:8-9）<br>服务层抛错 → catch fail(err)（src/main/ipc/auth.handlers.ts:15-16） | `src/main/ipc/auth.handlers.ts:7` | `login_password` | `auth` | L4 |
| `hqsf:get-session` | `getSession` | 无 | UserSession（domain:110-114：userinfo:Record<string,unknown>; insecure:boolean） \| null | 无失败分支：() => ok(getSession())，不校验来源、无 try/catch（src/main/ipc/auth.handlers.ts:19） | `src/main/ipc/auth.handlers.ts:19` | `get_session` | `auth` | L4 |
| `hqsf:verify-session` | `verifySession` | 无 | { valid: boolean; reachable: boolean } | 网络/校验异常 → catch fail(err)（src/main/ipc/auth.handlers.ts:23-24） | `src/main/ipc/auth.handlers.ts:20` | `verify_session` | `auth` | L4 |
| `hqsf:logout` | `logout` | 无 | null | trusted 拒绝 → '非法调用来源'（src/main/ipc/auth.handlers.ts:28-29）<br>服务层抛错 → catch fail(err)（src/main/ipc/auth.handlers.ts:33-34） | `src/main/ipc/auth.handlers.ts:27` | `logout` | `auth` | L4 |
| `hqsf:sync-pull` | `syncPull` | 无 | PullResult（domain:125-133：pulled:number; conflicts:number; total:number; errors:string[]） | trusted 拒绝 → '非法调用来源'（src/main/ipc/sync.handlers.ts:9-10）<br>未登录 → '未登录，无法同步'（src/main/ipc/sync.handlers.ts:13）<br>catch → fail(err)（src/main/ipc/sync.handlers.ts:16-17） | `src/main/ipc/sync.handlers.ts:8` | `sync_pull` | `sync` | L7c |
| `hqsf:sync-push` | `syncPush` | `filePath: string`<br>`isDraft: boolean`<br>meta?: ArticleMeta {<br>`category?: string`<br>`tags?: string[]`<br>`active?: string`<br>`isopen?: boolean`<br>} | PushResult（domain:135-141：ok:boolean; cid?:string; type?:ArticleType; error?:string） | trusted 拒绝 → '非法调用来源'（src/main/ipc/sync.handlers.ts:21-22）<br>未登录 → '未登录，无法同步'（src/main/ipc/sync.handlers.ts:24）<br>catch → fail(err)（src/main/ipc/sync.handlers.ts:27-28） | `src/main/ipc/sync.handlers.ts:20` | `sync_push` | `sync` | L7c |
| `hqsf:convert-to-draft` | `convertToDraft` | `cid: string` | ConvertDraftResult（domain:144-146：converted:boolean） | trusted 拒绝 → '非法调用来源'（src/main/ipc/sync.handlers.ts:32-33）<br>未登录 → '未登录，无法转存草稿'（src/main/ipc/sync.handlers.ts:35）<br>空 cid → '缺少文章 ID'（src/main/ipc/sync.handlers.ts:37）<br>catch → fail(err)（src/main/ipc/sync.handlers.ts:41-42） | `src/main/ipc/sync.handlers.ts:31` | `convert_to_draft` | `sync` | L7c |
| `hqsf:edit-remote-article` | `editRemoteArticle` | `cid: string` | EditRemoteResult（domain:149-154：filePath:string; converted:boolean） | trusted 拒绝 → '非法调用来源'（src/main/ipc/sync.handlers.ts:46-47）<br>未登录 → '未登录，无法编辑'（src/main/ipc/sync.handlers.ts:49）<br>空 cid → '缺少文章 ID'（src/main/ipc/sync.handlers.ts:51）<br>catch → fail(err)（src/main/ipc/sync.handlers.ts:55-56） | `src/main/ipc/sync.handlers.ts:45` | `edit_remote_article` | `sync` | L7c |
| `hqsf:get-docs-root` | `getDocsRoot` | 无 | string | 无失败分支：() => ok(getDocsRoot())，不校验来源、无 try/catch（src/main/ipc/docs.handlers.ts:7） | `src/main/ipc/docs.handlers.ts:7` | `get_docs_root` | `docs` | L2 |
| `hqsf:open-docs-dir` | `openDocsDir` | 无 | null | shell.openPath 返回非空错误串 → fail(new Error(err))（src/main/ipc/docs.handlers.ts:12）<br>catch → fail(err)（src/main/ipc/docs.handlers.ts:13-14） | `src/main/ipc/docs.handlers.ts:8` | `open_docs_dir` | `docs` | L2 |
| `hqsf:list-local-docs` | `listLocalDocs` | 无 | LocalNode[]（domain:158-171：name:string; path:string; rel:string; isDir:boolean; children?:LocalNode[]; mtime?:number; words?:number; summary?:string） | 读目录失败 → catch fail(err)（src/main/ipc/docs.handlers.ts:20-21） | `src/main/ipc/docs.handlers.ts:17` | `list_local_docs` | `docs` | L2 |
| `hqsf:read-local-file` | `readLocalFile` | `path: string` | string（文件全文） | 路径越界 → 「路径越界：仅允许访问本地存档目录」（src/main/infra/fs/index.ts:41）/「路径越界：符号链接指向存档目录之外」（src/main/infra/fs/index.ts:47）<br>文件不存在/读盘失败 → catch fail(err)（src/main/ipc/docs.handlers.ts:27-28） | `src/main/ipc/docs.handlers.ts:24` | `read_local_file` | `docs` | L2 |
| `hqsf:file-exists` | `fileExists` | `path: string` | boolean | trusted 拒绝 → '非法调用来源'（src/main/ipc/docs.handlers.ts:32-33）<br>assertInside 越界抛错 → 「路径越界：仅允许访问本地存档目录」/「路径越界：符号链接指向存档目录之外」（src/main/infra/fs/index.ts:41/47）<br>catch → fail(err)（src/main/ipc/docs.handlers.ts:36-37） | `src/main/ipc/docs.handlers.ts:31` | `file_exists` | `docs` | L2 |
| `hqsf:write-local-file` | `writeLocalFile` | `path: string`<br>`content: string` | null | assertInside 越界 → 「路径越界：仅允许访问本地存档目录」/「路径越界：符号链接指向存档目录之外」（src/main/infra/fs/index.ts:41/47）<br>写盘失败 → catch fail(err)（src/main/ipc/docs.handlers.ts:44-45） | `src/main/ipc/docs.handlers.ts:40` | `write_local_file` | `docs` | L2 |
| `hqsf:create-local-draft` | `createLocalDraft` | `title: string`<br>`content: string`<br>`dirRel?: string` | string（新建文件绝对路径） | assertInside 越界 → 「路径越界：仅允许访问本地存档目录」/「路径越界：符号链接指向存档目录之外」（src/main/infra/fs/index.ts:41/47）<br>写盘失败 → catch fail(err)（src/main/ipc/docs.handlers.ts:51-52） | `src/main/ipc/docs.handlers.ts:48` | `create_local_draft` | `docs` | L2 |
| `hqsf:create-local-dir` | `createLocalDir` | `rel: string` | string（新建目录绝对路径） | 同名文件已存在 → 「同名文件已存在」（src/main/infra/fs/index.ts:141）<br>越界 → 「路径越界：仅允许访问本地存档目录」/「路径越界：符号链接指向存档目录之外」（src/main/infra/fs/index.ts:41/47）<br>catch → fail(err)（src/main/ipc/docs.handlers.ts:87-88） | `src/main/ipc/docs.handlers.ts:84` | `create_local_dir` | `docs` | L2 |
| `hqsf:delete-local-file` | `deleteLocalDoc` | `path: string` | null | 目标为目录 → 「不能删除目录，仅支持删除文章文件」（src/main/infra/fs/index.ts:153）<br>文件不存在 → 「文件不存在」（src/main/infra/fs/index.ts:160）<br>catch → fail(err)（src/main/ipc/docs.handlers.ts:59-60） | `src/main/ipc/docs.handlers.ts:55` | `delete_local_file` | `docs` | L2 |
| `hqsf:rename-local-node` | `renameLocalNode` | `oldRel: string`<br>`newRel: string` | { from: string; to: string } | trusted 拒绝 → '非法调用来源'（src/main/ipc/docs.handlers.ts:64-65）<br>源路径不存在 → 「源路径不存在」（src/main/infra/fs/index.ts:216）<br>目标路径已存在 → 「目标路径已存在」（src/main/infra/fs/index.ts:217）<br>catch → fail(err)（src/main/ipc/docs.handlers.ts:69-70） | `src/main/ipc/docs.handlers.ts:63` | `rename_local_node` | `docs` | L2 |
| `hqsf:reveal-in-folder` | `revealInFolder` | `path: string` | null | trusted 拒绝 → '非法调用来源'（src/main/ipc/docs.handlers.ts:74-75）<br>assertInside 越界 → 「路径越界：仅允许访问本地存档目录」/「路径越界：符号链接指向存档目录之外」（src/main/infra/fs/index.ts:41/47）<br>catch → fail(err)（src/main/ipc/docs.handlers.ts:80-81） | `src/main/ipc/docs.handlers.ts:73` | `reveal_in_folder` | `docs` | L2 |
| `hqsf:choose-docs-dir` | `chooseDocsDir` | 无 | string \| null（用户取消为 null） | 对话框异常 → catch fail(err)（src/main/ipc/docs.handlers.ts:95-96） | `src/main/ipc/docs.handlers.ts:91` | `choose_docs_dir` | `docs` | L2 |
| `hqsf:list-articles` | `listArticles` | 无 | ArticleRow[]（domain:86-105：cid:string; title:string; type:ArticleType; status:string; authorId:string; remoteModified:number; localModified:number; contentHash:string; filePath:string; syncedAt:number; createdAt:number; updatedAt:number） | 索引读取失败 → catch fail(err)（src/main/ipc/docs.handlers.ts:104-105） | `src/main/ipc/docs.handlers.ts:99` | `list_articles` | `docs` | L2 |
| `hqsf:list-remote-articles` | `listRemoteArticles` | opts?: ArticleListOptions {<br>`searchParams?: Record<string, unknown>`<br>`mid?: number \| string`<br>`choice?: boolean`<br>`limit?: number`<br>`page?: number`<br>`order?: string`<br>`searchKey?: string`<br>} | { items: RemoteArticle[]; total: number } | 网络/接口异常 → catch fail(err)（src/main/ipc/read.handlers.ts:12-13）；不校验来源 | `src/main/ipc/read.handlers.ts:8` | `list_remote_articles` | `read` | L7a |
| `hqsf:get-remote-article` | `getRemoteArticle` | `cid: string` | ArticleDetail（domain:220-250） | 未登录且服务端确认不可读 → fail(new Error('阅读全文需要登录（${inner}）'))（src/main/ipc/read.handlers.ts:27-30）<br>其余异常 → catch fail(err)（src/main/ipc/read.handlers.ts:31） | `src/main/ipc/read.handlers.ts:16` | `get_remote_article` | `read` | L7a |
| `hqsf:list-reviews` | `listReviews` | opts?: {<br>`cid?: string`<br>`activeid?: number \| string`<br>`limit?: number`<br>`page?: number`<br>`order?: string`<br>} | { items: ReviewItem[]; total: number } | 网络/接口异常 → catch fail(err)（src/main/ipc/review.handlers.ts:12-13） | `src/main/ipc/review.handlers.ts:8` | `list_reviews` | `review` | L7a |
| `hqsf:submit-review` | `submitReview` | payload: ReviewPayload {<br>`dianzi: string`<br>`wenbi: string`<br>`renwu: string`<br>`jiezou: string`<br>`liyi: string`<br>`zonghe?: string`<br>`dianziScore: number`<br>`wenbiScore: number`<br>`renwuScore: number`<br>`jiezouScore: number`<br>`liyiScore: number`<br>`cid: string`<br>`activeid?: number \| string`<br>`id?: number \| string`<br>} | ReviewSubmitResult（domain:364-367：ok:boolean; error?:string） | trusted 拒绝 → '非法调用来源'（src/main/ipc/review.handlers.ts:17-18）<br>未登录 → '未登录，无法评审'（src/main/ipc/review.handlers.ts:20）<br>载荷非对象 → '无效的评审数据'（src/main/ipc/review.handlers.ts:22）<br>cid 为空 → '缺少目标文章 ID'（src/main/ipc/review.handlers.ts:23）<br>id 类型非法 → '无效的评审 ID'（src/main/ipc/review.handlers.ts:25）<br>某维评语 <10 字 → 「「${d}」评语需至少 10 字」（src/main/ipc/review.handlers.ts:30）<br>某维评分不在 0-10 → 「「${d}」评分需在 0-10 之间」（src/main/ipc/review.handlers.ts:33）<br>catch → fail(err)（src/main/ipc/review.handlers.ts:38-39） | `src/main/ipc/review.handlers.ts:16` | `submit_review` | `review` | L7a |
| `hqsf:set-review-attitude` | `setReviewAttitude` | `reviewId: number \| string`<br>`type: number` | ReviewSubmitResult（domain:364-367：ok:boolean; error?:string） | trusted 拒绝 → '非法调用来源'（src/main/ipc/review.handlers.ts:43-44）<br>未登录 → '未登录'（src/main/ipc/review.handlers.ts:46）<br>catch → fail(err)（src/main/ipc/review.handlers.ts:49-50） | `src/main/ipc/review.handlers.ts:42` | `set_review_attitude` | `review` | L7a |
| `hqsf:list-review-tasks` | `listReviewTasks` | 无 | ReviewTaskItem[]（domain:372-383：cid:string; status:number; activeid?:number\|string; activeName?:string; articleTitle?:string; created?:number） | 无 uid → ok([])（src/main/ipc/review.handlers.ts:58，非失败）<br>catch → fail(err)（src/main/ipc/review.handlers.ts:61-62） | `src/main/ipc/review.handlers.ts:53` | `list_review_tasks` | `review` | L7a |
| `hqsf:list-my-reviews` | `listMyReviews` | 无 | { cids: string[] } | 无 uid → ok({ cids: [] })（src/main/ipc/review.handlers.ts:70，非失败）<br>catch → fail(err)（src/main/ipc/review.handlers.ts:73-74） | `src/main/ipc/review.handlers.ts:65` | `list_my_reviews` | `review` | L7a |
| `hqsf:list-comments` | `listComments` | `cid: string`<br>opts?: {<br>`limit?: number`<br>`page?: number`<br>`order?: string`<br>} | CommentListResult（domain:477-482：items:CommentItem[]; total:number; nextPage:number; hasMore:boolean） | trusted 拒绝 → '非法调用来源'（src/main/ipc/comment.handlers.ts:8-9）<br>空 cid → '缺少文章 ID'（src/main/ipc/comment.handlers.ts:12）<br>catch → fail(err)（src/main/ipc/comment.handlers.ts:15-16） | `src/main/ipc/comment.handlers.ts:7` | `list_comments` | `comment` | L7a |
| `hqsf:list-recent-comments` | `listRecentComments` | opts?: {<br>`limit?: number`<br>`page?: number`<br>`order?: string`<br>} | { items: CommentItem[]; total: number } | trusted 拒绝 → '非法调用来源'（src/main/ipc/comment.handlers.ts:20-21）<br>catch → fail(err)（src/main/ipc/comment.handlers.ts:25-26） | `src/main/ipc/comment.handlers.ts:19` | `list_recent_comments` | `comment` | L7a |
| `hqsf:add-comment` | `addComment` | payload: {<br>`cid: string`<br>`text: string`<br>`parent?: number \| string`<br>`reviewid?: number \| string`<br>} | CommentSubmitResult（domain:485-488：ok:boolean; error?:string） | trusted 拒绝 → '非法调用来源'（src/main/ipc/comment.handlers.ts:32-33）<br>未登录 → '未登录，无法评论'（src/main/ipc/comment.handlers.ts:35）<br>载荷非对象 → '无效的评论数据'（src/main/ipc/comment.handlers.ts:36）<br>cid 为空 → '缺少目标文章 ID'（src/main/ipc/comment.handlers.ts:38）<br>正文 <4 字 → '评论内容至少 4 个字'（src/main/ipc/comment.handlers.ts:40）<br>正文 >2000 字 → '评论内容过长（最多 2000 字）'（src/main/ipc/comment.handlers.ts:41）<br>parent 类型非法 → '无效的回复目标'（src/main/ipc/comment.handlers.ts:43）<br>reviewid 类型非法 → '无效的评审关联'（src/main/ipc/comment.handlers.ts:47）<br>catch → fail(err)（src/main/ipc/comment.handlers.ts:51-52） | `src/main/ipc/comment.handlers.ts:29` | `add_comment` | `comment` | L7a |
| `hqsf:search-comments` | `searchComments` | `keyword: string`<br>`limit?: number` | { items: CommentItem[]; total: number } | trusted 拒绝 → '非法调用来源'（src/main/ipc/search.handlers.ts:10-11）<br>catch → fail(err)（src/main/ipc/search.handlers.ts:16-17）；limit 缺省 10（src/main/ipc/search.handlers.ts:14） | `src/main/ipc/search.handlers.ts:9` | `search_comments` | `search` | L7a |
| `hqsf:search-reviews` | `searchReviews` | `keyword: string`<br>`limit?: number` | { items: ReviewItem[]; total: number } | trusted 拒绝 → '非法调用来源'（src/main/ipc/search.handlers.ts:21-22）<br>catch → fail(err)（src/main/ipc/search.handlers.ts:27-28）；limit 缺省 10（src/main/ipc/search.handlers.ts:25） | `src/main/ipc/search.handlers.ts:20` | `search_reviews` | `search` | L7a |
| `hqsf:search-users` | `searchUsers` | `keyword: string`<br>`limit?: number` | { items: UserSearchResult[]; total: number } | trusted 拒绝 → '非法调用来源'（src/main/ipc/search.handlers.ts:32-33）<br>catch → fail(err)（src/main/ipc/search.handlers.ts:38-39）；limit 缺省 10（src/main/ipc/search.handlers.ts:36） | `src/main/ipc/search.handlers.ts:31` | `search_users` | `search` | L7a |
| `hqsf:list-categories` | `listCategories` | 无 | Array<{ mid: number \| string; name: string; slug: string; description?: string; imgurl?: string; count?: number }> | 网络/接口异常 → catch fail(err)（src/main/ipc/browse.handlers.ts:11-12） | `src/main/ipc/browse.handlers.ts:7` | `list_categories` | `browse` | L7b |
| `hqsf:list-metas` | `listMetas` | `type: string` | MetaInfo[]（domain:269-285：mid:number\|string; type:string; name:string; slug:string; description?:string; imgurl?:string; count?:number; deadline?:number; isReview?:number; activeStatus?:number） | 网络/接口异常 → catch fail(err)（src/main/ipc/browse.handlers.ts:19-20） | `src/main/ipc/browse.handlers.ts:15` | `list_metas` | `browse` | L7b |
| `hqsf:check-forbidden` | `checkForbidden` | `title: string`<br>`text: string` | { code: number; msg: string } | trusted 拒绝 → '非法调用来源'（src/main/ipc/browse.handlers.ts:24-25）<br>未登录 → fail('未登录')（src/main/ipc/browse.handlers.ts:28）：fail 取字符串的 .message，实际返回 { ok:false }（error 缺省，见异常 A3）<br>catch → fail(err)（src/main/ipc/browse.handlers.ts:31-32） | `src/main/ipc/browse.handlers.ts:23` | `check_forbidden` | `browse` | L7b |
| `hqsf:list-gpt-models` | `listGptModels` | 无 | GptModel[]（domain:288-297：id:number\|string; name:string; intro:string; avatar?:string; type:number; price:number; source:string） | 网络/接口异常 → catch fail(err)（src/main/ipc/browse.handlers.ts:39-40） | `src/main/ipc/browse.handlers.ts:35` | `list_gpt_models` | `browse` | L7b |
| `hqsf:get-private-chat` | `getPrivateChat` | `touid: number \| string` | { chatid: string } | trusted 拒绝 → '非法调用来源'（src/main/ipc/chat.handlers.ts:8-9）<br>未登录 → '未登录，无法私聊'（src/main/ipc/chat.handlers.ts:11）<br>catch → fail(err)（src/main/ipc/chat.handlers.ts:14-15） | `src/main/ipc/chat.handlers.ts:7` | `get_private_chat` | `chat` | L7b |
| `hqsf:list-chat-sessions` | `listChatSessions` | 无 | { items: ChatSession[] } | trusted 拒绝 → '非法调用来源'（src/main/ipc/chat.handlers.ts:19-20）<br>未登录 → ok({ items: [] })（src/main/ipc/chat.handlers.ts:22，非失败）<br>catch → fail(err)（src/main/ipc/chat.handlers.ts:25-26） | `src/main/ipc/chat.handlers.ts:18` | `list_chat_sessions` | `chat` | L7b |
| `hqsf:list-chat-messages` | `listChatMessages` | `chatid: string` | { items: ChatMessage[] } | trusted 拒绝 → '非法调用来源'（src/main/ipc/chat.handlers.ts:30-31）<br>未登录 → '未登录，无法私聊'（src/main/ipc/chat.handlers.ts:33）<br>catch → fail(err)（src/main/ipc/chat.handlers.ts:36-37） | `src/main/ipc/chat.handlers.ts:29` | `list_chat_messages` | `chat` | L7b |
| `hqsf:send-chat-message` | `sendChatMessage` | `chatid: string`<br>`msg: string` | null | trusted 拒绝 → '非法调用来源'（src/main/ipc/chat.handlers.ts:41-42）<br>未登录 → '未登录，无法私聊'（src/main/ipc/chat.handlers.ts:44）<br>服务端 code!==1 → resp.msg 或 '发送失败'（src/main/adapters/chat.adapter.ts:78）<br>catch → fail(err)（src/main/ipc/chat.handlers.ts:48-49） | `src/main/ipc/chat.handlers.ts:40` | `send_chat_message` | `chat` | L7b |
| `hqsf:add-log` | `addLog` | `type: 'likes' \| 'mark' \| 'reward'`<br>`params: Record<string, unknown>` | LogOpResult（domain:493-496：ok:boolean; error?:string） | trusted 拒绝 → '非法调用来源'（src/main/ipc/interact.handlers.ts:8-9）<br>未登录 → '未登录，无法操作'（src/main/ipc/interact.handlers.ts:11）<br>type 非三值之一 → '未知的操作类型'（src/main/ipc/interact.handlers.ts:12）<br>params.cid 为空 → '缺少目标文章 ID'（src/main/ipc/interact.handlers.ts:14）<br>reward 的 num 非 1-10000 整数 → '投币数量需为 1-10000 的整数'（src/main/ipc/interact.handlers.ts:18）<br>likes 的 num 非 1/-1 → '点赞参数错误（num 需为 1 或 -1）'（src/main/ipc/interact.handlers.ts:25）<br>⚠ 无 try/catch：服务层抛错使 invoke 直接 reject，不符合 {ok:false,error} 约定（见异常 A4） | `src/main/ipc/interact.handlers.ts:7` | `add_log` | `interact` | L7b |
| `hqsf:is-mark` | `isMark` | `cid: string` | MarkStatus（domain:499-504：marked:boolean; logid?:number\|string） | trusted 拒绝 → '非法调用来源'（src/main/ipc/interact.handlers.ts:31-32）<br>未登录 → '未登录'（src/main/ipc/interact.handlers.ts:34）<br>空 cid → '缺少文章 ID'（src/main/ipc/interact.handlers.ts:36）<br>catch → fail(err)（src/main/ipc/interact.handlers.ts:39-40） | `src/main/ipc/interact.handlers.ts:30` | `is_mark` | `interact` | L7b |
| `hqsf:remove-log` | `removeLog` | `key: number \| string` | LogOpResult（domain:493-496：ok:boolean; error?:string） | trusted 拒绝 → '非法调用来源'（src/main/ipc/interact.handlers.ts:44-45）<br>未登录 → '未登录'（src/main/ipc/interact.handlers.ts:47）<br>空 key → '缺少收藏记录 ID'（src/main/ipc/interact.handlers.ts:49）<br>catch → fail(err)（src/main/ipc/interact.handlers.ts:52-53） | `src/main/ipc/interact.handlers.ts:43` | `remove_log` | `interact` | L7b |
| `hqsf:list-notifications` | `listNotifications` | 无 | { items: AppNotification[]; totalUnread: number } | trusted 拒绝 → '非法调用来源'（src/main/ipc/notify.handlers.ts:10-11）<br>未登录 → ok({ items: [], totalUnread: 0 })（src/main/ipc/notify.handlers.ts:13，非失败）<br>catch → fail(err)（src/main/ipc/notify.handlers.ts:39-40） | `src/main/ipc/notify.handlers.ts:9` | `list_notifications` | `notify` | L7b |
| `hqsf:get-unread-count` | `getUnreadCount` | 无 | { total: number } | trusted 拒绝 → '非法调用来源'（src/main/ipc/notify.handlers.ts:44-45）<br>未登录 → ok({ total: 0 })（src/main/ipc/notify.handlers.ts:47，非失败）<br>catch → fail(err)（src/main/ipc/notify.handlers.ts:50-51） | `src/main/ipc/notify.handlers.ts:43` | `get_unread_count` | `notify` | L7b |
| `hqsf:mark-notifications-read` | `markNotificationsRead` | `categories: string[]` | null | trusted 拒绝 → '非法调用来源'（src/main/ipc/notify.handlers.ts:55-56）<br>未登录 → '未登录，无法标记已读'（src/main/ipc/notify.handlers.ts:58）<br>catch → fail(err)（src/main/ipc/notify.handlers.ts:62-63） | `src/main/ipc/notify.handlers.ts:54` | `mark_notifications_read` | `notify` | L7b |
| `hqsf:user-profile` | `getUserProfile` | `uid: string \| number` | UserProfile（domain:517-533） | 网络/接口异常 → catch fail(err)（src/main/ipc/user.handlers.ts:12-13）；uid 经 checkedUid 归一化，非法值按 '0' 处理（src/main/ipc/shared.ts:37-39） | `src/main/ipc/user.handlers.ts:9` | `user_profile` | `user` | L7b |
| `hqsf:user-stats` | `getUserStats` | `uid: string \| number` | UserStats \| null（domain:547-553：fanNum:number; contentsNum:number; commentsNum:number; isClock:number） | 网络/接口异常 → catch fail(err)（src/main/ipc/user.handlers.ts:19-20） | `src/main/ipc/user.handlers.ts:16` | `user_stats` | `user` | L7b |
| `hqsf:user-self-status` | `getSelfStatus` | 无 | SelfStatus \| null（domain:642-654：assets:number; experience?:number; lv?:number\|string; name?:string; screenName?:string; avatar?:string; userBg?:string; introduce?:string; mail?:string; phone?:string） | 未登录 → ok(null)（src/main/ipc/user.handlers.ts:26，非失败）<br>catch → fail(err)（src/main/ipc/user.handlers.ts:28-29） | `src/main/ipc/user.handlers.ts:23` | `user_self_status` | `user` | L7b |
| `hqsf:user-follow-state` | `getFollowState` | `uid: string \| number` | boolean | 网络/接口异常 → catch fail(err)（src/main/ipc/user.handlers.ts:35-36） | `src/main/ipc/user.handlers.ts:32` | `user_follow_state` | `user` | L7b |
| `hqsf:user-follow` | `followUser` | `uid: string \| number`<br>`follow: boolean` | { ok: boolean; error?: string } | trusted 拒绝 → '非法调用来源'（src/main/ipc/user.handlers.ts:40-41）<br>网络/接口异常 → catch fail(err)（src/main/ipc/user.handlers.ts:44-45） | `src/main/ipc/user.handlers.ts:39` | `user_follow` | `user` | L7b |
| `hqsf:user-follow-list` | `listFollows` | `uid: string \| number`<br>`page?: number`<br>`limit?: number` | { items: UserFollowItem[]; total: number } | 网络/接口异常 → catch fail(err)（src/main/ipc/user.handlers.ts:51-52）；page/limit 缺省 1/20（src/main/ipc/user.handlers.ts:48） | `src/main/ipc/user.handlers.ts:48` | `user_follow_list` | `user` | L7b |
| `hqsf:user-fan-list` | `listFans` | `uid: string \| number`<br>`page?: number`<br>`limit?: number` | { items: UserFollowItem[]; total: number } | 网络/接口异常 → catch fail(err)（src/main/ipc/user.handlers.ts:58-59）；page/limit 缺省 1/20（src/main/ipc/user.handlers.ts:55） | `src/main/ipc/user.handlers.ts:55` | `user_fan_list` | `user` | L7b |
| `hqsf:user-marks` | `listMarks` | `page?: number`<br>`limit?: number` | { items: UserMarkItem[]; total: number } | trusted 拒绝 → '非法调用来源'（src/main/ipc/user.handlers.ts:63-64）<br>未登录 → '未登录，无法查看收藏'（src/main/ipc/user.handlers.ts:67）<br>catch → fail(err)（src/main/ipc/user.handlers.ts:69-70） | `src/main/ipc/user.handlers.ts:62` | `user_marks` | `user` | L7b |
| `hqsf:user-articles` | `listUserArticles` | `uid: string \| number`<br>`page?: number`<br>`limit?: number` | { items: RemoteArticle[]; total: number } | 网络/接口异常 → catch fail(err)（src/main/ipc/user.handlers.ts:76-77） | `src/main/ipc/user.handlers.ts:73` | `user_articles` | `user` | L7b |
| `hqsf:user-reviews` | `listUserReviews` | `uid: string \| number`<br>`page?: number`<br>`limit?: number` | { items: ReviewItem[]; total: number } | 网络/接口异常 → catch fail(err)（src/main/ipc/user.handlers.ts:83-84） | `src/main/ipc/user.handlers.ts:80` | `user_reviews` | `user` | L7b |
| `hqsf:user-comments` | `listUserComments` | `uid: string \| number`<br>`page?: number`<br>`limit?: number` | CommentListResult（domain:477-482：items:CommentItem[]; total:number; nextPage:number; hasMore:boolean） | 网络/接口异常 → catch fail(err)（src/main/ipc/user.handlers.ts:90-91） | `src/main/ipc/user.handlers.ts:87` | `user_comments` | `user` | L7b |
| `hqsf:user-feed` | `listFollowFeed` | 无 | FollowFeedItem[]（domain:595-627） | trusted 拒绝 → '非法调用来源'（src/main/ipc/user.handlers.ts:95-96）<br>未登录 → ok([])（src/main/ipc/user.handlers.ts:100，非失败）<br>catch → fail(err)（src/main/ipc/user.handlers.ts:102-103） | `src/main/ipc/user.handlers.ts:94` | `user_feed` | `user` | L7b |
| `hqsf:user-clock` | `clockIn` | 无 | ClockResult（domain:630-639：ok:boolean; error?:string; award?:number; addExp?:number; assets?:number） | trusted 拒绝 → '非法调用来源'（src/main/ipc/user.handlers.ts:107-108）<br>未登录 → '未登录，无法签到'（src/main/ipc/user.handlers.ts:111）<br>catch → fail(err)（src/main/ipc/user.handlers.ts:113-114） | `src/main/ipc/user.handlers.ts:106` | `user_clock` | `user` | L7b |
| `hqsf:user-update-profile` | `userUpdateProfile` | payload: UserProfileUpdatePayload {<br>`screenName?: string`<br>`avatar?: string`<br>`userBg?: string`<br>`introduce?: string`<br>`mail?: string`<br>`phone?: string`<br>} | null | trusted 拒绝 → '非法调用来源'（src/main/ipc/user.handlers.ts:118-119）<br>未登录 → '未登录，无法修改资料'（src/main/ipc/user.handlers.ts:121）<br>载荷非对象 → '无效的资料数据'（src/main/ipc/user.handlers.ts:123）<br>catch → fail(err)（src/main/ipc/user.handlers.ts:134-135） | `src/main/ipc/user.handlers.ts:117` | `user_update_profile` | `user` | L7b |
| `hqsf:pick-upload-user-image` | `pickUploadUserImage` | 无 | { url: string } \| null（用户取消为 null） | trusted 拒绝 → '非法调用来源'（src/main/ipc/user.handlers.ts:139-140）<br>未登录 → '未登录，无法上传图片'（src/main/ipc/user.handlers.ts:142）<br>catch → fail(err)（src/main/ipc/user.handlers.ts:146-147） | `src/main/ipc/user.handlers.ts:138` | `pick_upload_user_image` | `user` | L7b |
| `hqsf:get-settings` | `getSettings` | 无 | AppSettings（domain:39-50：autoUpdate:boolean; hardwareAccel:boolean; zoomFactor:number; customCss:string; customJs:string） | trusted 拒绝 → '非法调用来源'（src/main/ipc/settings.handlers.ts:11-12）<br>catch → fail(err)（src/main/ipc/settings.handlers.ts:15-16） | `src/main/ipc/settings.handlers.ts:10` | `get_settings` | `settings` | L1 |
| `hqsf:update-settings` | `updateSettings` | patch: Partial<AppSettings> {<br>`autoUpdate?: boolean`<br>`hardwareAccel?: boolean`<br>`zoomFactor?: number`<br>`customCss?: string`<br>`customJs?: string`<br>} | AppSettings（domain:39-50：autoUpdate:boolean; hardwareAccel:boolean; zoomFactor:number; customCss:string; customJs:string） | trusted 拒绝 → '非法调用来源'（src/main/ipc/settings.handlers.ts:20-21）<br>patch 非对象/为数组 → '无效的设置数据'（src/main/ipc/settings.handlers.ts:24）<br>catch → fail(err)（src/main/ipc/settings.handlers.ts:39-40） | `src/main/ipc/settings.handlers.ts:19` | `update_settings` | `settings` | L1 |
| `hqsf:get-changelog` | `getChangelog` | 无 | ChangelogData（domain:62-65：version:string; markdown:string） | catch → fail(err)（src/main/ipc/settings.handlers.ts:46-47） | `src/main/ipc/settings.handlers.ts:43` | `get_changelog` | `settings` | L1 |
| `hqsf:clear-cache` | `clearCache` | 无 | ClearCacheResult（domain:67-69：freedBytes:number） | trusted 拒绝 → '非法调用来源'（src/main/ipc/settings.handlers.ts:51-52）<br>catch → fail(err)（src/main/ipc/settings.handlers.ts:62-63）；清除 session 缓存失败被忽略（src/main/ipc/settings.handlers.ts:56-60） | `src/main/ipc/settings.handlers.ts:50` | `clear_cache` | `settings` | L1 |
| `hqsf:uninstall` | `uninstall` | 无 | null | trusted 拒绝 → '非法调用来源'（src/main/ipc/settings.handlers.ts:67-68）<br>非 Windows → '当前平台不支持应用内卸载；请使用系统包管理器或删除应用目录'（src/main/ipc/settings.handlers.ts:71）<br>catch → fail(err)（src/main/ipc/settings.handlers.ts:75-76） | `src/main/ipc/settings.handlers.ts:66` | `uninstall` | `settings` | L1 |
| `hqsf:update-state` | `getUpdateState` | 无 | UpdateState（domain:53-60：{status:'idle'} \| {status:'checking'} \| {status:'available';version:string;notes?:string;url?:string} \| {status:'not-available'} \| {status:'downloading';percent:number} \| {status:'downloaded';version:string;notes?:string} \| {status:'error';message:string}） | 无失败分支：() => ok(getUpdateState())，不校验来源、无 try/catch（src/main/ipc/updater.handlers.ts:6） | `src/main/ipc/updater.handlers.ts:6` | `update_state` | `updater` | L4 |
| `hqsf:update-check` | `checkForUpdates` | 无 | UpdateState（domain:53-60：{status:'idle'} \| {status:'checking'} \| {status:'available';version:string;notes?:string;url?:string} \| {status:'not-available'} \| {status:'downloading';percent:number} \| {status:'downloaded';version:string;notes?:string} \| {status:'error';message:string}） | 检查失败 → catch fail(err)（src/main/ipc/updater.handlers.ts:10-11） | `src/main/ipc/updater.handlers.ts:7` | `update_check` | `updater` | L4 |
| `hqsf:update-download` | `downloadUpdate` | 无 | null | 无可下载更新（status!=='available' 或 url 为空）→ '当前没有可下载的更新'（src/main/ipc/updater.handlers.ts:17-19）<br>catch → fail(err)（src/main/ipc/updater.handlers.ts:22-23） | `src/main/ipc/updater.handlers.ts:14` | `update_download` | `updater` | L4 |
| `hqsf:update-install` | `installUpdate` | 无 | null | 无可安装更新（status!=='available' 或 url 为空）→ '当前没有可安装的更新'（src/main/ipc/updater.handlers.ts:29-31）<br>catch → fail(err)（src/main/ipc/updater.handlers.ts:34-35） | `src/main/ipc/updater.handlers.ts:26` | `update_install` | `updater` | L4 |
| `media:pick-upload-image` | `pickUploadImage` | 无 | { url: string } \| null（用户取消为 null） | trusted 拒绝 → '非法调用来源'（src/main/ipc/media.handlers.ts:8-9）<br>未登录 → fail('未登录，无法上传图片')（src/main/ipc/media.handlers.ts:11）：fail 取字符串的 .message，实际返回 { ok:false }（error 缺省，见异常 A3）<br>catch → fail(err)（src/main/ipc/media.handlers.ts:15-16） | `src/main/ipc/media.handlers.ts:7` | `pick_upload_image` | `media` | L5 |

> 主表行数：85（由脚本核对 `C.length === 85`，且与 85 个 `ipcMain.handle` 注册项双向全等）。

---

## 3. 事件通道（2 条，主进程 → 渲染层）

| 事件通道 | 渲染层方法 | 载荷类型 | 主进程发送点 | preload 订阅点 | Rust 模块 | lane | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `hqsf:window-maximized-changed` | `windowControls.onMaximizedChanged` | boolean | `src/main/window/index.ts:70-71` | `src/preload/index.ts:109-113` | `window` | L1 | 窗口 maximize/unmaximize 时经 webContents.send 推送；preload 用 ipcRenderer.on 订阅，返回取消订阅函数 |
| `hqsf:update-state` | `onUpdateState` | UpdateState（domain:53-60） | `src/main/infra/updater/index.ts:44` | `src/preload/index.ts:263-267` | `updater` | L4 | 通道名与 invoke 通道 hqsf:update-state 复用（updater.handlers.ts:6）；事件由 updater 状态变化时 webContents.send 推送 |

---

## 4. 三来源交叉核对

| # | 来源 | 实测数量 | 明细 |
| --- | --- | --- | --- |
| 1 | `src/shared/contracts/ipc.ts` `IPC_CHANNEL_BY_METHOD` | **87 方法键 / 86 唯一通道名** | 85 个 invoke 方法键 + 2 个事件订阅方法键（`windowControls_onMaximizedChanged`、`onUpdateState`）；`hqsf:update-state` 出现 2 次（`getUpdateState` 与 `onUpdateState`），故唯一通道名 86 |
| 2 | `src/main/ipc/*.handlers.ts` `ipcMain.handle` | **85** | 18 个文件合计 85 处注册，其中 `media.handlers.ts` 1 条为 `media:pick-upload-image`（非 `hqsf:` 前缀） |
| 3 | `src/preload/index.ts` | **85 invoke + 2 on** | `ipcRenderer.invoke(` 85 处、`ipcRenderer.on(` 2 处；`window.hqsf` 暴露 87 个可调用成员（`windowControls` 为嵌套对象，含 5 个成员） |

**结论**：85 条 invoke 通道在「契约表 ↔ handler 注册 ↔ preload invoke」三方 **1:1 完全一致，零缺失、零多余**。

**差异（相对「85 条通道」的表述）**：

1. `IPC_CHANNEL_BY_METHOD` 有 **87 个方法键**，不是 85：多出的 2 个是事件订阅方法（`windowControls_onMaximizedChanged`、`onUpdateState`），它们不对应 `ipcMain.handle`。
2. 唯一通道名是 **86** 个，不是 85 或 87：`hqsf:update-state` 同时是 invoke 通道（`src/main/ipc/updater.handlers.ts:6`）与事件通道（发送点 `src/main/infra/updater/index.ts:44`）。
3. 事件通道共 **2** 条（`hqsf:window-maximized-changed`、`hqsf:update-state`），不是任务描述里的 1 条；其中仅 `hqsf:window-maximized-changed` 是纯事件通道。
4. 全表唯一非 `hqsf:` 前缀通道：`media:pick-upload-image`（`src/main/ipc/media.handlers.ts:7`）——这是 grep `hqsf:` 漏掉的那 1 条，已逐字核对。
5. 交叉核对脚本断言：`table − handlers = {hqsf:window-maximized-changed}`（纯事件，无 handler，符合预期）；`handlers − table = ∅`。

---

## 5. 参数与渲染层调用的对应关系

扫描方式：`grep -rn 'window\.hqsf' src/renderer --include=*.ts --include=*.tsx`，共 **188 处调用点**（含 3 处跨行写法 `window.hqsf` + 换行 `.method(...)`：`src/renderer/src/features/browse/ActivityHome.tsx:42`、`src/renderer/src/features/browse/LibraryHome.tsx:54`、`src/renderer/src/App.tsx:49`）。85 个 invoke 方法中 **83 个有渲染层调用**；`ping`、`installUpdate` **无渲染层调用**。2 个事件订阅方法均有调用点。

| 方法 | 渲染层调用点（file:line） | 处数 |
| --- | --- | --- |
| `ping` | **无渲染层调用** | 0 |
| `copyText` | `src/renderer/src/components/feedback/ErrorBanner.tsx:49`<br>`src/renderer/src/features/chat/PrivateChatModal.tsx:112`<br>`src/renderer/src/features/chat/PrivateChatModal.tsx:123`<br>`src/renderer/src/features/editor/editorContextMenu.tsx:74`<br>`src/renderer/src/features/editor/editorContextMenu.tsx:83`<br>`src/renderer/src/features/editor/editorContextMenu.tsx:110`<br>`src/renderer/src/features/editor/editorContextMenu.tsx:177`<br>`src/renderer/src/features/editor/editorContextMenu.tsx:186`<br>`src/renderer/src/features/editor/editorContextMenu.tsx:209`<br>`src/renderer/src/features/navigation/Sidebar.tsx:218`<br>`src/renderer/src/features/notifications/NotificationPanel.tsx:203`<br>`src/renderer/src/features/notifications/NotificationPanel.tsx:212`<br>`src/renderer/src/features/reader/ReaderComments.tsx:362`<br>`src/renderer/src/features/reader/ReaderComments.tsx:368`<br>`src/renderer/src/features/reader/ReaderInteractions.tsx:176`<br>`src/renderer/src/features/reader/ReaderView.tsx:242`<br>`src/renderer/src/features/reader/ReaderView.tsx:246`<br>`src/renderer/src/features/reader/ReviewItemCard.tsx:96`<br>`src/renderer/src/features/reader/ReviewItemCard.tsx:102` | 19 |
| `readClipboardText` | `src/renderer/src/components/menu/editableContextMenu.tsx:35`<br>`src/renderer/src/features/editor/editorContextMenu.tsx:41`<br>`src/renderer/src/features/editor/editorContextMenu.tsx:154` | 3 |
| `readClipboardHtml` | `src/renderer/src/features/editor/editorContextMenu.tsx:155` | 1 |
| `getAppInfo` | `src/renderer/src/features/auth/FirstRunAgreement.tsx:28`<br>`src/renderer/src/features/auth/LoginView.tsx:32`<br>`src/renderer/src/features/navigation/Sidebar.tsx:235`<br>`src/renderer/src/features/navigation/TopBar.tsx:109`<br>`src/renderer/src/features/settings/SystemPanel.tsx:28` | 5 |
| `showMessageBox` | `src/renderer/src/features/editor/EditorBar.tsx:96`<br>`src/renderer/src/features/editor/MilkdownToolbar.tsx:52`<br>`src/renderer/src/features/navigation/Sidebar.tsx:179`<br>`src/renderer/src/features/navigation/Sidebar.tsx:188`<br>`src/renderer/src/features/navigation/Sidebar.tsx:191`<br>`src/renderer/src/features/navigation/Sidebar.tsx:587`<br>`src/renderer/src/features/navigation/Sidebar.tsx:593`<br>`src/renderer/src/features/navigation/Sidebar.tsx:609`<br>`src/renderer/src/features/navigation/Sidebar.tsx:739`<br>`src/renderer/src/features/panel/HistoryPanel.tsx:29`<br>`src/renderer/src/features/settings/SystemPanel.tsx:61`<br>`src/renderer/src/features/settings/SystemPanel.tsx:72`<br>`src/renderer/src/features/settings/SystemPanel.tsx:86`<br>`src/renderer/src/features/settings/SystemPanel.tsx:93`<br>`src/renderer/src/features/settings/SystemPanel.tsx:98`<br>`src/renderer/src/features/settings/SystemPanel.tsx:109`<br>`src/renderer/src/features/user/FollowRow.tsx:67`<br>`src/renderer/src/main.tsx:8`<br>`src/renderer/src/main.tsx:11` | 19 |
| `windowControls.minimize` | `src/renderer/src/features/auth/FirstRunAgreement.tsx:92`<br>`src/renderer/src/features/auth/LoginView.tsx:85`<br>`src/renderer/src/features/navigation/TopBar.tsx:255` | 3 |
| `windowControls.toggleMaximize` | `src/renderer/src/features/auth/FirstRunAgreement.tsx:97`<br>`src/renderer/src/features/auth/LoginView.tsx:90`<br>`src/renderer/src/features/navigation/TopBar.tsx:260` | 3 |
| `windowControls.close` | `src/renderer/src/features/auth/FirstRunAgreement.tsx:102`<br>`src/renderer/src/features/auth/LoginView.tsx:95`<br>`src/renderer/src/features/navigation/TopBar.tsx:267` | 3 |
| `windowControls.isMaximized` | `src/renderer/src/features/auth/FirstRunAgreement.tsx:31`<br>`src/renderer/src/features/auth/LoginView.tsx:35`<br>`src/renderer/src/features/navigation/TopBar.tsx:79` | 3 |
| `toggleDevTools` | `src/renderer/src/components/menu/appMenuItems.tsx:26` | 1 |
| `getAgreement` | `src/renderer/src/App.tsx:49`<br>`src/renderer/src/features/auth/FirstRunAgreement.tsx:45`<br>`src/renderer/src/features/auth/LoginView.tsx:55`<br>`src/renderer/src/features/settings/SettingsPanel.tsx:43` | 4 |
| `loginPassword` | `src/renderer/src/stores/auth.ts:58` | 1 |
| `getSession` | `src/renderer/src/features/settings/UserPanel.tsx:82`<br>`src/renderer/src/stores/auth.ts:28` | 2 |
| `verifySession` | `src/renderer/src/stores/auth.ts:36` | 1 |
| `logout` | `src/renderer/src/stores/auth.ts:52`<br>`src/renderer/src/stores/auth.ts:77` | 2 |
| `syncPull` | `src/renderer/src/stores/docs.ts:54` | 1 |
| `syncPush` | `src/renderer/src/stores/docs.ts:66` | 1 |
| `convertToDraft` | `src/renderer/src/stores/reader.ts:282` | 1 |
| `editRemoteArticle` | `src/renderer/src/stores/reader.ts:261` | 1 |
| `getDocsRoot` | `src/renderer/src/features/settings/SystemPanel.tsx:32` | 1 |
| `openDocsDir` | `src/renderer/src/features/navigation/Sidebar.tsx:738` | 1 |
| `listLocalDocs` | `src/renderer/src/stores/docs.ts:37` | 1 |
| `readLocalFile` | `src/renderer/src/stores/editor.ts:113`<br>`src/renderer/src/stores/editor.ts:139` | 2 |
| `fileExists` | `src/renderer/src/features/navigation/Sidebar.tsx:431` | 1 |
| `writeLocalFile` | `src/renderer/src/stores/editor.ts:155` | 1 |
| `createLocalDraft` | `src/renderer/src/stores/editor.ts:162` | 1 |
| `createLocalDir` | `src/renderer/src/features/editor/EditorPane.tsx:199` | 1 |
| `deleteLocalDoc` | `src/renderer/src/stores/docs.ts:83` | 1 |
| `renameLocalNode` | `src/renderer/src/features/editor/EditorPane.tsx:170`<br>`src/renderer/src/features/navigation/Sidebar.tsx:607` | 2 |
| `revealInFolder` | `src/renderer/src/features/navigation/Sidebar.tsx:177` | 1 |
| `chooseDocsDir` | `src/renderer/src/features/settings/SystemPanel.tsx:57` | 1 |
| `listArticles` | `src/renderer/src/stores/docs.ts:43`<br>`src/renderer/src/stores/editor.ts:120` | 2 |
| `listRemoteArticles` | `src/renderer/src/features/browse/LibraryHome.tsx:54`<br>`src/renderer/src/features/browse/LibraryHome.tsx:88`<br>`src/renderer/src/features/browse/LibraryHome.tsx:121`<br>`src/renderer/src/features/browse/LibraryHome.tsx:138`<br>`src/renderer/src/features/browse/RecommendHome.tsx:249`<br>`src/renderer/src/features/browse/RecommendHome.tsx:251`<br>`src/renderer/src/lib/listAll.ts:17`<br>`src/renderer/src/stores/reader.ts:408` | 8 |
| `getRemoteArticle` | `src/renderer/src/stores/reader.ts:234` | 1 |
| `listReviews` | `src/renderer/src/features/browse/ActivityHome.tsx:72`<br>`src/renderer/src/features/browse/RecommendHome.tsx:253`<br>`src/renderer/src/stores/reader.ts:298` | 3 |
| `submitReview` | `src/renderer/src/stores/reader.ts:325` | 1 |
| `setReviewAttitude` | `src/renderer/src/stores/reader.ts:345` | 1 |
| `listReviewTasks` | `src/renderer/src/stores/reader.ts:483` | 1 |
| `listMyReviews` | `src/renderer/src/stores/reader.ts:498` | 1 |
| `listComments` | `src/renderer/src/stores/reader.ts:360` | 1 |
| `listRecentComments` | `src/renderer/src/features/browse/RecommendHome.tsx:258`<br>`src/renderer/src/features/browse/RecommendHome.tsx:259` | 2 |
| `addComment` | `src/renderer/src/features/browse/RecommendHome.tsx:340`<br>`src/renderer/src/features/browse/RecommendHome.tsx:357`<br>`src/renderer/src/stores/reader.ts:381` | 3 |
| `searchComments` | `src/renderer/src/features/browse/LibraryHome.tsx:94` | 1 |
| `searchReviews` | `src/renderer/src/features/browse/LibraryHome.tsx:95` | 1 |
| `searchUsers` | `src/renderer/src/features/browse/LibraryHome.tsx:96` | 1 |
| `listCategories` | `src/renderer/src/features/navigation/Sidebar.tsx:381` | 1 |
| `listMetas` | `src/renderer/src/features/browse/ActivityHome.tsx:42`<br>`src/renderer/src/features/browse/RecommendHome.tsx:262`<br>`src/renderer/src/features/browse/SerialHome.tsx:33`<br>`src/renderer/src/features/editor/PublishModal.tsx:36`<br>`src/renderer/src/features/editor/PublishModal.tsx:39`<br>`src/renderer/src/features/editor/PublishModal.tsx:42`<br>`src/renderer/src/features/navigation/Sidebar.tsx:399`<br>`src/renderer/src/features/navigation/Sidebar.tsx:413`<br>`src/renderer/src/features/reader/ReaderView.tsx:78`<br>`src/renderer/src/features/reader/ReviewPanel.tsx:66` | 10 |
| `checkForbidden` | `src/renderer/src/features/editor/EditorBar.tsx:107` | 1 |
| `listGptModels` | `src/renderer/src/features/browse/GptListView.tsx:17` | 1 |
| `getPrivateChat` | `src/renderer/src/features/chat/PrivateChatModal.tsx:42` | 1 |
| `listChatSessions` | `src/renderer/src/features/notifications/NotificationPanel.tsx:96` | 1 |
| `listChatMessages` | `src/renderer/src/features/chat/PrivateChatModal.tsx:49`<br>`src/renderer/src/features/chat/PrivateChatModal.tsx:75`<br>`src/renderer/src/features/chat/PrivateChatModal.tsx:92` | 3 |
| `sendChatMessage` | `src/renderer/src/features/chat/PrivateChatModal.tsx:88` | 1 |
| `addLog` | `src/renderer/src/features/reader/ReaderInteractions.tsx:126`<br>`src/renderer/src/features/reader/ReaderInteractions.tsx:142`<br>`src/renderer/src/features/reader/ReaderInteractions.tsx:165` | 3 |
| `isMark` | `src/renderer/src/features/reader/ReaderInteractions.tsx:70` | 1 |
| `removeLog` | `src/renderer/src/features/reader/ReaderInteractions.tsx:112` | 1 |
| `listNotifications` | `src/renderer/src/stores/notifications.ts:29` | 1 |
| `getUnreadCount` | `src/renderer/src/stores/notifications.ts:32`<br>`src/renderer/src/stores/notifications.ts:49` | 2 |
| `markNotificationsRead` | `src/renderer/src/features/notifications/NotificationPanel.tsx:139`<br>`src/renderer/src/features/notifications/NotificationPanel.tsx:157`<br>`src/renderer/src/stores/notifications.ts:70` | 3 |
| `getUserProfile` | `src/renderer/src/features/navigation/Sidebar.tsx:316`<br>`src/renderer/src/stores/user.ts:174` | 2 |
| `getUserStats` | `src/renderer/src/features/navigation/Sidebar.tsx:319`<br>`src/renderer/src/stores/user.ts:175` | 2 |
| `getSelfStatus` | `src/renderer/src/features/navigation/Sidebar.tsx:322`<br>`src/renderer/src/features/settings/UserPanel.tsx:25`<br>`src/renderer/src/stores/user.ts:185` | 3 |
| `getFollowState` | `src/renderer/src/features/user/FollowRow.tsx:40`<br>`src/renderer/src/stores/user.ts:182` | 2 |
| `followUser` | `src/renderer/src/features/user/FollowRow.tsx:61`<br>`src/renderer/src/stores/user.ts:304` | 2 |
| `listFollows` | `src/renderer/src/stores/user.ts:188`<br>`src/renderer/src/stores/user.ts:257` | 2 |
| `listFans` | `src/renderer/src/stores/user.ts:258` | 1 |
| `listMarks` | `src/renderer/src/stores/user.ts:203`<br>`src/renderer/src/stores/user.ts:250` | 2 |
| `listUserArticles` | `src/renderer/src/stores/user.ts:200`<br>`src/renderer/src/stores/user.ts:261` | 2 |
| `listUserReviews` | `src/renderer/src/stores/user.ts:201`<br>`src/renderer/src/stores/user.ts:264` | 2 |
| `listUserComments` | `src/renderer/src/stores/user.ts:202`<br>`src/renderer/src/stores/user.ts:267` | 2 |
| `listFollowFeed` | `src/renderer/src/stores/user.ts:247` | 1 |
| `clockIn` | `src/renderer/src/features/navigation/Sidebar.tsx:581`<br>`src/renderer/src/stores/user.ts:317` | 2 |
| `userUpdateProfile` | `src/renderer/src/features/settings/UserPanel.tsx:75` | 1 |
| `pickUploadUserImage` | `src/renderer/src/features/settings/UserPanel.tsx:64` | 1 |
| `getSettings` | `src/renderer/src/stores/settings.ts:111` | 1 |
| `updateSettings` | `src/renderer/src/stores/settings.ts:117` | 1 |
| `getChangelog` | `src/renderer/src/features/settings/ChangelogModal.tsx:11` | 1 |
| `clearCache` | `src/renderer/src/features/settings/SystemPanel.tsx:83` | 1 |
| `uninstall` | `src/renderer/src/features/settings/SystemPanel.tsx:107` | 1 |
| `getUpdateState` | `src/renderer/src/features/settings/SystemPanel.tsx:35`<br>`src/renderer/src/features/settings/UpdateBanner.tsx:11` | 2 |
| `checkForUpdates` | `src/renderer/src/features/settings/SystemPanel.tsx:44` | 1 |
| `downloadUpdate` | `src/renderer/src/features/settings/SystemPanel.tsx:52`<br>`src/renderer/src/features/settings/UpdateBanner.tsx:31` | 2 |
| `installUpdate` | **无渲染层调用** | 0 |
| `pickUploadImage` | `src/renderer/src/features/editor/MilkdownToolbar.tsx:50` | 1 |
| `windowControls.onMaximizedChanged`（事件订阅） | `src/renderer/src/features/auth/FirstRunAgreement.tsx:34`<br>`src/renderer/src/features/auth/LoginView.tsx:38`<br>`src/renderer/src/features/navigation/TopBar.tsx:82` | 3 |
| `onUpdateState`（事件订阅） | `src/renderer/src/features/settings/SystemPanel.tsx:38`<br>`src/renderer/src/features/settings/UpdateBanner.tsx:14` | 2 |

> 调用点合计（脚本求和）：**188**，与 grep 行数 188 一致。

---

## 6. 异常 / 待确认项

共 **10** 项。A1–A5 必须让对应 lane 知道（影响 Rust 实现或错误语义）；A6–A10 为文档/口径/观测类，需契约负责人或集成者确认。**不存在 `UNKNOWN(需人工)` 类型**（所有入参/返回类型均已在源码定位）。

| 编号 | 级别 | 事项 | 证据 | 处理建议 |
| --- | --- | --- | --- | --- |
| A1 | 必读·契约 | 唯一非 `hqsf:` 前缀通道 `media:pick-upload-image`（grep `hqsf:` 无法命中） | `src/main/ipc/media.handlers.ts:7`；`src/shared/contracts/ipc.ts:94`；`src/preload/index.ts:274` | L5 按此通道名实现；桥接层保留 `media:` 前缀，不改名 |
| A2 | 必读·契约 | `hqsf:update-state` 通道名复用：既是 invoke 通道又是事件通道 | invoke：`src/main/ipc/updater.handlers.ts:6`；事件发送：`src/main/infra/updater/index.ts:44`；订阅：`src/preload/index.ts:263-267` | Rust 侧命令 `update_state` 与 Tauri 事件同名并存，桥接层分派 invoke/listen |
| A3 | 必读·缺陷 | `fail('未登录')` / `fail('未登录，无法上传图片')` 传字符串，`(error as Error).message` 为 `undefined`，实际返回 `{ ok:false }`（JSON 中无 `error` 字段） | `src/main/ipc/shared.ts:10-12`；`src/main/ipc/browse.handlers.ts:28`；`src/main/ipc/media.handlers.ts:11` | Rust 侧按 `{ok:false,error:"未登录..."}` 正常实现；契约测试对这两条源快照需允许 error 缺失（行为基线以源码为准） |
| A4 | 必读·缺陷 | `hqsf:add-log` 无 `try/catch`：服务层抛错使 invoke 以 rejected Promise 返回，违反 `{ok:false,error}` 约定 | `src/main/ipc/interact.handlers.ts:7-29`（整段无 try） | L7b 实现时由桥接层兜底 catch 统一转 `{ok:false,error}`；契约测试需覆盖服务层抛错路径 |
| A5 | 必读·缺陷 | `hqsf:toggle-devtools` 无 `try/catch`（唯一显式失败分支 `窗口不存在` 已用 fail） | `src/main/ipc/window.handlers.ts:22-28` | L1 保持单一失败分支；Rust 侧同语义 |
| A6 | 待确认·口径 | 计划 §1.3 写「84 条 + 2 事件」，实际 **85 条 invoke + 2 事件**；差异在 `system` 模块：计划列 5，实际 6（漏计 `hqsf:show-message-box`） | `doc/design/Tauri迁移计划.md` §1.3；`src/main/ipc/system.handlers.ts:5-19`（6 处 handle） | 以本表 85 为准；请契约负责人修订计划 §1.3 的 84→85 |
| A7 | 待确认·lane | 任务给定 lane 映射与计划 §4.2 标数不一致：① `auth`(4) 本表归 **L4**，计划 §4.2 把 auth 4 列入 L7c；② 计划 §4.2 的 L1 写域含 `agreement.rs`，但 L7c 产出又含 agreement 1，本表按指令归 **L7c**；③ L7b 计划标 25 条，按其写域实际为 **29** 条（user 15 + chat 4 + browse 4 + notify 3 + interact 3）；④ L7c 计划标 10 条，本表为 **5** 条（agreement 1 + sync 4） | `doc/design/Tauri迁移计划.md` §4.2；本表 lane 列 | 未确认前按**本表**执行（任务指令优先）；确认后只改本文档与 `commands.json` 的 `lane` 字段 |
| A8 | 待确认·类型宽窄 | `hqsf:show-message-box` handler 形参 `message?: string`，契约 `HqsfApi` 为必填 `message: string` | `src/main/ipc/system.handlers.ts:26`；`src/shared/contracts/hqsf-api.ts:78` | 以必填契约为准（handler 内部 `?? ''` 兜底，`src/main/ipc/system.handlers.ts:39`）；Rust 侧按必填实现 |
| A9 | 说明·非契约 | `searchKey` 只出现在 `hqsf:search-reviews` 的服务层内部调用，不在 IPC 入参类型中 | `src/main/ipc/search.handlers.ts:25`；`listReviews` 入参类型不含 `searchKey`（`src/main/ipc/review.handlers.ts:8`） | 不作为通道参数；`commands/search.rs` 内部组参 |
| A10 | 说明·安全观测 | 45/85 条通道**不调用** `trusted(event)`（senderFrame 校验），40 条调用；不调用者多为只读/系统类 | 全量清单见附录 B | 不改变契约；Rust 侧是否统一加 sender 校验由集成者决策（建议保留现状以行为不变） |

---

## 7. lane 归属汇总

| lane | 通道数 | 模块明细 | 事件 |
| --- | --- | --- | --- |
| L1 | 16 | system 6、window 5、settings 5 | `hqsf:window-maximized-changed` 1 |
| L2 | 13 | docs 13 | — |
| L4 | 8 | auth 4、updater 4 | `hqsf:update-state` 1 |
| L5 | 1 | media 1 | — |
| L7a | 13 | comment 3、read 2、review 5、search 3 | — |
| L7b | 29 | browse 4、chat 4、interact 3、notify 3、user 15 | — |
| L7c | 5 | agreement 1、sync 4 | — |
| **合计** | **85** | — | **2** |

Rust 命令名规则：通道名去前缀后 snake_case（`hqsf:read-local-file` → `read_local_file`；`hqsf:window-maximize-toggle` → `window_maximize_toggle`；`media:pick-upload-image` → `pick_upload_image`）。模块名 = handler 文件名（18 个模块，与计划 §1.3 一一对应）。

---

## 附录 A：返回载荷类型索引

`domain:行` = `src/shared/domain/index.ts`；`frontmatter.ts:行` = `src/shared/frontmatter.ts`。完整字段定义以源码为唯一来源（Rust 侧由 specta 生成，禁止手抄）。

| 类型 | 定义位置 |
| --- | --- |
| `AppInfo` | `src/shared/contracts/hqsf-api.ts:45-51` |
| `AgreementData` | `src/shared/domain/index.ts:509-512` |
| `AppSettings` | `src/shared/domain/index.ts:39-50` |
| `AppNotification / NotificationCategory` | `src/shared/domain/index.ts:457-474` |
| `ArticleDetail` | `src/shared/domain/index.ts:220-250` |
| `ArticleListOptions` | `src/shared/domain/index.ts:253-264` |
| `ArticleMeta` | `src/shared/frontmatter.ts:8-17` |
| `ArticleRow / ArticleType` | `src/shared/domain/index.ts:84-105（ArticleType = 'post_draft' \| 'waiting' \| 'post' \| 'reject' \| 'local'，domain:84）` |
| `ChangelogData` | `src/shared/domain/index.ts:62-65` |
| `ChatMessage` | `src/shared/domain/index.ts:429-438` |
| `ChatSession` | `src/shared/domain/index.ts:441-453` |
| `ClearCacheResult` | `src/shared/domain/index.ts:67-69` |
| `ClockResult` | `src/shared/domain/index.ts:630-639` |
| `CommentItem` | `src/shared/domain/index.ts:388-424` |
| `CommentListResult` | `src/shared/domain/index.ts:477-482` |
| `CommentSubmitResult` | `src/shared/domain/index.ts:485-488` |
| `ConvertDraftResult` | `src/shared/domain/index.ts:144-146` |
| `EditRemoteResult` | `src/shared/domain/index.ts:149-154` |
| `FollowFeedItem` | `src/shared/domain/index.ts:595-627` |
| `GptModel` | `src/shared/domain/index.ts:288-297` |
| `LocalNode` | `src/shared/domain/index.ts:158-171` |
| `LoginResult` | `src/shared/domain/index.ts:116-121` |
| `LogOpResult` | `src/shared/domain/index.ts:493-496` |
| `MarkStatus` | `src/shared/domain/index.ts:499-504` |
| `MetaInfo / MetaRef` | `src/shared/domain/index.ts:176-182, 269-285` |
| `PullResult` | `src/shared/domain/index.ts:125-133` |
| `PushResult` | `src/shared/domain/index.ts:135-141` |
| `RemoteArticle` | `src/shared/domain/index.ts:185-217` |
| `ReviewItem` | `src/shared/domain/index.ts:300-337` |
| `ReviewPayload` | `src/shared/domain/index.ts:340-361` |
| `ReviewSubmitResult` | `src/shared/domain/index.ts:364-367` |
| `ReviewTaskItem` | `src/shared/domain/index.ts:372-383` |
| `SelfStatus` | `src/shared/domain/index.ts:642-654` |
| `UpdateState` | `src/shared/domain/index.ts:53-60` |
| `UserFollowItem` | `src/shared/domain/index.ts:556-565` |
| `UserMarkItem` | `src/shared/domain/index.ts:568-586` |
| `UserProfile` | `src/shared/domain/index.ts:517-533` |
| `UserProfileUpdatePayload` | `src/shared/domain/index.ts:72-79` |
| `UserSearchResult` | `src/shared/domain/index.ts:536-544` |
| `UserSession` | `src/shared/domain/index.ts:110-114` |
| `UserStats` | `src/shared/domain/index.ts:547-553` |

## 附录 B：未调用 `trusted(event)` 的 45 条通道

`hqsf:get-agreement`、`hqsf:get-session`、`hqsf:verify-session`、`hqsf:list-categories`、`hqsf:list-metas`、`hqsf:list-gpt-models`、`hqsf:get-docs-root`、`hqsf:open-docs-dir`、`hqsf:list-local-docs`、`hqsf:read-local-file`、`hqsf:write-local-file`、`hqsf:create-local-draft`、`hqsf:delete-local-file`、`hqsf:create-local-dir`、`hqsf:choose-docs-dir`、`hqsf:list-articles`、`hqsf:list-remote-articles`、`hqsf:get-remote-article`、`hqsf:list-reviews`、`hqsf:list-review-tasks`、`hqsf:list-my-reviews`、`hqsf:get-changelog`、`hqsf:ping`、`hqsf:copy-text`、`hqsf:read-clipboard-text`、`hqsf:read-clipboard-html`、`hqsf:get-app-info`、`hqsf:update-state`、`hqsf:update-check`、`hqsf:update-download`、`hqsf:update-install`、`hqsf:user-profile`、`hqsf:user-stats`、`hqsf:user-self-status`、`hqsf:user-follow-state`、`hqsf:user-follow-list`、`hqsf:user-fan-list`、`hqsf:user-articles`、`hqsf:user-reviews`、`hqsf:user-comments`、`hqsf:window-minimize`、`hqsf:window-maximize-toggle`、`hqsf:window-close`、`hqsf:window-is-maximized`、`hqsf:toggle-devtools`

---

## 附录 C：机器可读清单

同目录产物：`src-tauri/testdata/contracts/commands.json`（version 1；85 通道 + 2 事件；含 `params` 字段级展开、`returns` 业务载荷类型、`envelope`、`errors`、`handler`、`rustCommand`、`rustModule`、`lane`、`rendererCalls`）。契约测试应以此为唯一期望来源。
