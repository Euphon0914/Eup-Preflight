#!/usr/bin/env bash
# ------------------------------------------------------------
# 打包发布：生成
#   dist/site   离线包的内容（网页 + 本地服务器 + 启动脚本）
#   dist/Eup-Preflight-v<版本>.zip  离线包：解压后双击启动脚本即可使用
#   dist/web    在线部署用：只含网页需要的文件，上传到静态托管的 web/ 文件夹
#   dist/root   在线部署用：根目录的跳转页，打开域名时自动转到 web/
# 用法：bash scripts/package.sh
# 版本号取自 index.html 页脚的 data-version
# ------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

VER="$(sed -n 's/.*data-version="\([^"]*\)".*/\1/p' index.html | head -1)"
[ -n "$VER" ] || { echo "index.html 里没有找到 data-version"; exit 1; }
[ -f vendor/ffmpeg-core/ffmpeg-core.wasm ] || { echo "缺少 vendor/，先运行 bash scripts/download-vendor.sh"; exit 1; }

NAME="Eup-Preflight-v$VER"
rm -rf dist && mkdir -p "dist/site"

# 只拷贝运行需要的文件（不含 .git、.claude、dist 自己）
cp -R index.html calibrate.html webcodecs-test.html config css js vendor serve.py serve.json README.md \
      "启动 Eup Preflight.command" "启动 Eup Preflight（Windows）.bat" scripts dist/site/
[ -f THIRD_PARTY_NOTICES.md ] && cp THIRD_PARTY_NOTICES.md dist/site/
rm -f dist/site/scripts/package.sh
find dist/site -name .DS_Store -delete

# 离线包：外面套一层同名文件夹，解压后不会散落一地。
# 用 Python 打包而不是 macOS 自带的 zip：中文文件名要带 UTF-8 标记，Windows 解压才不会乱码；同时保留可执行权限
python3 - "$NAME" <<'PY'
import os, sys, zipfile
name = sys.argv[1]
with zipfile.ZipFile(f'dist/{name}.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, _, files in os.walk('dist/site'):
        for f in sorted(files):
            src = os.path.join(root, f)
            arc = os.path.join(name, os.path.relpath(src, 'dist/site'))
            info = zipfile.ZipInfo.from_file(src, arc)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o755 if os.access(src, os.X_OK) else 0o644) << 16
            with open(src, 'rb') as fh:
                z.writestr(info, fh.read())
PY

# 在线部署版：不带本地服务器和启动脚本；静态托管不发 COOP/COEP 响应头，用不上多线程核心，省掉 31 MB
mkdir -p dist/web dist/root
cp -R index.html calibrate.html webcodecs-test.html config css js vendor THIRD_PARTY_NOTICES.md dist/web/
rm -rf dist/web/vendor/ffmpeg-core-mt
find dist/web -name .DS_Store -delete
cp deploy/root-index.html dist/root/index.html

echo "完成："
du -sh dist/site "dist/$NAME.zip" dist/web dist/root
