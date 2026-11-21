# src-tauri/resources —— 打包资源（`bundle.resources` 的源）

对应 1.x `electron-builder.yml` 的 `extraResources`（三项一一对应，打包后落在 Tauri 的
`resource_dir()/` 下，内核用 `AppPaths::resource_dir` 去读）：

| 1.x 源文件 | 本目录文件名 | 打包后路径 | 用途 |
| --- | --- | --- | --- |
| `api.config.json`（本地持有，不入库） | `api.config.json` | `api.config.json` | 荒启 API 地址与 39 个接口路径，`services::net::api_config()` 每次调用现读 |
| `doc/用户协议.md` | `agreement.md` | `agreement.md` | `hqsf:get-agreement` 返回的正文 |
| `doc/CHANGELOG.md` | `changelog.md` | `changelog.md` | `hqsf:get-changelog` 返回的正文 |

这三个文件**不直接入库**（见 `../.gitignore`），构建前用脚本生成：

```bash
node src-tauri/scripts/prepare-resources.mjs          # 拷贝
node src-tauri/scripts/prepare-resources.mjs --check  # 只检查（CI 用）
```

与 Electron 的差异：electron-builder 在打包时直接 `from → to` 拷贝，源文件可以不在项目内；
Tauri 的 `bundle.resources` 在**编译期**就要能读到源文件（`tauri-build` 会校验），所以需要先落盘到
本目录 —— 这是「构建前置步骤」而不是「打包配置」，容易漏，故写在这里。
