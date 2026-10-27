#!/bin/bash
# ------------------------------------------------------------
# 双击启动 Eup Preflight（macOS）
# 启动本地服务器并自动打开浏览器；关闭这个终端窗口即退出。
# 第一次双击如果提示“无法验证开发者”：右键这个文件 →「打开」→ 再点「打开」。
# ------------------------------------------------------------
cd "$(dirname "$0")" || exit 1
echo "Eup Preflight · 短视频发片前检查（全部在本机处理，视频不会上传）"
echo

# 第三方库不在仓库里时（例如从 git 克隆），先下载一次（约 80MB，国内镜像）
if [ ! -f vendor/ffmpeg-core/ffmpeg-core.wasm ]; then
  echo "第一次使用：正在下载第三方库（约 80MB）…"
  if ! CDN=npmmirror bash scripts/download-vendor.sh; then
    echo "下载失败，请检查网络后再双击一次。"
    read -r -p "按回车关闭"
    exit 1
  fi
fi

# macOS 自带 python3；如果系统提示安装“命令行开发者工具”，装完再双击一次即可
if ! python3 serve.py 3000 --open; then
  echo
  echo "启动失败。如果上面提示没有 python3，请按系统提示安装“命令行开发者工具”后再试；"
  echo "也可以安装 Node.js 后在这个文件夹里运行：npx serve@14.2.4 -l 3000 ."
  read -r -p "按回车关闭"
fi
