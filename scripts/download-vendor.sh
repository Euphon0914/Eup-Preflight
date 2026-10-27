#!/usr/bin/env bash
# ------------------------------------------------------------
# 下载第三方库到 vendor/ 目录（固定版本号，不用 latest）
# 用法：bash scripts/download-vendor.sh            默认走 jsdelivr
#       CDN=unpkg bash scripts/download-vendor.sh   改走 unpkg
#       CDN=npmmirror bash scripts/download-vendor.sh 走淘宝 npmmirror（国内最快）
# ------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

# ===== 固定版本号 =====
MEDIAINFO_VER="0.3.8"        # mediainfo.js
FFMPEG_VER="0.12.15"         # @ffmpeg/ffmpeg（JS 封装层）
CORE_VER="0.12.10"           # @ffmpeg/core（单线程 wasm）
CORE_MT_VER="0.12.10"        # @ffmpeg/core-mt（多线程 wasm，可选）
MEDIABUNNY_VER="1.61.3"      # mediabunny（WebCodecs 测速页用的解封装 / 封装库）
TESSERACT_VER="7.0.0"        # tesseract.js（画面遮挡检查：文字识别）
TESS_CORE_VER="7.0.0"        # tesseract.js-core（文字识别 wasm，只用 LSTM 版）
TESS_DATA_VER="1.0.0"        # @tesseract.js-data/chi_sim、eng（语言数据，用 4.0.0_best_int）

CDN="${CDN:-jsdelivr}"

# 注意：如果改了上面的版本号，下面 get 调用里 wasm 的“期望字节数”也要一起改（或删掉该参数跳过校验）

# 根据 CDN 拼出某个包内文件的地址：url <包名> <版本> <包内路径>
url() {
  local pkg="$1" ver="$2" path="$3"
  case "$CDN" in
    jsdelivr)  echo "https://cdn.jsdelivr.net/npm/${pkg}@${ver}/${path}" ;;
    unpkg)     echo "https://unpkg.com/${pkg}@${ver}/${path}" ;;
    npmmirror) echo "https://registry.npmmirror.com/${pkg}/${ver}/files/${path}" ;;
    *) echo "未知 CDN: $CDN" >&2; exit 1 ;;
  esac
}

# 取文件字节数（兼容 macOS / Linux）
fsize() { stat -f %z "$1" 2>/dev/null || stat -c %s "$1"; }

# 下载单个文件：get <包名> <版本> <包内路径> <本地路径> [期望字节数]
# 大文件容易在网络不稳时被截断，所以 wasm 文件会校验大小，不对就重下（最多 3 次）
get() {
  local src; src="$(url "$1" "$2" "$3")"
  local dst="$4" expect="${5:-}"
  mkdir -p "$(dirname "$dst")"
  if [ -s "$dst" ] && { [ -z "$expect" ] || [ "$(fsize "$dst")" = "$expect" ]; }; then
    echo "已存在，跳过: $dst"; return
  fi
  for i in 1 2 3; do
    echo "下载($i): $src"
    curl -fL --retry 3 -o "$dst" "$src" || true
    if [ -s "$dst" ] && { [ -z "$expect" ] || [ "$(fsize "$dst")" = "$expect" ]; }; then return; fi
    echo "  ⚠️ 文件不完整（$(fsize "$dst" 2>/dev/null || echo 0) / ${expect:-?} 字节），重试…"
  done
  echo "❌ 下载失败: $dst ，可换个 CDN 再试，例如：CDN=npmmirror bash scripts/download-vendor.sh" >&2
  exit 1
}

# mediainfo.js：ESM 打包版 + wasm
get mediainfo.js "$MEDIAINFO_VER" dist/esm-bundle/index.min.js vendor/mediainfo/index.min.js
get mediainfo.js "$MEDIAINFO_VER" dist/MediaInfoModule.wasm   vendor/mediainfo/MediaInfoModule.wasm 2599419

# @ffmpeg/ffmpeg：ESM 版（会在同源下创建 module worker）
for f in index.js classes.js const.js errors.js types.js utils.js worker.js empty.mjs; do
  get @ffmpeg/ffmpeg "$FFMPEG_VER" "dist/esm/$f" "vendor/ffmpeg/$f"
done

# @ffmpeg/core：单线程核心（约 32MB）
get @ffmpeg/core "$CORE_VER" dist/esm/ffmpeg-core.js   vendor/ffmpeg-core/ffmpeg-core.js
get @ffmpeg/core "$CORE_VER" dist/esm/ffmpeg-core.wasm vendor/ffmpeg-core/ffmpeg-core.wasm 32232419

# mediabunny：WebCodecs 测速页（webcodecs-test.html）用
get mediabunny "$MEDIABUNNY_VER" dist/bundles/mediabunny.min.mjs vendor/mediabunny/mediabunny.min.mjs 691220

# @ffmpeg/core-mt：多线程核心（可选，约 32MB；需要 COOP/COEP 响应头）
if [ "${SKIP_MT:-0}" != "1" ]; then
  get @ffmpeg/core-mt "$CORE_MT_VER" dist/esm/ffmpeg-core.js        vendor/ffmpeg-core-mt/ffmpeg-core.js
  get @ffmpeg/core-mt "$CORE_MT_VER" dist/esm/ffmpeg-core.wasm      vendor/ffmpeg-core-mt/ffmpeg-core.wasm 32718323
  get @ffmpeg/core-mt "$CORE_MT_VER" dist/esm/ffmpeg-core.worker.js vendor/ffmpeg-core-mt/ffmpeg-core.worker.js
fi

# ===== 画面遮挡检查 / 封面适配用（文字识别） =====
# tesseract.js：ESM 主文件 + worker
get tesseract.js "$TESSERACT_VER" dist/tesseract.esm.min.js vendor/tesseract/tesseract.esm.min.js 63220
get tesseract.js "$TESSERACT_VER" dist/worker.min.js        vendor/tesseract/worker.min.js 111307
# tesseract.js-core：只要 LSTM 版的三种（普通 / simd / relaxedsimd，浏览器自动选）
get tesseract.js-core "$TESS_CORE_VER" tesseract-core-lstm.wasm.js             vendor/tesseract-core/tesseract-core-lstm.wasm.js 3896484
get tesseract.js-core "$TESS_CORE_VER" tesseract-core-simd-lstm.wasm.js        vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js 3899472
get tesseract.js-core "$TESS_CORE_VER" tesseract-core-relaxedsimd-lstm.wasm.js vendor/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js 3905767

# 语言数据。npmmirror 不允许单独下载这两个包里的文件（403），改为下载整个包再取出需要的文件
get_from_tgz() {
  local pkg="$1" ver="$2" path="$3" dst="$4" expect="$5"
  if [ -s "$dst" ] && [ "$(fsize "$dst")" = "$expect" ]; then echo "已存在，跳过: $dst"; return; fi
  local tmp; tmp="$(mktemp -d)"
  echo "下载: https://registry.npmmirror.com/${pkg}/-/${pkg##*/}-${ver}.tgz（取出 ${path}）"
  curl -fL --retry 3 "https://registry.npmmirror.com/${pkg}/-/${pkg##*/}-${ver}.tgz" | tar xz -C "$tmp" "package/$path"
  mkdir -p "$(dirname "$dst")" && mv "$tmp/package/$path" "$dst" && rm -rf "$tmp"
  [ "$(fsize "$dst")" = "$expect" ] || { echo "❌ 文件大小不对: $dst" >&2; exit 1; }
}
for lang in chi_sim:1718768 eng:2952873; do
  name="${lang%%:*}"; size="${lang##*:}"
  if [ "$CDN" = "npmmirror" ]; then
    get_from_tgz "@tesseract.js-data/$name" "$TESS_DATA_VER" "4.0.0_best_int/$name.traineddata.gz" "vendor/tesseract-lang/$name.traineddata.gz" "$size"
  else
    get "@tesseract.js-data/$name" "$TESS_DATA_VER" "4.0.0_best_int/$name.traineddata.gz" "vendor/tesseract-lang/$name.traineddata.gz" "$size"
  fi
done

echo "完成。vendor/ 目录内容："
du -sh vendor/*
