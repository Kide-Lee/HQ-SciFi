# 端到端（tauri-driver）

- commit: 5e22930324e99bc5b89f91e22481fb46499f65b8
- outcome: success
- run: https://github.com/Kide-Lee/HQ-SciFi/actions/runs/45027219107

```
--- 页面诊断 ---
{
  "readyState": "complete",
  "title": "黄芪饮片",
  "head": "<html lang=\"zh-CN\" data-hqsf-drag=\"1\" data-theme=\"light\" style=\"--font: system-ui, -apple-system, &quot;PingFang SC&quot;, &quot;Microsoft YaHei&quot;, &quot;Noto Sans CJK SC&quot;, sans-serif; --font-content: system-ui, -apple-system, &quot;PingFang SC&quot;, &quot;Microsoft YaHei&quot;, &quot;Noto Sans CJK SC&quot;, sans-serif; --font-code: ui-monospace, &quot;Cascadia Code&quot;, Consolas, monospace; --font-size: 14px; --accent: #4a6cf7; --accent-soft: color-mix(in srgb, #4a6cf7 12%, white);\"><head>\n    <meta charset=\"UTF-8\">\n    <title>黄芪饮片</title>\n    <meta name=\"viewport\" content=\"width=",
  "rootChildren": 0,
  "htmlLen": 1692,
  "href": "tauri://localhost",
  "bodyText": "",
  "scripts": [
    "tauri://localhost/assets/index-pLzX77an.js"
  ]
}
ok   页面加载完成（#root 有内容）
ok   首启协议门可走完（首次运行需要先同意用户协议）
ok   窗口标题为「黄芪饮片」
ok   Tauri IPC 通道存在
ok   桥接层 window.hqsf 就绪（85 方法 + windowControls）
ok   未登录时显示登录覆盖层
FAIL 空地方右键出应用内菜单（刷新 / 开发者工具）: 等待超时：右键前主界面仍在（最后取值：false）
WARN 右键菜单软断言未通过（不阻塞 CI）：等待超时：右键前主界面仍在（最后取值：false）
ok   渲染层日志通道（__hqsf_log）可调用
WARN 截图失败（不影响断言结论）：fetch failed
e2e 通过（7 项）
--- renderer.log ---
path=/home/runner/work/_temp/e2ehome/.local/share/hqsf-test/logs/renderer.log bytes=535
[1795353880055] warn IPC custom protocol failed, Tauri will now use the postMessage interface instead {}
[1795353880055] warn IPC custom protocol failed, Tauri will now use the postMessage interface instead {}
[1795353880055] warn IPC custom protocol failed, Tauri will now use the postMessage interface instead {}
[1795353880055] warn IPC custom protocol failed, Tauri will now use the postMessage interface instead {}
[1795353880936] warn [bridge] 事件监听失败：hqsf:window-maximized-changed {}
[1795353911143] info e2e-probe
--- driver.log（尾部）---

(hq-scifi:3964): dbind-WARNING **: 13:24:39.729: AT-SPI: Error retrieving accessibility bus address: org.freedesktop.DBus.Error.ServiceUnknown: The name org.a11y.Bus was not provided by any .service files

** (hq-scifi:3964): WARNING **: 13:24:39.820: WEBKIT_FORCE_SANDBOX no longer allows disabling the sandbox. Use WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 instead.
[hqsf] 启动会话校验：读取本地会话失败，跳过：系统钥匙串不可用（读取凭据 hqsf.session 失败）：Platform secure storage failure: DBus error: The name org.freedesktop.secrets was not provided by any .service files。请确认系统凭据服务已启用后再试。
Error serving connection: hyper::Error(IncompleteMessage)
```
