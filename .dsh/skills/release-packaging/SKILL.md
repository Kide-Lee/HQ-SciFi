---
name: release-packaging
description: 构建/打包/发布 黄芪饮片（hq-scifi，Tauri 2 + Rust）。本机没有 WebKitGTK 与 macOS/Windows 工具链，所有安装包都在 GitHub Actions 上构建，结论通过 ci-status / release-status / ci-logs / release-logs / smoke-logs 分支回读。当用户要求「打个包」「发个版本」「出包验证」「看 CI/打包结果」「换个版本号重新发」时使用。
---

# 打包与发版（Tauri）

## 先记住三件事

1. **本机不出包**。没有 `pkg-config`/WebKitGTK、没有 macOS SDK、没有 Windows MSVC，`src-tauri` 本机连 `cargo check` 都过不了。一切安装包由 `.github/workflows/release.yml` 在 GitHub runner 上产出。
2. **产物不进仓库**。`dist/` 在 `.gitignore` 里（历史上误提交过 8 GB 的 1.x 安装包）。分发渠道是 Actions artifact（保留 14 天）或 GitHub Release 资产。
3. **日志读不到**。Actions 日志接口要 admin，`raw.githubusercontent.com` 在本机不可达，匿名 API 只有 60 次/小时。所以工作流把结论**回写到 git 分支**，本机用 `git fetch` 读。

## 三条触发路径

| 目的 | 触发方式 | 结果 |
|---|---|---|
| 只验证能打包 | 推 `build-only` 分支：`git push --force origin HEAD:build-only` | 四平台构建 + artifact 上传，**不建 Release、不打 tag** |
| 正式发版 | 打 tag 并推送：`git tag -a v2.0.14 -m "…" && git push origin v2.0.14` | 构建 + 产物自检 + 创建 **draft** Release |
| 换版本重打 | 删远端 tag → 本地删 → 在新 commit 上重建 → 推 | 同上；`gh release create` 发现 draft 已存在时改为 `upload --clobber` |

推送本身要走 `bash .dsh/skills/push-remote/scripts/push.sh origin main`（或导出 `GIT_SSH_COMMAND=ssh -F .git/hqsf-ssh-config …`），系统 ssh 配置链在沙箱里是坏的。

## 读结论（不要等、不要猜）

```bash
bash .dsh/skills/release-packaging/scripts/read-status.sh
```

它做的是：用最小 ssh 配置 `git fetch --force` 四个分支，然后打印

- `ci-status`：`ci: core=… tsc=… shell=… smoke=…`（commit message 里带 sha7）
- `release-status`：`build=` / `release=` / 产物大小 / 产物自检
- `release-logs`：release job 的完整日志（含 `gh` 的真实报错、dist 清单、上传的 5 个安装包）
- `ci-logs`：壳层 `cargo check` 失败时的编译错误尾部
- `smoke-logs`：CI 里的 Xvfb 启动冒烟（窗口出现 / 进程存活 / 库文件 / 截图颜色数）

某一次跑的 commit 是否已出结果：`git ls-remote origin ci-status release-status` 拿到分支 sha 不算数，**看分支 README 里的 `- commit: <sha>` 字段**。

## 产物与自检

`src-tauri/scripts/verify-bundles.mjs`（CI 里在构建后、上传前跑）：

- deb：`Version` 前缀对版本、`Depends` 含 `webkit2gtk` 且不含 `webkit2gtk-4.0`、内含 `api.config.json`/`agreement.md`/`changelog.md` 与 `/bin/huangqi-scifi`
- dmg：挂载后 `CFBundleIdentifier == com.huangqisf.client`、版本一致、三份资源在
- NSIS：`ProductVersion` 前缀一致

AppImage 另有 `scripts/smoke-tauri.sh`（Xvfb + `dbus-run-session`）：等窗口、查进程、查 `hqsf.db`、ImageMagick 截图数颜色（`unique_colors` 应 ~900，<20 视作白屏）。

## 对外发布：先把真实 `api.config.json` 配成 secret

仓库是公开的，`api.config.json` 不入库；CI 里三档兜底（secret → 工作区文件 → 示例），**没有 secret 时打出来的包连的是示例地址**。

1. 生成本地 base64（值里不要带换行）：

   ```bash
   base64 -w0 api.config.json          # 4,696 字节左右
   ```

2. GitHub → 仓库 **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `HQSF_API_CONFIG_B64`
   - Secret: 上面那串 base64

   （这一步必须由仓库管理员在网页上做：Actions secrets 创建接口需要 admin token，本机没有 `gh`，也没有 libsodium 来封箱。）

3. 确认已生效：重打一版后读 `release-status` 的 **「打包时使用的 API 配置」** 段——应显示
   `来源: secret HQSF_API_CONFIG_B64` 与 `baseUrl: https://api.huangqisf.com/`。
   如果还是 `示例 api.config.example.json（⚠️ 未配置 secret）`，说明 secret 没配上或名字拼错。

4. 顺带说明：运行期 `data_dir/api.config.json` 优先于包内配置，所以临时验证不必重打包。

## 已知坑（都踩过）

1. **`bundle.resources` 是编译期校验的**：`src-tauri/resources/{api.config.json,agreement.md,changelog.md}` 是 `src-tauri/scripts/prepare-resources.mjs` 的生成物且 gitignore，CI 必须先跑它，否则 `cargo build` 直接报 `resource path … doesn't exist`。
2. **`command_generated.rs` 也是生成物**：CI 先 `node src-tauri/scripts/gen-tauri-commands.mjs --write`，再 `--verify` 做契约静态校验。
3. **`gh` 命令必须显式 `--repo "$GITHUB_REPOSITORY"`**：release job 没有 `checkout`，否则 `gh release create` 报 `fatal: not a git repository`。
4. **`find … | head` 会打死脚本**：GH Actions 的 `shell: bash` 默认 `-e`，`head` 提前关管道 → SIGPIPE → 141 → 脚本退出（日志只剩前半段）。要么 `|| true`，要么别用 head。
5. **只上传安装包**：`dist/` 里含 AppImage 的 `.AppDir/` 整树与 dmg 的 `create-dmg` 辅助文件（实测 422 个文件 / 470 MB），全传会撞 GitHub Release 的 1000 资产上限。按 `*.deb|*.AppImage|*.rpm|*.dmg|*-setup.exe|*.msi` 过滤（目前 5 个：deb / AppImage / setup.exe / 两个 dmg）。
6. **`macos-13`（Intel）排不到队**：macOS 只在 `macos-latest`(arm64) 上跑，x64 dmg 用 `--target x86_64-apple-darwin` 交叉出来。
7. **api.config.json 三档**：CI 依次取 secret `HQSF_API_CONFIG_B64` → 工作区 `api.config.json` → `api.config.example.json`（兜底，会在 step summary 里告警）。**没有 secret 时打出来的包连的是示例地址**，正式对外发布前必须配 secret（`base64 -w0 api.config.json`）。
8. **运行期配置优先级**：`data_dir/api.config.json` > `resource_dir/api.config.json`（内核 `services/net.rs::api_config_candidates`），所以临时验证可以把真实配置丢进数据目录，不用重新打包。
9. **重打 tag 要 force 覆盖远端**：`git push origin :refs/tags/v2.0.14 && git tag -d v2.0.14 && git tag -a v2.0.14 … && git push origin v2.0.14`；draft Release 已存在时 job 会自动改走 `upload --clobber`。
10. **draft 里会残留上一轮的垃圾资产**：第一版用 `softprops/action-gh-release` 时，它把 `dist/` 里 422 个文件逐个上传，中途失败 → draft 里留下几百个无用资产（实测 273 个）。现在 `release` job 在新建前会先 `gh release delete --yes` 掉**旧的 draft**（已是正式发布版则只 `upload --clobber`，不删除），并在日志里打印最终 `Release 资产数`，应等于 5。
11. **版本号三处**：`Cargo.toml`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`（`package.json` 2.0 起也是发布版本号，1.x 时代是 1.2.13）。

## Release job 的两个必备动作（否则静默失败）

1. **先 `actions/checkout@v4`**：release job 与 build job 不共享工作区，没有 checkout 就读不到 `doc/CHANGELOG.md`，正文会退回链接（python 抛 `FileNotFoundError`，日志里只有那一行）。
2. **先 `mkdir -p "$RUNNER_TEMP/meta"`**：`meta/` 是 build job 里的 api.config 步建的，release job 里不存在；`cp` 到它会在 `set -e` 下直接打死脚本（日志会停在「上传 N 个安装包」之后，看不到任何报错）。

## Release 正文与标题（别用占位）

- **标题 = tag 名**（`v2.0.14`），与历史版本一致；不要写「黄芪饮片 v…」这类别名，页面列表里会与其他版本不同形。
- **正文自动从 `doc/CHANGELOG.md` 抽本版本那一节**（`release` job 里的 python 片段，按 `## v<version>` 切到下一个 `## v`），所以**发版前必须先把这个版本的 CHANGELOG 写好**（去掉「未发布」、写清用户可见变化、安装包用实测体积）。
- 抽出来的正文同时随 `meta-*` 上传，`release-status` 里能看到。

## 已知坑（都踩过）

```bash
export CARGO_HOME=$PWD/.cargo-home
cargo test -q -p hqsf-core --lib
cargo clippy -q --all-targets -- -D warnings
cargo fmt --all -- --check
cargo run -q -p hqsf-bindings -- --check
node src-tauri/scripts/gen-tauri-commands.mjs --verify
node src-tauri/scripts/prepare-resources.mjs --check
node_modules/.bin/tsc -p tsconfig.web.json
node_modules/.bin/vite build --config vite.web.config.json
```

本机无 npm；需要 npm 时用 `COREPACK_HOME=$PWD/.corepack corepack npm …`。

## 产物怎么拿给用户

- 临时验证：`release` → artifact `bundle-{linux,windows,macos-arm64,macos-x64}`（14 天）。
- 正式：draft Release（`https://github.com/Kide-Lee/HQ-SciFi/releases`，tag `v<version>`）——**draft 只有登录的仓库成员看得到**，匿名 API 查不到，别用 `GET /releases` 判定失败。