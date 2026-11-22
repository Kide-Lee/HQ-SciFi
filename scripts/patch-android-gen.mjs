#!/usr/bin/env node
/**
 * `tauri android init` 生成的 src-tauri/gen/android 被 src-tauri/.gitignore 忽略，
 * 但 Android 端有几处必须改模板才能工作的补丁。每次 init 后执行本脚本（幂等）：
 *   node scripts/patch-android-gen.mjs
 *
 * 维护点：
 * 1. MainActivity：系统返回走 WebView history、debug 包开 WebView 检查、IME/系统栏 inset 处理
 *    （Android 15 edge-to-edge 下 WebView 不会因输入法缩小）。
 * 2. AndroidManifest：windowSoftInputMode=adjustResize。
 * 3. strings.xml：应用名「黄芪饮片」。
 * 4. gradle-wrapper：Gradle 发行包走腾讯镜像（services.gradle.org 在本网络不可达）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const gen = join(repoRoot, 'src-tauri/gen/android')
const app = join(gen, 'app')

if (!existsSync(gen)) {
  console.error('[patch-android-gen] 未找到 src-tauri/gen/android，先跑 cargo tauri android init')
  process.exit(1)
}

function patch(path, transform) {
  const before = readFileSync(path, 'utf8')
  const after = transform(before)
  if (after !== before) {
    writeFileSync(path, after)
    console.log(`[patch-android-gen] 已更新 ${path}`)
  }
}

const mainActivity = join(app, 'src/main/java/com/huangqisf/client/MainActivity.kt')
patch(mainActivity, (source) => {
  if (source.includes('setOnApplyWindowInsetsListener')) return source
  return `package com.huangqisf.client

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  // WebView 的 canGoBack() 不把 history.pushState 算进原生栈，Wry 自带返回拦截在手机上
  // 会把「从列表/文章返回」直接当成退出。这里改为问渲染层：有层级就 history.back()，
  // 根页面才 finish()。
  override val handleBackNavigation: Boolean = false

  @Suppress("DEPRECATION")
  override fun onBackPressed() {
    val webView = findWebView(findViewById(android.R.id.content))
    if (webView == null) {
      super.onBackPressed()
      return
    }
    webView.evaluateJavascript("(window.__hqsfBack && window.__hqsfBack()) === true") { result ->
      if (result != "true") finish()
    }
  }

  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) {
        val found = findWebView(view.getChildAt(index))
        if (found != null) return found
      }
    }
    return null
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // 仅 debug 包开 WebView 检查；release 包不能对任意调试器开放。
    if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Android 15 强制 edge-to-edge 后 WebView 不会因输入法弹出而缩小；手动把系统栏/IME
    // inset 转成内容区 padding，等价 adjustResize，并让页面避开状态栏与手势条。
    val root = findViewById<ViewGroup>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(0, bars.top, 0, maxOf(bars.bottom, ime.bottom))
      insets
    }
    ViewCompat.requestApplyInsets(root)
  }
}
`
})

const manifest = join(app, 'src/main/AndroidManifest.xml')
patch(manifest, (source) =>
  source.includes('windowSoftInputMode')
    ? source
    : source.replace('android:exported="true"', 'android:exported="true"\n            android:windowSoftInputMode="adjustResize"'),
)

const strings = join(app, 'src/main/res/values/strings.xml')
patch(strings, (source) =>
  source
    .replace(/(<string name="app_name">)[^<]*(<\/string>)/, '$1黄芪饮片$2')
    .replace(/(<string name="main_activity_title">)[^<]*(<\/string>)/, '$1黄芪饮片$2'),
)

const wrapper = join(gen, 'gradle/wrapper/gradle-wrapper.properties')
if (existsSync(wrapper)) {
  patch(wrapper, (source) =>
    source.replace(
      /distributionUrl=https?:\\?\/\\?\/services\\.gradle\\.org\\?\/distributions\\?\/gradle-([\\d.]+)-bin\\.zip/,
      'distributionUrl=https\\://mirrors.cloud.tencent.com/gradle/gradle-$1-bin.zip',
    ),
  )
}

console.log('[patch-android-gen] 完成')