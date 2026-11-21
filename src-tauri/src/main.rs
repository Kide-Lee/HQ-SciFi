// 二进制入口：只做「调用壳层 run() + 错误落盘」。
//
// 迁移来源：`src/main/index.ts`（Electron 主进程入口）。1.x 入口里塞了测试模式路径、
// 单实例锁与 `initApp()`；v2 这些全部下移到 `lib.rs::run()`，因为 Tauri 的 App 只能构建一次，
// 入口保持极薄（也是 `cargo tauri` 模板的约定）。
//
// 与 Electron 的差异：
//   - Windows 发布包不弹控制台：`windows_subsystem = "windows"`（仅 release；debug 保留控制台，
//     否则 `eprintln!` 的启动诊断完全看不到）。
//   - 启动失败：1.x 里未捕获的 rejection 会让进程「活着但没窗口」（见 AGENTS.md 的待办）；
//     这里把错误打到 stderr 并以退出码 1 结束（GUI 场景下 stderr 可能不可见，但 CI / 终端可见；
//     `lib.rs` 的 setup 里还会先弹一次原生错误框）。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = hq_scifi_lib::run() {
        // 不能用 `unwrap`/`expect`：走统一的错误输出 + 非零退出码。
        eprintln!("[hqsf] 应用启动失败：{error:#}");
        std::process::exit(1);
    }
}
