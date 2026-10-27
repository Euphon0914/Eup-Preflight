@echo off
rem ------------------------------------------------------------
rem 双击启动 Eup Preflight（Windows）
rem 启动本地服务器并自动打开浏览器；关闭这个窗口即退出。
rem ------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0"
echo Eup Preflight · 短视频发片前检查（全部在本机处理，视频不会上传）
echo.
if not exist "vendor\ffmpeg-core\ffmpeg-core.wasm" (
  echo 缺少第三方库文件夹 vendor。请使用完整的压缩包，或在 Mac / Linux 上运行 scripts\download-vendor.sh 下载后再复制过来。
  pause
  exit /b 1
)
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 serve.py 3000 --open
  goto end
)
where python >nul 2>nul
if %errorlevel%==0 (
  python serve.py 3000 --open
  goto end
)
echo 没有找到 Python。请从 https://www.python.org/downloads/ 安装（安装时勾选 "Add python.exe to PATH"），
echo 或安装 Node.js 后在这个文件夹里运行：npx serve@14.2.4 -l 3000 .
:end
pause
