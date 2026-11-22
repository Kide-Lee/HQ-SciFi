# 启动冒烟

- commit: 5e22930324e99bc5b89f91e22481fb46499f65b8
- outcome: success
- run: https://github.com/Kide-Lee/HQ-SciFi/actions/runs/45027219107

```
app_pid=4127
window_found=1
window_id=2097155
app_alive=1
db_count=1
--- 本地库 ---
/home/runner/work/_temp/apphome/.local/share/hqsf-test/hqsf.db-shm
/home/runner/work/_temp/apphome/.local/share/hqsf-test/hqsf.db
/home/runner/work/_temp/apphome/.local/share/hqsf-test/hqsf.db-wal
screenshot_ok=1 unique_colors=916
--- 截图尺寸 ---
/home/runner/work/_temp/apphome/shot.png PNG 1200x800 1200x800+0+0 8-bit sRGB 30612B 0.000u 0:00.000
--- app.log（尾部）---

(huangqi-scifi:4127): dbind-WARNING **: 13:25:11.142: AT-SPI: Error retrieving accessibility bus address: org.freedesktop.DBus.Error.ServiceUnknown: The name org.a11y.Bus was not provided by any .service files
[hqsf] 启动会话校验：读取本地会话失败，跳过：系统钥匙串不可用（读取凭据 hqsf.session 失败）：Platform secure storage failure: DBus error: The name org.freedesktop.secrets was not provided by any .service files。请确认系统凭据服务已启用后再试。
冒烟通过
```
