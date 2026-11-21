# 三平台打包

- commit: b0782a3b91522be1a5805b9f915775694edb8f0a
- ref: refs/tags/v2.0.14
- build: success
- release: success
- run: https://github.com/Kide-Lee/HQ-SciFi/actions/runs/44915315627

## 打包时使用的 API 配置

### meta-linux
```
来源: secret HQSF_API_CONFIG_B64
baseUrl: https://api.huangqisf.com/
endpoints: 41
```
### meta-macos-arm64
```
来源: secret HQSF_API_CONFIG_B64
baseUrl: https://api.huangqisf.com/
endpoints: 41
```
### meta-macos-x64
```
来源: secret HQSF_API_CONFIG_B64
baseUrl: https://api.huangqisf.com/
endpoints: 41
```
### meta-windows
```
来源: secret HQSF_API_CONFIG_B64
baseUrl: https://api.huangqisf.com/
endpoints: 41
```

## 产物大小

### meta-linux
```
87M	src-tauri/target/release/bundle/appimage/hq-scifi_2.0.14_amd64.AppImage
14M	src-tauri/target/release/bundle/deb/hq-scifi_2.0.14_amd64.deb
```
### meta-macos-arm64
```
 11M	src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/hq-scifi_2.0.14_aarch64.dmg
```
### meta-macos-x64
```
 12M	src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/hq-scifi_2.0.14_x64.dmg
```
### meta-windows
```
7.5M	src-tauri/target/release/bundle/nsis/hq-scifi_2.0.14_x64-setup.exe
```

## 产物自检

### meta-linux
```
  tauri.conf.json: version=2.0.14 identifier=com.huangqisf.client productName=hq-scifi binary=huangqi-scifi
  deb: src-tauri/target/release/bundle/deb/hq-scifi_2.0.14_amd64.deb 13.1MB
  deb Depends: libwebkit2gtk-4.1-0, libgtk-3-0
  deb 内含打包资源：api.config.json / agreement.md / changelog.md
  AppImage: src-tauri/target/release/bundle/appimage/hq-scifi_2.0.14_amd64.AppImage 86.8MB

产物自检通过
```
### meta-macos-arm64
```
  tauri.conf.json: version=2.0.14 identifier=com.huangqisf.client productName=hq-scifi binary=huangqi-scifi
  dmg: src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/hq-scifi_2.0.14_aarch64.dmg 11.2MB
  dmg app: hq-scifi.app id=com.huangqisf.client version=2.0.14
  dmg 内 .app 含打包资源：api.config.json / agreement.md / changelog.md

产物自检通过
```
### meta-macos-x64
```
  tauri.conf.json: version=2.0.14 identifier=com.huangqisf.client productName=hq-scifi binary=huangqi-scifi
  dmg: src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/hq-scifi_2.0.14_x64.dmg 11.6MB
  dmg app: hq-scifi.app id=com.huangqisf.client version=2.0.14
  dmg 内 .app 含打包资源：api.config.json / agreement.md / changelog.md

产物自检通过
```
### meta-windows
```
  tauri.conf.json: version=2.0.14 identifier=com.huangqisf.client productName=hq-scifi binary=huangqi-scifi
  nsis: D:\a\HQ-SciFi\HQ-SciFi\src-tauri\target\release\bundle\nsis\hq-scifi_2.0.14_x64-setup.exe 7.5MB
  nsis ProductVersion: 2.0.14

产物自检通过
```
