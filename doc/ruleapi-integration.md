# RuleApi 本地服务端对接方案（hqsf-client ↔ vendor/ruleapi）

> 目标：把下载的 RuleApi（`vendor/ruleapi`，荒启服务端同源参考实现）跑成本地服务端，与 hqsf-client 对接，用于隔离测试与功能验证。
> 状态：**方案（未实施）**。实施时按「阶段」推进，每阶段有独立验证点。

## 1. 结论

RuleApi 原生与荒启线上（`api.huangqisf.com`）是**同源 + 二次开发**关系。客户端是按荒启线上规格编写的，直接对接原生 RuleApi 会断在三处：

| 差异 | 客户端需要（线上荒启） | RuleApi 原生（v2.0.3） | 影响 |
|---|---|---|---|
| 路由前缀 | `hqContents/hqMetas/hqUsers/…` | `typechoContents/typechoMetas/typechoUsers/…` | 全部接口 404 |
| 返回结构 | `{code:1,msg,data,total}`；`contentsInfo` 为裸对象 | `ResultAll{code,msg,data}`（多数）；`contentsInfo` 形态需核对 | 分页 `total`、raw 模式 |
| 定制模块 | `review/*`、`gpt/*`、`choiceList`、`active`、`score/size/activeStatus` 字段与排序 | **全部没有** | M2 评审、AI 模型、活动栏目无法工作 |
| 四态流转 | 发布→待审核→服务器裁决；已发布/待审核可改后重新提交 | `contentsUpdate` 的"重新审核"逻辑**被注释**（`ContentsController.java:1050-1053`）；无 reject 后重新提交链路 | 写作闭环语义不符 |

## 2. 客户端调用面（14 个接口，21 处调用点）

基址硬编码 `https://api.huangqisf.com/`（`src/main/net/api.ts:5`）；约定 `{code:1,msg,data,total}`，`contentsInfo` 走 `raw` 模式（`api.ts:85`）；token 一律走表单/查询参数。

| 模块 | endpoint | 原生对应 |
|---|---|---|
| 认证 | `hqUsers/userLogin`、`hqUsers/SendCode`、`hqUsers/phoneLogin`、`hqUsers/signOut` | `typechoUsers/` 同名端点（`UsersController.java:549/1600/999/2664`） |
| 写作同步 | `hqContents/contentsList`(POST)、`contentsInfo`(POST/GET+raw)、`contentsAdd`、`contentsUpdate` | `typechoContents/` 同名（`ContentsController.java:322/137/450/940`） |
| 阅读 | `hqContents/choiceList`、`hqContents/contentsList`(GET)、`hqMetas/selectContents`、`hqMetas/metasList` | `choiceList` **原生没有**；其余改前缀（`MetasController.java:74/163`） |
| 评审 | `review/reviewTask`、`review/reviewList`、`review/addReview`、`review/editReview`、`review/attitude` | **原生完全没有**（需二次开发） |
| 栏目/AI | `hqMetas/metasList`(category)、`gpt/gptList` | `gpt/*` **原生没有** |

## 3. 原生 RuleApi 关键事实（file:line 均指 vendor/ruleapi）

- **路由**：`ContentsController /typechoContents`（19 个方法）、`MetasController /typechoMetas`、`UsersController /typechoUsers`（60+ 方法）、`CommentsController /typechoComments`、`UploadController /upload`、`SystemController /system`、`InstallController /install`、`SpaceController /typechoSpace`、`PayController /pay`、`ShopController /typechoShop`、`AdsController /typechoAds`、`ChatController /typechoChat`、`UserlogController /typechoUserlog`、`pluginController /plugin`、`FrontendController`(SPA 兜底)。
- **返回**：写/列表接口 `ResultAll.getResultJson(code,msg,data)` → `{"code":1,...}`，code=1 成功、0 失败；分页形态需核对（`common/PageList.java`、`common/ResultAll.java:9-14`）。
- **token**：`LoginRequired` 注解 + AOP（`aspect/LoginAspect.java:72`），只能经 query/form 参数 `request.getParameter("token")`，不支持 Authorization header。
- **四态（原生）**：草稿=`type=post_draft,status=publish`；已发布=`type=post,status=publish`；待审核=`type=post,status=waiting`；已拒绝=`type=post,status=reject`（仅 `contentsAudit` type=1 + reason 必填产生）。判定必须按 type+status 组合，不能只看一个字段。
- **contentsList 条目字段**（`common/baseFull.java:54-185` 组装）：`cid/title/type/status/authorId/modified/text(≤400字纯文本摘要)/markdown/category/tag/authorInfo/images/views/likes/commentsNum/replyTime/isrecommend/istop/isswiper` 均存在；**缺** `score/size/active/activeStatus/collection/cover/introduction/isAnonymous/isopen/honor`。`order` 仅允许 `cid/created/modified/commentsNum/views/likes/replyTime`。
- **配置**（`src/main/resources/application.properties`）：端口 8081、无 context-path；MySQL `jdbc:mysql://127.0.0.1:3306/typecho1`（root/root）；表前缀 `typecho`；Redis 127.0.0.1:6379；WebKey `123456`（安装/管理接口密钥）；token 有效期 86400s。
- **安装向导**（`InstallController`）：`/install/typechoInstall`（webkey+name+password → 建 Typecho 基础表 + 首个 administrator）、`/install/newInstall`（webkey → 建 RuleApi 扩展表 + 112 条默认配置 + version）。RuleApi 不建库，需先有 MySQL 库。
- **风险点**：`pluginController /plugin/main/{name}/{obj}` 可**动态编译执行任意 Java 代码**，生产禁用；`addMeta` 只允许 `type=category|tag`；`contentsDelete` 受 `allowDelete` 配置控制。

## 4. 分阶段实施清单

### 阶段 0 — 环境就绪（服务端跑起来）

| # | 任务 | 要点 |
|---|---|---|
| 0.1 | 本地 MySQL 建库 | 库名 `typecho1`（application.properties:14），账号 root/root 或改配置 |
| 0.2 | 本地 Redis | 127.0.0.1:6379 启动 |
| 0.3 | 修 logback 路径 | `logback-spring.xml:14` 硬编码 `log.path=/log/RuleApi`，普通用户无 `/log` 写权限会启动失败；改为 `<property name="log.path" value="${LOG_PATH:-/log/RuleApi}" />`，启动加 `-DLOG_PATH=$HOME/logs/ruleapi` |
| 0.4 | 启动 | `java -jar target/RuleApi-2.0.3.jar`，验证 `GET http://127.0.0.1:8081/install/isInstall` |
| 0.5 | 安装向导 | `POST /install/typechoInstall`（webkey=`123456` + name + password 创建管理员）→ `POST /install/newInstall`（webkey 建扩展表） |

**验证**：isInstall 返回已安装；MySQL 出现 `typecho_*` 表。

### 阶段 1 — 接口兼容层（写作闭环端到端）

| # | 任务 | 要点（file:line） |
|---|---|---|
| 1.1 | 路由前缀 `typecho*` → `hq*` | 改各 Controller 类级 `@RequestMapping`：`typechoContents`→`hqContents`、`typechoMetas`→`hqMetas`、`typechoUsers`→`hqUsers`、`typechoComments`→`hqComments`（评审等新模块直接用 `review`/`gpt`） |
| 1.2 | 核对登录 token | `hqUsers/userLogin`（`UsersController.java:549`）返回结构与 `auth.ts:36-39` 的解析（期望取到 token 的字段名）对齐；`signOut`/`SendCode`/`phoneLogin` 同理 |
| 1.3 | 核对 `contentsList` 分页返回 | 客户端期望 `resp.data` 为数组 + `resp.total`（`api.ts` 约定）；原生分页形态（`PageList`）不一致则加适配 |
| 1.4 | 核对 `contentsInfo` 返回形态 | 客户端 `raw` 模式期望裸对象 `{title,text,...}`（`read.ts:221-228`、`sync.ts:109-140`）；原生若为 `{code,msg,data}` 包装需改裸返回或客户端双形态适配 |
| 1.5 | 恢复"重新审核"逻辑 | `ContentsController.java:1050-1053`：放开 `contentsUpdate` 使 isDraft=0 的文章回到 `type=post,status=waiting`（对齐用户确认的"发布→待审核→服务器裁决"语义） |
| 1.6 | reject 后重新提交链路 | 原生无"拒绝→修改→再提交"接口，需补（reject 状态文章 contentsUpdate isDraft=0 → 回 waiting） |
| 1.7 | 客户端 `API_BASE` 配置化 | `src/main/net/api.ts:5` 硬编码 → 支持 meta 表/环境变量覆盖，指向 `http://127.0.0.1:8081` |

**验证**：登录 → 拉取四态列表 → 新建本地草稿 → 存草稿（contentsAdd isDraft=1）→ 发布（isDraft=0，状态变 waiting）→ 用安装向导创建的管理员调 `contentsAudit` 通过/拒绝 → 本地 pull 看到 type/status 跟随。

### 阶段 2 — 阅读闭环

| # | 任务 | 要点 |
|---|---|---|
| 2.1 | `contentsInfo` 字段补齐 | 客户端 `ArticleDetail`（`types.ts:140-159`）用到 `views/likes/category/collection/active/markdown` 等；原生有的直接返回，缺的（`score/size/active`…）给默认值或扩展列 |
| 2.2 | `selectContents`/`metasList` 分类 | `type=category/tag` 原生支持；作品库分类（`listCategories`）走 `metasList type=category` 直接可用 |
| 2.3 | 阅读权限 | `contentsInfo` 非管理员只看 publish（`ContentsController.java:137`），本地测试账号注意 |

**验证**：客户端阅读视图打开已发布文章，正文/元信息正确渲染。

### 阶段 3 — 荒启定制模块二次开发（工作量大，对照 `doc/api-research.md` 实测规格）

| # | 模块 | 内容 |
|---|---|---|
| 3.1 | `review/*` 评审 | 评审表（新表）+ `reviewList/reviewInfo/addReview/editReview/attitude/reviewTask` + 五维（dianzi/wenbi/renwu/jiezou/liyi）评分与评语 + `score` 汇总写回文章 + 活动文章评审任务化（status 0/1） |
| 3.2 | `gpt/*` AI 模型 | `gptList` 模型列表（`pom.xml` 已引 dashscope 但零引用，可基于通义千问实现对话/续写，或先返回静态模型列表） |
| 3.3 | `choiceList` 精选 | 原生有 `isrecommend` 字段与 `toRecommend`，可基于推荐位实现 |
| 3.4 | `active` 活动 | `metas type=active`（原生 addMeta 限制 category/tag，需放开）+ 文章 `active` 字段 + `activeStatus`（1 进行中/-1 评审中/0 已结束） |
| 3.5 | 评论 `hqComments/*` | 原生 `CommentsController` 改前缀即可，按需接入 |

**验证**：客户端 M2 评审面板、AI 模型栏目、活动树端到端可用。

## 5. 其他注意事项

- **客户端适配范围**：仅 `api.ts:5` 基址配置化是必改；其余差异尽量在服务端消化（前缀/返回/语义），避免客户端写死两套协议。
- **短信验证码**：本地无真实短信渠道，测试登录优先用账号密码（`userLogin`）或核对 `SendCode` 的测试模式。
- **数据初始化**：安装向导即建表 + 初始化管理员 + 默认配置，勿手工建表。
- **安全**：`/plugin` 动态编译执行任意代码，本地测试可留、生产必须关；`webinfo.key` 默认 `123456` 需改。
- **`contentsList` 四态**：判定按 `type+status` 组合（见 §3），客户端 `pullRemote` 依赖该语义，改服务端时保持 `post_draft/waiting/post/reject` 四种 `type` 值不变。
