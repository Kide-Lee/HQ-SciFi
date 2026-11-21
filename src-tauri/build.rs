// 迁移来源：1.x 无对应文件（electron-vite 用 `electron.vite.config.ts` 完成构建）。
// 与 Electron 的差异：tauri-build 在编译期生成 capabilities 的 JSON schema（`gen/schemas/`）
// 并把 `tauri.conf.json` + 平台覆盖配置内嵌成 context；没有 webpack/vite 参与 Rust 构建。
//
// 注意：本机没有 pkg-config / WebKitGTK，`cargo check` 会在 glib-sys 等 build script 处失败，
// 本文件不需要也无法在本地验证（属预期）。CI/开发机装好 tauri 依赖后直接 `cargo build` 即可。

fn main() {
    tauri_build::build()
}