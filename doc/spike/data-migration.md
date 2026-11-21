# SP-4 数据迁移：Electron(better-sqlite3) → Tauri 2(rusqlite) 真实数据实测

> 范围：回答「1.x 用户数据能不能被 Tauri 直接读、怎么搬、搬完还剩什么坑」。
> 全部结论基于本机真实数据 + 实际执行，命令与输出见 `spikes/migrate/work/logs/`。
> 配套代码：`spikes/migrate/rs/`（`inspect` / `migrate` / `tauri_sim` 三个 bin）。

**环境**：Linux（Debian，沙箱 HOME 只读）；cargo/rustc 1.99.1；`rusqlite 0.43.0` + `libsqlite3-sys 0.40.0`（bundled **SQLite 3.54.1**，运行时实测）；
旧端 Electron `^34.5.8` + better-sqlite3 `12.11.1`（其 vendored `sqlite3.h:149` = **SQLite 3.53.2**，`node_modules/better-sqlite3/deps/sqlite3/sqlite3.h`）；
客户端版本 `package.json` = `hqsf-client 1.2.13`。

---

## 0. 结论（TL;DR）

| 问题 | 结论 | 证据 |
| --- | --- | --- |
| 真实数据存在吗 | **存在**，且应用多次运行过 | `spikes/migrate/work/logs/source-listing.txt` §1 |
| 表行数 | `articles=0`、`read_cache=18`、`meta=0` | `work/logs/inspect-client.txt` |
| `user_version` | **0**（旧端从未设置；`schema_version=5` 是内部 schema cookie） | 同上 |
| journal mode | `wal`，且带 **601,552 B 未 checkpoint 的 `-wal`**（146 帧） | 同上 |
| DDL 有列差异吗 | **0 差异**（列名/亲和性/NOT NULL/默认值/主键/索引逐项比对） | `work/logs/inspect-client.txt` §逐列比对 |
| rusqlite 能直读吗 | **能**；同款 `CREATE TABLE IF NOT EXISTS` 在旧库上幂等、不改数据 | `work/logs/tauri-sim.txt` |
| 迁移脚本跑通了吗 | **跑通**：复制→校验→折叠 WAL→原子落位→写标记；幂等、失败回滚、源零改动 | `work/logs/migrate-run1.txt`、`migrate-run2-idempotent.txt`、`migrate-failure-tests.txt` |
| token 怎么办 | 真实数据**没有 `session.json`**；即使有也**不复制**，必须重新登录 | 见 §7 |
| 有阻断项吗 | **无** | 见 §11 |

一句话：**旧库是标准 SQLite 3 WAL 库，没有用到任何新版本文件特性；把 `-wal` 一起带走并折叠后，Tauri 侧可以直接读写。**

---

## 1. 真实数据在哪：路径、文件清单、应用是否跑过

### 1.1 Linux 实测（`ls -la --time-style=full-iso` 原始输出摘录）

`~/.config/hqsf-client/`（**正式数据**，`app.getPath('userData')`）：

| 文件 | 大小 (B) | mtime（+08:00） | sha256 | 说明 |
| --- | ---: | --- | --- | --- |
| `hqsf.db` | 1,683,456 | 2026-11-21 01:21:24 | `642440c4ddf5ccd9514d2d93f3e41502be7d7af7a5971a68fd7e924de3a9a45c` | 主库，WAL 模式 |
| `hqsf.db-wal` | 601,552 | 2026-11-21 12:33:33 | `dddebe403ab6aa9106e5aad29ddda2e3eaa9daa544cb06b6ef6ad991f7dd787d` | **未 checkpoint，含最近写入** |
| `hqsf.db-shm` | 32,768 | 2026-11-21 12:33:32 | `5ccdbc4c10593677c9200aa56dc0effa6c02f3329c389ae5d50b5d1776dba668` | 共享内存索引（可重建，无需复制） |
| `settings.json` | 106 | 2026-08-22 14:19:55 | `71df66d685290104c18e4bb768d0dee1b27eb1afb592cc02fbd7b357bdcd97ad` | mode `0600` |
| `session.json` | — | — | — | **不存在**（用户从未登录，或已退出登录时被删除） |
| `cache/images/` | 13,281,256（184 个文件，其中 92 个 `*.meta`） | 2026-11-21 | — | 图片缓存，sha1 命名 + `.meta`（`{"ct":"image/jpeg"}`） |

同目录还残留 Electron 运行痕迹（**证明应用跑过、且上次不是正常退出**）：

- `SingletonLock -> debian-27241`、`SingletonCookie -> 9969488234672288943`、`SingletonSocket -> /tmp/scoped_dirJsp66y/SingletonSocket`，三个软链时间 2026-11-21 12:16:11；其中 `/tmp/scoped_dirJsp66y` 已不存在（PID 27241 也不在），是典型的「进程被杀/崩溃 → 锁文件没清」。
- `Cache/`、`Code Cache/`、`GPUCache/`、`Local Storage/`、`Cookies`（20,480 B）、`DevToolsActivePort`（59 B，mtime 08-28）、`Network Persistent State`（11-21 12:19）、`.org.chromium.Chromium.EFCUch`（11-21 12:47:17，Chromium 异常退出的临时文件）等，时间跨度 08-05 → 11-21。
- 现场 `ps` 检查：**无 `hqsf`/`electron` 进程**（`work/logs/source-listing.txt`），所以复制时源库没有活连接——这是能安全复制的前提。
- `hqsf.db` 主文件 mtime 停在 01:21，而 `-wal` 写到 12:33：说明 01:21 之后的写入全在 WAL 里，**这正是不能只复制 `hqsf.db` 的原因**（见 §2.2）。

`~/.config/hqsf-test/`（测试模式，`isTestMode()` 时 `app.setPath('userData', appData/hqsf-test)`，见 `src/main/index.ts:9-11`、`src/main/testmode.ts`）：

| 文件 | 大小 (B) | mtime | sha256 |
| --- | ---: | --- | --- |
| `hqsf.db` | 36,864 | 2026-08-11 21:06:43 | `ab432cfbf01f6cde4696280e0ecd50ae82389e44f82d3197073c021b85242a1f` |
| `hqsf.db-wal` / `-shm` / `settings.json` / `session.json` | — | — | **均不存在** |

另有 `DevToolsActivePort`、`cache/images/`（2 个文件）等测试模式残留；该库三张表全空（§3.2）。

### 1.2 跨平台路径对照（迁移必须处理「两个不同的根」）

| | Electron 1.x（源，`app.getPath('userData')`） | Tauri 2（目标，identifier `com.huangqisf.client`） |
| --- | --- | --- |
| Linux | `~/.config/hqsf-client`（基目录是 `XDG_CONFIG_HOME`/`~/.config`） | `~/.local/share/com.huangqisf.client`（`app_data_dir` = `XDG_DATA_HOME`）；注意同 identifier 的 `~/.config/com.huangqisf.client` 是 **`app_config_dir`**，不要与数据目录混用 |
| Windows | `%APPDATA%\hqsf-client`（Roaming） | `%APPDATA%\com.huangqisf.client`（Roaming） |
| macOS | `~/Library/Application Support/hqsf-client` | `~/Library/Application Support/com.huangqisf.client` |
| 测试模式 | `~/.config/hqsf-test` / `%APPDATA%\hqsf-test` / `~/Library/Application Support/hqsf-test` | `com.huangqisf.client-test`（同基目录规则；Linux 即 `~/.local/share/com.huangqisf.client-test`） |

目标路径依据 `doc/design/Tauri迁移计划.md:127-129`（「首启检测旧目录 → 复制 `hqsf.db`、`settings.json`、图片缓存 → 写迁移标记；**不删除**旧目录」，token「强制重新登录」）。

> ⚠️ Tauri 的 identifier 是**编译期**配置，`app_data_dir()` 自动带当前 identifier。测试模式不能靠环境变量改 identifier，必须在代码里手工拼 `-test` 后缀（或构建第二个 identifier 的包）——这和 Electron 里运行期 `app.setPath('userData', …)` 不同，是移植时容易漏的点。

### 1.3 数据「重要性」判断（决定迁移兜底力度）

- `articles=0`：该用户没有本地草稿/关联文章记录，**不存在用户原创内容丢失风险**。
- `read_cache=18`：文章正文缓存（派生数据，24h TTL 后会自动失效重取，见 `src/main/infra/db/index.ts:181` 的 `READ_CACHE_TTL_MS`（过期判定 `:196`））。丢了不影响正确性，只影响首屏离线速度。
- `meta=0`：`docs_root`（文档根目录设置，键名见 `src/main/infra/fs/index.ts:14`）未被改过 → 用默认值即可。
- `settings.json`：zoomFactor / customCss / customJs / autoUpdate / hardwareAccel，**要保留**（用户可感知）。
- 图片缓存 13.3 MB：可选复制，丢了会重新下载。

结论：这是**低风险迁移**——真正必须保的是 `settings.json` 与「库文件本身能被新端打开」；`read_cache` 需要 WAL 才能完整拿到（否则 18 行只剩 6 行，见 §2.2）。

---

## 2. 样本复制与 WAL 一致性

### 2.1 复制方式（源只读，不写源目录）

```bash
# 只读源 → spikes/migrate/data/client/（保留 mtime；不复制 -shm）
cp --preserve=timestamps ~/.config/hqsf-client/hqsf.db     spikes/migrate/data/client/
cp --preserve=timestamps ~/.config/hqsf-client/hqsf.db-wal spikes/migrate/data/client/
cp --preserve=timestamps ~/.config/hqsf-client/settings.json spikes/migrate/data/client/
# 测试模式
cp --preserve=timestamps ~/.config/hqsf-test/hqsf.db spikes/migrate/data/test/
```

- **`-wal` 必须一起复制**：它和 `hqsf.db` 是同一个数据库的两个组成部分，缺一不可（§2.2 实测）。
- **`-shm` 不复制**：它只是 WAL 的共享内存索引，SQLite 打开时会按 `-wal` 重建；复制陈旧的 `-shm` 反而可能误导（WAL 头校验不过时 SQLite 会自己忽略/重建）。
- **不对源库做 checkpoint**：`PRAGMA wal_checkpoint` 会写源目录（还可能删除 `-wal`），违反「不写用户真实数据目录」。折叠只在副本/暂存目录做（§6）。
- **不依赖 `sqlite3 .backup`**：本机无 `sqlite3` CLI；且 `.backup` 也需要一个能打开源库的进程（会写 `-shm`）。直接复制 `db + wal` 在「旧进程已退出」前提下等价且零写入。

源文件哈希前后对照（`spikes/migrate/data/SOURCE-SHA256.txt` 记录复制时值，迁移完成后重算一致）：

```
642440c4…a9a45c  ~/.config/hqsf-client/hqsf.db
dddebe40…df787d  ~/.config/hqsf-client/hqsf.db-wal
5ccdbc4c…b6ef6a  ~/.config/hqsf-client/hqsf.db-shm
71df66d6…cd97ad  ~/.config/hqsf-client/settings.json
ab432cfb…242a1f  ~/.config/hqsf-test/hqsf.db
```

迁移脚本最后一步会重算源 `hqsf.db`/`hqsf.db-wal` 的 sha256 并与开始时对比，不一致就报错退出（防止「复制时应用还在跑」）。

### 2.2 WAL 一致性反例（为什么不能只复制 db）

同一份 `hqsf.db`，**只复制 db、丢弃 `-wal`** 后只读打开（`work/logs/inspect-client-nowal.txt`）：

| 指标 | 带 `-wal`（正确） | 只 db（错误） |
| --- | ---: | ---: |
| `read_cache` 行数 | **18** | **6** |
| `read_cache` payload 总字节 | 180,617 | 28,824 |
| `fetched_at` 最新值 | 2026-11-21T04:33:33Z | 2026-11-20T17:10:12Z |

即：丢弃 WAL 会静默丢掉 **12 行 / 151,793 B** 最近阅读缓存，而且 `integrity_check` 依然返回 `ok`——**不会报错，只会少数据**，这是迁移里最危险的静默失败模式。所以：**复制必须带 `-wal`，并在落位前把它折叠进主库**。

### 2.3 只读打开的副作用（实测，写实现时要处理）

对 WAL 模式的库做**只读打开**（校验工具、备份脚本、`inspect`）会在其目录里留下：

- `hqsf.db-shm`（32,768 B，属正常）
- `hqsf.db-wal`（**0 字节**，read-only 连接无法删除）

SQLite 3.54.1（rusqlite bundled）与系统 Python 3.46.1 复现同样行为；原因是只读连接需要 `-shm` 参与 WAL 索引，且不能做「最后一个连接关闭时删除 `-wal`」的动作。**一切以读写模式打开再干净关闭的连接（如迁移脚本的最终校验）则会把两者清掉。**

对策（已实现在 `migrate.rs`）：折叠与复核都在 `<target>/.migrate-staging/` 里做，rename 只搬 `hqsf.db`/`settings.json`；落位后目标目录断言只有 `hqsf.db`、`settings.json`、`migration.json`。如果生产代码要在用户目录里跑只读体检，记得**校验完成后清理这两个残留文件**，否则 `-wal` 0 字节文件会被误认为「有未提交数据」。

---

## 3. 实测数据库元信息与行数

### 3.1 正式库 `data/client/hqsf.db`（带 WAL，只读打开）

| 项 | 值 |
| --- | --- |
| `sqlite_version()` | 3.54.1（rusqlite 0.43 bundled；旧端写入方是 3.53.2） |
| `user_version` | **0** |
| `schema_version` | **5**（3 张表 + 2 个显式索引 = 5 条 DDL，与建表历史一致） |
| `journal_mode` | **wal** |
| `page_size` | 4096 |
| `page_count` | 411 |
| `freelist_count` | 288（无 WAL 打开时为 384） |
| `encoding` | UTF-8 |
| `auto_vacuum` | 0 |
| `application_id` | 0 |
| `integrity_check` | ok |
| 其他连接级默认 | `synchronous=2`、`foreign_keys=1`、`secure_delete=0`、`wal_autocheckpoint=1000` |
| WAL | 601,552 B ≈ **146 帧**（page_size 4096） |

> `user_version=0` + 无 `schema_migrations` 表：旧端**没有版本化迁移机制**，建表就是 `CREATE TABLE IF NOT EXISTS` 幂等执行（`src/main/infra/db/index.ts:94-98`）。Tauri 侧不要假设 `user_version` 有任何含义。

### 3.2 行数

| 表 | client（正式） | test（测试模式） |
| --- | ---: | ---: |
| `articles` | 0 | 0 |
| `read_cache` | **18** | 0 |
| `meta` | 0（迁移后 1，迁移标记） | 0（迁移后 1） |

- `read_cache` 18 行，payload 合计 **180,617 B**，`fetched_at` 范围 `1795192773676`（2026-11-20T16:39:33Z）～ `1795235613387`（2026-11-21T04:33:33Z），即本地时间 **11-21 00:39:33 → 12:33:33（UTC+8）**，与旧端最后运行时间一致（WAL mtime 12:33:33）。
- test 库：`user_version=0`、`schema_version=5`、`journal_mode=wal`、`page_size=4096`、`page_count=9`、`freelist_count=0`、`encoding=UTF-8`、`integrity_check=ok`。

### 3.3 样例行（正文截断）

`read_cache` 的 key 有两种形态：`article:<期号>:<cid>`、`article:anon:<cid>`；value 是文章 JSON（`{cid,title,text}`，text 为 HTML）：

```
row1: key=article:2404:1000000076  fetched_at=1795193010311
      payload={"cid":"1000000076","title":"第二十六期练笔主题悬赏：黑色幽默",
               "text":"<p>悬赏主题：黑色幽默。</p><p>悬赏范围：…（共 1021 字符）
row2: key=article:2404:1000000131  title="树人"
row3: key=article:2404:1083        title="荒启APP，给作品添加音乐和视频"
...
key=article:anon:1000000115  / article:anon:1000000094 / article:anon:2468 ...
```

完整（截断 160 字符）输出见 `work/logs/inspect-client.txt` §样例行。

---

## 4. 完整 DDL（`sqlite_master` 原样，可直接抄进 Rust）

来源：真实库 `SELECT type,name,tbl_name,sql FROM sqlite_master`（`work/logs/inspect-client.txt` §sqlite_master）。

```sql
CREATE TABLE articles (
  cid TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'local',
  status TEXT NOT NULL DEFAULT '',
  author_id TEXT NOT NULL DEFAULT '',
  remote_modified INTEGER NOT NULL DEFAULT 0,
  local_modified INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL DEFAULT '',
  file_path TEXT NOT NULL DEFAULT '',
  synced_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_articles_type ON articles(type);
CREATE INDEX idx_articles_file_path ON articles(file_path);

CREATE TABLE read_cache (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
```

- 另有 3 个隐式索引：`sqlite_autoindex_articles_1`、`sqlite_autoindex_meta_1`、`sqlite_autoindex_read_cache_1`（`TEXT PRIMARY KEY` 自动生成，**不需要也不应该手工建**）。
- 建表语句与 `src/main/infra/db/index.ts:29-58` 的 `SCHEMA` 常量逐字一致；`initDb` 是 `new Database(file)` → `PRAGMA journal_mode = WAL` → `db.exec(SCHEMA)`（同文件 `:94-98`）。
- 与代码期望逐列比对结果：**0 差异**（列名 / 类型亲和性 / `NOT NULL` / 默认值 / 主键 / 索引全部一致，client 与 test 两个库都是 0 差异）。

Rust 侧建表建议（与旧端完全对齐，且幂等）：

```rust
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS articles ( ...同上 12 列... );
CREATE INDEX IF NOT EXISTS idx_articles_type ON articles(type);
CREATE INDEX IF NOT EXISTS idx_articles_file_path ON articles(file_path);
CREATE TABLE IF NOT EXISTS read_cache ( ...同上 3 列... );
CREATE TABLE IF NOT EXISTS meta ( ...同上 2 列... );
"#;
```

`spikes/migrate/rs/src/bin/tauri_sim.rs` 里用**完全相同的 DDL** 在旧库上执行过：0 处 schema 差异、行数不变、`read_cache` 整表指纹不变（`work/logs/tauri-sim.txt`）。

---

## 5. `settings.json`

真实内容（106 B，mode 0600）：

```json
{"autoUpdate":false,"customCss":"","customJs":"","hardwareAccel":true,"zoomFactor":1}
```

与 `src/main/infra/settings/index.ts:12-20` 的 `DEFAULT_APP_SETTINGS = {autoUpdate:false, hardwareAccel:true, zoomFactor:1, customCss:'', customJs:''}` 完全一致；`normalize()`（同文件 `:26-33`）会把 `zoomFactor` 夹到 `[0.8, 1.5]`。

rusqlite 侧反序列化验证（`spikes/migrate/rs/src/lib.rs` 的 `AppSettings`，camelCase serde）：

```
raw: {"autoUpdate":false,"customCss":"","customJs":"","hardwareAccel":true,"zoomFactor":1}
serde 严格反序列化: OK
parsed      = {"autoUpdate":false,"hardwareAccel":true,"zoomFactor":1.0,"customCss":"","customJs":""}
normalized  = {"autoUpdate":false,"hardwareAccel":true,"zoomFactor":1.0,"customCss":"","customJs":""}
与 DEFAULT_APP_SETTINGS 相等: true
未知字段: 无；字段类型: 全部符合
```

迁移写法：`settings.json` 是纯 JSON、无加密、字段稳定，**直接复制**即可；写入时建议 tmp + `rename` 原子替换（旧端目前是直接 `writeFileSync`，见 `src/main/infra/settings/index.ts:58`，Tauri 侧可顺手做得更稳）。若文件缺失/损坏 → 落到 `DEFAULT_APP_SETTINGS`，不要因此阻断迁移。

---

## 6. 迁移流程（已在真实样本上跑通）

实现：`spikes/migrate/rs/src/bin/migrate.rs`（用法 `migrate --from <旧目录> --to <新目录> [--dry-run] [--force]`）。
以下每步都对应日志里的断言，实测输出见 `work/logs/migrate-run1.txt`。

### 6.1 前置条件

1. **旧端必须已退出**。检测手段：目标库无活进程；复制前后源 `hqsf.db`/`hqsf.db-wal` 的 sha256 必须一致。旧端如果还开着，WAL 会继续变长 → 迁移脚本在最后一步发现哈希变化，报错并要求重来（不会把半截数据搬到新端）。
2. 旧目录存在 `hqsf.db` 才迁移；不存在则跳过（新用户直接建库）。
3. 新目录状态判定（`--force` 的语义，实测见 §6.3 E/F/G）：
   - 有 `migration.json` 且**源指纹一致** → 幂等跳过（不写任何文件）；加 `--force` 则强制重做一次。
   - 有 `migration.json` 但**源指纹已变化**（旧端迁移后又被写过）→ 默认拒绝（`exit 1`）；加 `--force` 允许用当前源重新迁移，只替换新目录，旧目录不动。
   - 有 `hqsf.db` 但**无标记** → 拒绝覆盖；加 `--force` 允许覆盖并补写标记（用于「db 已落位但 marker 写失败」的修复）。

### 6.2 步骤（含失败点）

| # | 动作 | 失败时 |
| --- | --- | --- |
| 1 | 记录源指纹（`hqsf.db` / `hqsf.db-wal` / `settings.json` 的大小+sha256，`session.json` 是否存在） | 读不到 → 报错退出，不落盘 |
| 2 | 检查目标状态（`migration.json` 标记 / 是否已有 db） | 状态冲突 → 拒绝并提示 |
| 3 | 复制 `hqsf.db` → `<to>/.migrate-staging/hqsf.db`，`hqsf.db-wal` → 同目录同名 `-wal`，`settings.json` 一并复制 | 复制失败 → 删 staging，报错 |
| 4 | 在 staging 副本上打开：`integrity_check` → 记录 `user_version`/`schema_version`/`journal_mode`/`page_size`/`encoding` → 记录折叠前行数/整表指纹 | `integrity_check != ok` 或打开失败 → 删 staging，`exit 1`（实测损坏源报 `database disk image is malformed`，目标目录**不留** db/staging） |
| 5 | `PRAGMA wal_checkpoint(TRUNCATE)`（可能需二次）把 WAL 折叠进主库；写入 `meta['migration.electron']` 迁移标记（JSON） | 失败 → 删 staging |
| 6 | 关闭连接（SQLite 会删除 `-wal`/`-shm`）→ **不带 `-wal` 重新只读打开**：`integrity_check` 必须 ok，`articles`/`read_cache` 整表指纹必须与折叠前**逐字节一致**，`meta` 行数应为折叠前 +1 | 不一致 → 数据不完整，删 staging，`exit 1`（这条是防「WAL 只折叠了一半」的真正验收） |
| 7 | `rename` staging 的 `hqsf.db`、`settings.json` 到目标目录（同文件系统，原子）；删 staging；复核落位后 db sha256 == staging 折叠后的 sha256 | rename 失败 → 目标目录保持原状（旧数据目录完全没动） |
| 8 | 写 `migration.json`（原子写） | 写失败 → db 已落位但无标记，下次启动会因「有 db 无标记」拒绝覆盖 → 人工介入（可重跑 `--force`） |
| 9 | 复核源目录 sha256 未变 | 变化 → 报错「源库在迁移过程中被修改，需重来」 |

关键取舍说明：

- **折叠 WAL 用 checkpoint，而不是「把 db 和 wal 一起 rename 到新目录」**：后者会把 WAL 依赖带到新目录（任何只复制 db 的备份/同步工具都会静默丢数据），且 `-shm` 状态与文件系统相关。折叠后新目录拿到的是**单文件自洽库**，这是迁移最想要的形态。
- **checkpoint 返回值不可信**：本机 SQLite（3.50.2 / 3.54.1）与 Python 3.46.1 对「首次打开旧库时的 recovery checkpoint」都返回 `(0,0,0)`，但 `-wal` 确实被截断为 0。因此验收标准是「关闭后无 `-wal` 重开、行数与整表指纹不变」，不是看返回值。
- **失败回滚**：所有中间产物都在 `<to>/.migrate-staging/`，目标目录只在第 7 步 rename 时才出现文件；任何一步失败都删 staging 并退出，**不会留下半个库**，也不会动旧目录。
- **不删除旧目录**：迁移完成后 `~/.config/hqsf-client/` 原样保留（含 `-wal`），这是回滚路径；`migration.json` 里记录了源指纹，可用于「源在迁移后又被写过」的检测。

### 6.3 实测结果

| 场景 | 结果 | 日志 |
| --- | --- | --- |
| 首次迁移 | `exit 0`；目标 `hqsf.db` sha256 每次不同（`meta` 内含 `migrated_at`，故字节不追求确定性；修复后回归为 `dadedcfb…726c`），目录内容 `["hqsf.db","settings.json"]` → 随后写 `migration.json` 共 3 个文件；行数 `{articles:0, read_cache:18, meta:1}` | `migrate-run1.txt` |
| 第二次运行（幂等） | `exit 0`；「目标已有 migration.json 且源指纹完全一致 → 幂等跳过（不复制、不写任何文件）」；目标 db sha256 **不变** | `migrate-run2-idempotent.txt` |
| 损坏源（截断到 4096 B） | `exit 1`，`database disk image is malformed`；目标目录空（无 db、无 staging） | `migrate-failure-tests.txt` A |
| 目标已有 db 但无标记 | `exit 1` 拒绝覆盖；原 db 哈希未变 | 同上 B |
| 目标有标记但源已变化（无 `--force`） | `exit 1`，提示「加 --force」；目标 db 哈希不变 | 同上 C / G3 |
| 目标无标记 + `--force` | `exit 0`，覆盖并写标记；行数 `{0,18,1}` | 同上 E |
| 有标记 + 源变化 + `--force` | `exit 0`，重迁成功；marker 源指纹更新为当前源、行数随新源变为 `{0,0,1}`（用 test 库做源） | 同上 G4；再跑 `--force` 仍 `exit 0`（G5） |
| `--dry-run` | `exit 0`；目标目录保持空 | 同上 D |
| Tauri 侧首次启动模拟 | 同款 DDL 幂等（0 差异、行数不变）；插入/读回/删除测试行 OK；`user_version` 仍 0；重开 `integrity_check=ok`；无测试残留；`read_cache` 指纹不变 | `tauri-sim.txt` |

### 6.4 目标目录的最终形态

```
<app_data_dir>/com.huangqisf.client/
├── hqsf.db            # 已折叠 WAL 的单文件库（1,683,456 B；journal_mode 仍记录为 wal）
├── settings.json
└── migration.json     # 迁移标记（幂等判定 + 源指纹 + 目标指纹 + 行数 + schema 差异）
```

Tauri 首次以读写方式打开后，目录会多出 `hqsf.db-wal`/`hqsf.db-shm`（WAL 是持久化在文件头里的，打开即 WAL），属正常；干净关闭会清掉。**迁移脚本落位时刻意做到「只有 3 个文件」，便于外部工具识别是否已迁移。**

### 6.5 `migration.json` 字段（可作为 Tauri 侧 marker schema）

```json
{
  "marker_version": 1,
  "tool": "hqsf-migrate-spike 0.1.0",
  "migrated_at_ms": 1795239609135,
  "migrated_at_iso": "2026-11-21T05:40:09Z",
  "source_dir": "/home/kidelee/.config/hqsf-client",
  "target_dir": ".../com.huangqisf.client",
  "source": {
    "db_sha256": "642440c4…a9a45c", "db_size": 1683456,
    "wal_sha256": "dddebe40…df787d", "wal_size": 601552,
    "settings_sha256": "71df66d6…cd97ad",
    "session_present": false
  },
  "target_db_sha256": "0a1dabbd…e5db34",
  "target_db_size": 1683456,
  "user_version": 0, "schema_version": 5,
  "journal_mode_before_checkpoint": "wal", "journal_mode_after_checkpoint": "wal",
  "page_size": 4096, "encoding": "UTF-8",
  "wal_frames": 146, "wal_bytes_after_checkpoint": 0,
  "rows": { "articles": 0, "read_cache": 18, "meta": 1 },
  "table_fingerprints": { "…整表行+内容 sha256…": "…" },
  "schema_diffs": [],
  "verified_without_wal": true,
  "session_action": "源目录本无 session.json：无需清理，首次启动即未登录状态"
}
```

幂等判定用 `source` 指纹（db+wal+settings 的 sha256 与大小）与 `target_db_sha256`；`source.session_present` 供 UI 决定是否提示「需要重新登录」。`migrated_at_ms` 会写进 `meta` 与 `migration.json`，因此**两次全新迁移的产物字节不可能相同**（时间戳不同）——这是预期行为，「幂等」指的是**重复运行不改动已迁移结果**，不是「重复迁移得到同一串字节」。

### 6.6 图片缓存（可选，建议做）

旧：`<旧 userData>/cache/images/`，184 个文件 / 13,281,256 B（sha1 文件名 + 同名 `.meta`，`{"ct":"image/jpeg"}`），代码见 `src/main/infra/media/imgcache.ts:23,57-58`（`CACHE_ROOT = 'cache/images'`）。
新端保持相对路径 `<app_data_dir>/cache/images/` 即可。建议：迁移时**只复制目录、不逐字节校验**（丢了会重新下载），复制数量/大小做一次基本对账；失败不影响 DB 迁移成功。

### 6.7 并发与崩溃

- 迁移必须在「旧端单实例锁已释放」之后、Tauri 窗口创建之前完成；Tauri 侧也要有单实例插件，避免两个进程同时首启迁移（两个进程都看到「无标记」→ 都去写 staging/rename）。
- 若迁移中途崩溃：目标目录要么还没出现 `hqsf.db`（staging 残留，下次启动先清 `.migrate-staging/`），要么 db 已 rename 但 `migration.json` 未写（下次启动按「有 db 无标记」拒绝覆盖 → 应支持 `--force`/人工确认，或实现「无 marker + 无 wal + 行数与源一致」时补写 marker 的自愈分支）。建议生产实现里**先写 db 再写 marker**，并提供 `repair` 分支。

---

## 7. token 处理结论：必须重新登录，旧 session 不复制、不删除

代码事实（`src/main/infra/session/index.ts`）：

- 存 `userData/session.json`，结构 `{tokenCipher, cipher:'safeStorage'|'base64', userinfo, savedAt}`（`SessionFile` 结构 `:16-22`，`saveSession` `:51-65`，`sessionFile()` `:24-26`）。
- 强加密时 `safeStorage.encryptString(...)`；不可用/降级时 `cipher:'base64'`（明文 base64）。Linux 上 `safeStorage` 可能落到 `basic_text` 后端（硬编码 key 的可逆混淆），`isStrongEncryption()` 会把它标成 insecure（`:41-50`）。两者都**依赖 Electron/系统密钥材料，Tauri 无法跨实现解密**。
- 真实数据现状：`~/.config/hqsf-client/` 与 `~/.config/hqsf-test/` **都没有 `session.json`** → 用户当前处于未登录状态，**迁移时无需清理任何 token**。

结论与实现约定：

1. **不复制 `session.json`**：复制了也解不开，只会让新端误以为「有会话」。
2. **不删除旧目录里的 `session.json`**（如果存在）：旧目录整体保留是回滚路径，删了会让用户回退 Electron 时也要重新登录，且违反「不修改用户旧数据目录」的原则。
3. **识别**：`migration.json.source.session_present`（布尔）+ 源目录里 `session.json` 的存在性；Tauri 首启若为 `true`，弹一次性提示「检测到旧版登录信息，出于安全原因需要重新登录」。
4. **清理**：新端只清自己的凭据存储（系统钥匙串条目 / Tauri `session` 文件），不碰旧目录。若新端曾经在 beta 里写过 Tauri session，也按「token 变化/失效」走正常重新登录流程。
5. **安全提醒**（写进发布说明）：旧目录里的 `session.json` 若存在，可能是 `basic_text`/base64（与明文等价），迁移不会扩大该风险，但也不会清除它；提示用户可手动删除旧目录（产品上不自动删）。

---

## 8. 与 Electron 版本的兼容风险（逐项）

### 8.1 文件格式与 SQLite 版本

| 项 | 实测 | 风险评估 |
| --- | --- | --- |
| 源写入方 | better-sqlite3 12.11.1 → bundled **SQLite 3.53.2** | — |
| 目标读取方 | rusqlite 0.43.0 → bundled **SQLite 3.54.1**（工作区 `Cargo.toml` 已锁 `rusqlite = { version = "0.43", features = ["bundled"] }`） | 目标库版本 ≥ 源库，**向后兼容方向正确**（新库读旧库是常规路径） |
| 页大小 | 4096（旧端未改过） | rusqlite/bundled 默认同样 4096；**迁移中不要 `PRAGMA page_size`**，不要 VACUUM |
| 文本编码 | UTF-8 | rusqlite `String` 要求合法 UTF-8；18 条中文 payload 整表指纹逐字节一致，验证无转码问题 |
| 自增/主键 | `cid TEXT PRIMARY KEY`（无 AUTOINCREMENT、无 `WITHOUT ROWID`、无 STRICT） | 不含任何依赖 SQLite 新版本的文件特性；两版本行为一致 |
| WAL | `journal_mode=wal` 持久化在文件头 | Tauri 打开即 WAL，不需要显式设置（设置了也无害）；**迁移必须把 `-wal` 带上并折叠**（§2.2） |
| `user_version` | 0（旧端从未写） | 不要把它当 schema 版本；新端自己的迁移体系（若有）必须以「空库/已有 1.x schema」两种起点都能跑 |
| `schema_version` | 5 | SQLite 内部 cookie（DDL 计数），与业务无关；不要在代码里断言固定值 |
| `freelist_count` | 288 页（约 1.2 MB 空闲） | 无害；迁移阶段不 VACUUM（会重写文件、改变指纹） |
| `application_id` | 0 | 建议新端**继续留 0**（有用户回滚到 Electron 时，Electron 不认 application_id，改了也不影响，但没必要引入差异） |

### 8.2 运行时行为差异（需要在新端代码里对齐）

1. **`busy_timeout`**：better-sqlite3 默认有 busy timeout；rusqlite 默认 0。WAL + 单实例下冲突少，但建议 `conn.busy_timeout(Duration::from_secs(5))`，否则并发写瞬间会拿到 `SQLITE_BUSY`。
2. **`PRAGMA foreign_keys`**：旧库无外键，但旧端连接上看到 `foreign_keys=1`；新端保持一致即可（无实际影响）。
3. **`journal_mode` 设置时机**：旧端每次 open 都 `PRAGMA journal_mode=WAL`（`src/main/infra/db/index.ts:97`）；新端同样做一次并忽略返回值即可（文件头已持久化）。
4. **建表语句必须 `IF NOT EXISTS`**：旧端库里表已存在，任何无 `IF NOT EXISTS` 的 `CREATE TABLE` 都会 `table already exists` 直接失败（`tauri_sim` 已验证同款 DDL 幂等）。
5. **只读打开副作用**：见 §2.3（会留下 `-shm` + 0 字节 `-wal`）。
6. **回滚场景**：若用户迁到 Tauri 后又回退 Electron，旧库仍是迁移前状态（我们只读它、只复制），Electron 可以继续用；但 Tauri 期间的新写入不会回同步——`migration.json` 的源指纹可检测「旧库在迁移后又被 Electron 写过」，此时应提示用户而不是静默覆盖。
7. **双向/持续同步不在 SP-4 范围**：迁移是「一次性复制」，不做长期双写。

### 8.3 DDL 漂移（1.x 后续版本）

真实库与当前仓库代码 **0 差异**，说明这份数据来自 1.2.13 这一版、没有历史遗留列。但迁移实现仍需保留「逐列比对 + 差异报告」能力（`spikes/migrate/rs/src/lib.rs` 的 `compare_schema()` 即雏形）：

- 若未来 1.x 用 `ALTER TABLE` 加列而用户库是旧 schema → 迁移应报告「缺少列/多出列/类型不兼容」，由新端 schema 演进逻辑补齐，而不是假设固定 12 列。
- 若出现多出列（用户装过更新版本后回退）→ 不能直接丢弃；`CREATE TABLE IF NOT EXISTS` 不会报错，但读写代码要容忍多余列（`SELECT *` 映射到固定 struct 会失败，建议显式列名查询——现有代码已是显式列名）。

---

## 9. 可直接施工的 Rust 函数签名建议

基于 `spikes/migrate/rs` 已验证的实现，建议落在 `crates/hqsf-core/src/infra/db/migrate.rs`（或 `infra/migrate.rs`），由 Tauri 薄壳在创建窗口前调用（`app_data_dir()` 由壳传入，core 不依赖 tauri）：

```rust
use std::path::{Path, PathBuf};

/// 旧端目录名（Linux: $XDG_CONFIG_HOME/hqsf-client；Win/mac 见实现）
pub const LEGACY_DIR_NAME: &str = "hqsf-client";
pub const LEGACY_TEST_DIR_NAME: &str = "hqsf-test";
pub const DB_NAME: &str = "hqsf.db";
pub const SETTINGS_NAME: &str = "settings.json";
pub const SESSION_NAME: &str = "session.json";
pub const MARKER_NAME: &str = "migration.json";
pub const STAGING_DIR_NAME: &str = ".migrate-staging";

#[derive(Debug, Clone)]
pub struct LegacyPaths {
    pub user_data: PathBuf,   // 旧 userData 目录
    pub db: PathBuf,
    pub wal: PathBuf,
    pub settings: PathBuf,
    pub session: PathBuf,
}

/// 按平台推导旧端路径；测试模式用 *_TEST 名字
pub fn legacy_paths(test_mode: bool) -> Result<LegacyPaths, MigrateError>;

#[derive(Debug, Clone, Default)]
pub struct MigrateOptions {
    pub force: bool,     // 目标有 db 无 marker，或有 marker 但源指纹变化时，允许覆盖/重迁
    pub dry_run: bool,   // 只演练：复制/校验后删 staging，不落盘
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MigrationMarker { /* 字段同 §6.5 */ }

#[derive(Debug, Clone)]
pub struct MigrationOutcome {
    pub marker: MigrationMarker,
    pub already_migrated: bool,   // true = 幂等跳过
    pub target_db: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum MigrateError {
    #[error("旧数据目录不存在：{0}")] LegacyMissing(PathBuf),
    #[error("源库在迁移过程中被修改（旧版可能仍在运行）：{0}")] SourceBusy(PathBuf),
    #[error("源库损坏：{0}")] CorruptSource(String),
    #[error("目标目录已有 hqsf.db 但没有 {0}，拒绝覆盖（可加 force）")] TargetDirty(PathBuf),
    #[error("目标已有迁移标记但源指纹已变化：{0}")] SourceChanged(PathBuf),
    #[error(transparent)] Io(#[from] std::io::Error),
    #[error(transparent)] Db(#[from] rusqlite::Error),
    #[error(transparent)] Json(#[from] serde_json::Error),
}

/// 迁移主入口（幂等；具体步骤见 §6.2）
pub fn migrate_legacy_userdata(
    legacy: &LegacyPaths,
    target_dir: &Path,
    opts: MigrateOptions,
) -> Result<MigrationOutcome, MigrateError>;

/// Tauri 首启调用：旧库存在且未迁移才执行；返回值用于 UI 提示
pub fn ensure_legacy_migrated(
    app_data_dir: &Path,
    test_mode: bool,
) -> Result<MigrationOutcome, MigrateError>;

/// 迁移后正常开库（旧端同款行为）
pub fn open_db(db_path: &Path) -> Result<rusqlite::Connection, MigrateError> {
    let conn = rusqlite::Connection::open(db_path)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let _mode: String = conn.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get(0))?;
    conn.execute_batch(SCHEMA)?; // 全部 CREATE ... IF NOT EXISTS
    Ok(conn)
}
```

集成要点：

- **调用时机**：Tauri `setup` 里、单实例锁之后、创建主窗口/DB 连接之前；失败时**不要静默**（旧端就有 unhandled rejection 导致无窗口的坑），用 `dialog`/首屏错误页明确提示「迁移失败，旧数据未动，请关闭旧版后重试」。
- **路径**：DB 落 `app.path().app_data_dir()`（Linux `~/.local/share/com.huangqisf.client`），**不要**误用 `app_config_dir()`；测试模式手工拼 `-test` 后缀（identifier 编译期固定，见 §1.2 提醒）。
- **marker 原子写**：tmp 文件 + `rename`；先落 db 再落 marker，并提供 repair 分支（§6.7）。
- **图片缓存**：独立函数 `copy_image_cache(legacy_user_data, target_dir) -> io::Result<CacheStat>`，失败只记日志、不影响 DB 迁移结果。

---

## 10. 复现与产物

```bash
cd spikes/migrate/rs
export CARGO_HOME=$PWD/../.cargo-home && mkdir -p "$CARGO_HOME"
cargo build --release

cd ..   # spikes/migrate
rs/target/release/inspect data/client/hqsf.db --settings data/client/settings.json --label client --max-text 200
rs/target/release/inspect data/test/hqsf.db   --label test --max-text 80
rs/target/release/migrate --from data/client --to work/target-client          # 首次
rs/target/release/migrate --from data/client --to work/target-client          # 幂等
cp work/target-client/hqsf.db /tmp/sim.db && rs/target/release/tauri_sim /tmp/sim.db
```

日志（`spikes/migrate/work/logs/`）：

| 文件 | 内容 |
| --- | --- |
| `source-listing.txt` | 两个源目录的完整清单（含软链/缓存）、进程检查 |
| `inspect-client.txt` | 正式库全量体检：指纹、PRAGMA、DDL、行数、样例、逐列比对、settings |
| `inspect-test.txt` | 测试库体检 |
| `inspect-client-nowal.txt` | **WAL 反例**：只复制 db → read_cache 6 行 |
| `migrate-run1.txt` | 首次迁移完整 9 步 |
| `migrate-run2-idempotent.txt` | 幂等跳过 |
| `migrate-failure-tests.txt` | 失败路径 A–F（损坏源 / 目标无标记 / 源变化 / dry-run / `--force` 覆盖）+ G（`--force` 重迁复测）|
| `tauri-sim.txt` | Tauri 首次启动模拟（同款 DDL + 读写旧库） |
| `final-check.txt` | 修复 `--force` 后的完整回归（首次 + 幂等 + 源哈希复核） |
| `inspect-target-client.txt` | 迁移产物复检 |

> `data/`、`work/` 是真实用户数据副本，已被 `spikes/migrate/.gitignore` 忽略，**不入库**；spike 结束后可整体删除。源目录 `~/.config/hqsf-client/` 全程只读，迁移前后 sha256 一致（脚本第 9 步复核 + 本文 §2.1 独立复核）。

---

## 11. SP-4 结论

**可以直接读取**，无阻断项。施工时必须做到两件事：

1. **迁移复制 `hqsf.db` 时把 `hqsf.db-wal` 一起带上，并在副本上 checkpoint 折叠后再落位**（否则静默丢 12/18 条缓存、且 `integrity_check` 不会报错）。
2. **token 不迁移、强制重新登录**（真实数据无 `session.json`，首次启动即未登录；若存在旧文件只提示不删除）。

其余为施工细节：建表语句一律 `CREATE ... IF NOT EXISTS`、rusqlite 用 bundled（工作区已锁 0.43）、建议 `busy_timeout` + 单实例、DB 落 `app_data_dir()` 而非 `app_config_dir()`、图片缓存可选复制、迁移标记用原子写并保留 repair 分支。

`SP-4 结论：可直接读取（需处理 WAL 随行复制 + token 重新登录后可用；无阻断项）`
