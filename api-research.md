# 荒启 API 调查报告

> 调查日期：以实际执行为准。方法：静态分析官方 h5 前端包（`https://www.huangqisf.com/h5/` 的 index.js 与各页面 chunk）+ 直接请求实测。结论均经过实弹验证，标注「实测」的为已验证，其余为代码推断。

## 1. 基础设施

- **基址**：`https://api.huangqisf.com/`（h5 包中常量 `a`，`getApiUrl()` 返回）
- **内容分发**：图片/资源在 `https://cdn.huangqisf.com/`
- **请求方式**：GET/POST 均可，`Content-Type: application/x-www-form-urlencoded`
- **鉴权**：登录后服务端返回 `token`，存入 `localStorage["token"]`；几乎每个接口都带 `token` 参数（表单字段，而非 Header）。用户信息存 `localStorage["userinfo"]`（含 `uid`）。
- **响应结构**（实测）：
  ```json
  {"msg":"","code":1,"data":{...},"total":1991}
  ```
  `code:1` 成功、`code:0` 失败（`msg` 为错误文案）。列表类多一个 `total`。
- **通用列表参数**：`searchParams`（JSON 字符串，过滤条件）、`limit`、`page`、`order`、`token`
- **通用写操作参数**：`params`（JSON 字符串）、`token`
- **站点配置**（实测，公开）：`POST system/app`，参数 `key=QyAPIZKw`，返回站点名/logo/`verifyLevel`（人机验证等级）/版本 `V0.4.2`/联系方式 `hqsf1904@163.com` 等。
- **图片验证码**：`GET hqUsers/getKaptcha` 直接返回验证码图片 URL。

## 2. 认证（hqUsers/）

| 接口 | 参数 | 说明 |
| --- | --- | --- |
| `userLogin` | `params={"name","password"}` | 账号密码登录（实测：错误时 `{"msg":"用户名或密码错误","code":0}`） |
| `phoneLogin` | `params={"phone","code"}` | 手机号+验证码登录 |
| `SendCode` / `sendSMS` / `RegSendCode` | `{phone, verifyCode}` 等 | 发送短信验证码 |
| `apiLogin` | `{nickName, appLoginType, headImgUrl, openId/accessToken}` | 第三方登录，`appLoginType` 取值 `qq` / `weixin` / `SINAWEIBO` |
| `getScan` / `setScan` / `getScanStatus` | — | 扫码登录（客户端可考虑实现） |
| `signOut` | `token` | 退出登录 |
| `userInfo` / `userData` / `userStatus` | `key`（uid） | 用户信息/状态。注意：**参数是 `key`=uid 而非 token**（GET，已从 h5 实测）；token 校验不能靠它 |
| `regConfig` / `userRegister` / `getInvitationCode` | — | 注册相关（有邀请码机制 `isInvite:1`） |

## 3. 写作与发布（hqContents/、hqForum/）

### 文章增删改查
- **列表**（实测，公开）：`hqContents/contentsList`
  - 参数：`searchParams={"type":"post", ...}`、`limit`、`page`、`order`、`searchKey`（搜索词，需 URL 编码，实测可用）、`token`（可选）
  - `type` 取值：`post`（已发布）、`post_draft`（草稿）、`waiting`（待审核）
  - `order` 支持：`created` / `modified` / `commentsNum` / `likes` / `replyTime` / `score` / `views`
  - 返回条目字段（实测）：`cid`、`title`、`type`、`status`（`publish` 等）、`score`（评分，如 `"3.9"`、未评 `"-.-"`）、`markdown`（0/1）、`text`（**400 字纯文本摘要**，无 HTML 标签）、`authorId`、`authorInfo`、`category`、`tag`、`collection`、`cover`、`images`、`introduction`、`slug`、`views`、`likes`、`commentsNum`、`created`、`modified`、`replyTime`、`isopen`、`istop`、`isrecommend`、`isswiper`、`isAnonymous`、`allowComment`、`allowPing`、`allowFeed`、`parent`、`shop`、`size`、`honor`、`fields`、`active`、`orderKey` 等
- **详情**（需登录）：`hqContents/contentsInfo`。**两种调用形态**（均已从 h5 实测）：编辑页 `POST {key, token}`（h5/hybrid/html/edit.html，作者拉自己文章/**草稿只能走这个**）；阅读页 `GET {key, isMd:0, token}`（pages-contents-info chunk，公开文章）。参数名是 **`key`**（即 cid）而非 `cid`/`id`。**响应不遵循 `{code,msg,data}` 约定**：成功返回裸文章对象 `{title,text,...}`（以 `title` 字段判断成功），失败返回 `{msg:'…'}`（如「该文章不存在」/「文章暂未公开访问」——后者是未公开草稿在 GET/匿名形态下的响应）。完整正文（HTML）与其余字段在此获取
- **新增/更新**（需登录）：`hqContents/contentsAdd` / `contentsUpdate`，POST 参数（从官方编辑器 edit.html 确认）：
  ```js
  {
    "params": JSON.stringify({title, category, tag, sid, active, isopen}),
    "token": ...,
    "text": quill.root.innerHTML,   // 正文为 HTML 字符串
    "isSpace": 0,
    "isDraft": 0|1,                 // 1=存草稿 0=直接发布
    "isMd": 0,                      // 0=富文本；本地 md 需转 HTML
    "verifyCode": ...,              // verifyLevel>1 时必填
    "collectionId": ...             // 可选，关联连载/合集
  }
  ```
  支持付费阅读：`isPaid=1` 时带 `shopText`、`shopPice`、`shopDiscount`。返回 `code:1` 成功；含「内容涉及违规」时触发拦截（`blockShow`）
- **删除**（需登录）：`hqContents/contentsDelete`
- **文档导出**：`hqContents/getDocx`（下载 docx）
- **其他**：`contentsAudit`（审核）、`toRecommend`（推荐）、`addTop`/`addSwiper`（置顶/轮播）、`setAuthor`/`setHonor`/`setIntroduction`/`setOpenStatus`/`setFields`（内容管理）、`rewardList`（打赏）、`isCommnet`

### 草稿
- 用户自己的草稿/待审核列表：`hqContents/contentsList` + `searchParams={"type":"post_draft"|"waiting", "authorId":uid}`（从草稿列表页 058d560b 确认）
- 论坛草稿另有：`hqForum/draftList`、`hqForum/draftDelete`

### 论坛/帖子（hqForum/）
`post`（发帖）、`edit`、`postInfo`、`postList`、`postDelete`、`postReview`（帖审核）、`postLikes`、`postReward`、`postCommentList`/`postComments`、`postTop`/`postLock`/`postRecommend`/`postSwiper`、`sectionList`/`sectionInfo`（实测当前为空，可能已停用）、`userPurview` 等

## 4. 评审（review/）—— 官方已有完整评审体系

- **评审列表**（实测，公开）：`review/reviewList`，`total` 已超 **1.2 万条**。返回结构：
  ```json
  {"actualscore":"-.-","attitudeType":-1,"isAi":0,
   "jiezou":"一眼看得到结尾的剧情。",
   "contentJson":{ 文章完整信息，title/score/cid/status/authorId/views/likes/... },
   "activeid":96,   // 关联活动（荒启练笔期数）
   "userJson":{uid, introduce, ...}}
  ```
- **评审详情**：`review/reviewInfo`，参数 `{id}`；返回含各维度评分
- **提交/编辑评审**（需登录）：`review/addReview` / `editReview`，参数 `params` JSON：
  ```js
  {dianzi, wenbi, renwu, jiezou, liyi, zonghe,   // 五维文字评语（各 ≥10 字）
   dianziScore, wenbiScore, renwuScore, jiezouScore, liyiScore,  // 各维度 0-10 分
   cid, activeid}   // 目标文章、关联活动
  ```
  **评审五维模型：点子（dianzi）/ 文笔（wenbi）/ 人物（renwu）/ 节奏（jiezou）/ 立意（liyi）**
- **态度**：`review/attitude`（`attitudeType`：-1 无 / 0 joy / 1 helpful，joy/helpful 计数）
- **任务化评审**：`review/reviewTask`、`review/reviewArticles`、`review/toUserTask`、`review/toUserReview`、`review/taskStatistics`、`review/taskVerification`、`review/reloadScore`、`review/incompleteTaskUser`、`review/incompleteTaskNotice`、`review/deleteTask`、`review/deleteUserAllTask`
- **AI 评审**：评审列表含 `isAi` 字段（0/1），说明荒启已有 AI 评审，与 gpt/ 模块联动

## 5. AI 模型（gpt/）

`gptList`（列表，参数 `{searchParams, limit, searchKey, page, order:"created", token}`）、`gptAdd` / `gptEdit` / `gptDelete` / `gptInfo`（模型管理）、`gptSendMsg` / `gptMsgList` / `gptSendText` / `gptSystemMsgList` / `gptLastMsg` / `gptChatDelete`（对话）。均需登录。对应客户端「推荐 → AI模型」栏目。

## 6. 合集 / 连载 / 作品库分类（hqMetas/）

- **列表**（实测，公开）：`hqMetas/metasList`，`total` 91 个。返回：`mid`、`type`（`category` 分类 / 合集 / 连载等）、`name`（如「原创作品」）、`slug`（如 `OriginalWorks`）、`description`、`imgurl`、`parent`、`count`、`allowed`、`isReview`、`deadline`
- **详情/增删改**：`metaInfo`（geMetaInfo）、`addMeta` / `editMeta` / `deleteMeta`、`collectionInfo` / `addCollection` / `editCollection` / `deleteCollection`
- **合集选文章**：`selectContents`（getMetaContents）
- 客户端「作品库」四个分类（原创作品/科幻杂谈/官方公告/外文翻译）即为 `type="category"` 的 metas（mid 1,2,…）

## 7. 活动 / 练笔（vote/ 与 metas 的 active）

- `vote/voteList`、`voteInfo`、`voteDataList`、`voteDataInfo`、`myVoteData`、`addVote`/`editVote`、`auditVote`（实测 `voteList` 返回 `total:12` 但 `data` 为空——站点公告称「关闭投票」，**投票功能当前停用**）
- 练笔活动的期数（第 X 期）与评审的 `activeid` 关联；活动页对应 `pages-contents-active`（`active` 字段在文章中出现）
- 需进一步确认：活动列表接口与 activeid 的取数方式

## 8. 其他模块

- **评论**：`hqComments/commentsList`（`{type:"comment", status:"approved"}`）、`commentsAdd`、`commentsDelete`、`commentsAudit`
- **内容栏目**：`hqContents/choiceList`（精选）、`foreverblog`（永更楼）、`allData`、`ImagePexels`（图库）
- **用户**：`userList`、`fanList`、`follow`/`isFollow`/`followList`、`unreadNum`、`setRead`、`inbox`、`violationList`、`restrict`、`banUser`、`sendUser`、`userEdit`、`manageUserEdit`
- **空间**：`hqSpace/spaceList`、`spaceInfo`、`addSpace`/`editSpace`、`spaceLikes`、`spaceLock`、`spaceReview`、`followSpace`
- **聊天**：`hqChat/myChat`、`allChat`、`msgList`、`sendMsg`、`getPrivateChat`、`groupInfo`、`createGroup` 等
- **商城/付费**：`hqShop/shopList`、`shopInfo`、`buyShop`、`buyVIP`、`vipInfo`、`vipTypeList`；`pay/*`（`EPay`、`qrCode`、`scancodePay`、`WxPay`、`tokenPay`、`madetoken`）
- **上传**：`upload/full`（图片/附件上传）
- **其他**：`hqAds/*`（广告）、`hqUserlog/*`（日志/书签）、`identify/*`（实名认证）、`library/*`（关键词库：`libraryKeywordsList`、`randomKeywords`、`keywordsInfo`）、`review` 见上

## 9. 对客户端设计的直接影响

1. **登录方式已确认**：账号密码 + 手机验证码 + QQ/微信/微博第三方 + 扫码。design.md 的「登录方式待确认」风险解除。
2. **评审机制已确认存在**：官方五维评审（点子/文笔/人物/节奏/立意）+ 评分 + AI 评审 + 任务化评审。客户端「读审一体」应直接复用 `review/*` 接口，而非自建。design.md 的对应风险解除。
3. **正文格式差异（重要）**：荒启正文存 **HTML**（Quill），`isMd:0`；但文章对象有 `markdown` 字段（0/1），且客户端逻辑对 `markdown==1` 的文章走 md 编辑器。本地 md 同步到荒启时需 **md → HTML 转换**；建议客户端保留「md 存储 + 同步时转 HTML」策略，并探测 md 文章接口的兼容性。
4. **列表接口即公开**：`contentsList`/`reviewList`/`metasList` 匿名可读，但**完整正文 `contentsInfo` 需要 token**——客户端阅读视图必须登录。
5. **待审核/已拒绝/草稿** = `contentsList` + `{type: post_draft|waiting, authorId}`，客户端四态展示直接可用。
6. **AI 模型栏目** = `gpt/*` 接口，已登录可用。
7. **练笔活动**：投票接口当前停用，活动数据另需确认（`active` 字段 / `contents-active` 页逻辑）。
8. **接口风格统一**：`searchParams` JSON + `token` 表单参数 + `code/msg` 响应——客户端 API client 适配层按此约定封装即可，一次适配全站通用。

## 10. 待确认事项（实施阶段）

- [ ] `contentsInfo` 完整返回结构与 md 文章的正文格式（需真实账号 token）
- [ ] 活动（练笔期数）列表的取数接口（`active` 字段来源）
- [ ] 扫码登录（`getScan`/`setScan`/`getScanStatus`）完整流程
- [ ] 发布时的敏感词/审核拦截细节（`verifyCode` 触发条件、`verifyLevel` 变化）
- [ ] `draftList`（hqForum）与 `contentsList type=post_draft` 的关系与差异
- [ ] gpt 对话接口的请求/响应格式（SSE 或轮询）
- [ ] `review/reviewTask` 任务化评审的规则（评分体系如何结算）
