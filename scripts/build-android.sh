#!/usr/bin/env bash
# Android 构建入口（本机/CI 通用）。
#
# 依赖（均放在仓库内，避免污染只读 home）：
#   .android-sdk  command-line tools + platform-tools + platforms;android-37.0
#                 + build-tools;37.0.0 + ndk;27.0.12077973
#   .jdk          完整 JDK 21（javac；系统 JRE 不够）
#   .cargo-home   CARGO_HOME，已装 Android targets 与 tauri-cli
#
# 用法：
#   scripts/build-android.sh            # debug APK（默认，迭代用）
#   scripts/build-android.sh --release  # release APK（默认签名由 Gradle 决定）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export CARGO_HOME="$ROOT/.cargo-home"
export ANDROID_HOME="$ROOT/.android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export NDK_HOME="$ANDROID_HOME/ndk/27.0.12077973"
export JAVA_HOME="$ROOT/.jdk"
export PATH="$CARGO_HOME/bin:$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

if [[ ! -x "$JAVA_HOME/bin/javac" ]]; then
  echo "[build-android] 缺 $JAVA_HOME/bin/javac（需要完整 JDK 21）" >&2
  exit 1
fi
if [[ ! -d "$NDK_HOME" ]]; then
  echo "[build-android] 缺 NDK：$NDK_HOME" >&2
  exit 1
fi

# Tauri Android 的模板补丁（返回键/IME inset/应用名/Gradle 镜像）
node "$ROOT/scripts/patch-android-gen.mjs"

# Rust 交叉编译环境
SYSROOT="$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/sysroot"
export LIBCLANG_PATH="$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/musl/lib"
export BINDGEN_EXTRA_CLANG_ARGS="--sysroot=$SYSROOT -resource-dir=$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/lib/clang/18 -I$SYSROOT/usr/include -I$SYSROOT/usr/include/aarch64-linux-android"
export CC_aarch64_linux_android="$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang"
export AR_aarch64_linux_android="$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CC_aarch64_linux_android"

# 渲染层先构建到 out/web（Tauri frontendDist）
node_modules/.bin/vite build --config vite.web.config.ts

MODE=debug
for arg in "$@"; do
  case "$arg" in
    --release) MODE=release ;;
    --debug) MODE=debug ;;
    *) echo "[build-android] 未知参数：$arg" >&2; exit 2 ;;
  esac
done

FLAG=()
[[ "$MODE" == "debug" ]] && FLAG=(--debug)
cargo tauri android build --apk --target aarch64 "${FLAG[@]}"

D="src-tauri/gen/android/app/build/outputs/apk/universal/$MODE"
APK="$D/app-universal-$MODE.apk"
if [[ "$MODE" == "release" && -f "$ROOT/.android-keystore/hqsf-release.jks" ]]; then
  BT="$ANDROID_HOME/build-tools/37.0.0"
  KS="$ROOT/.android-keystore/hqsf-release.jks"
  PW_FILE="$ROOT/.android-keystore/password.txt"
  if [[ ! -f "$PW_FILE" ]]; then
    echo "[build-android] 缺 $PW_FILE，无法签名 release APK" >&2
    exit 1
  fi
  PW="$(cat "$PW_FILE")"
  "$BT/zipalign" -p -f 4 "$D/app-universal-release-unsigned.apk" "$D/app-universal-release-aligned.apk"
  "$BT/apksigner" sign --ks "$KS" --ks-key-alias hqsf --ks-pass "pass:$PW" --key-pass "pass:$PW"     --out "$APK" "$D/app-universal-release-aligned.apk"
fi
echo "[build-android] APK: $ROOT/$APK"