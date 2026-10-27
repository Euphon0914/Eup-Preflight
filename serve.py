#!/usr/bin/env python3
# ------------------------------------------------------------
# 本地静态服务器（没有 Node.js 时用）：python3 serve.py [端口] [--open]
#   端口默认 3000，被占用时自动往后找一个空闲端口（最多试 20 个）
#   --open  启动后自动用默认浏览器打开页面（双击启动脚本用）
# 额外加上 COOP/COEP 响应头，这样页面处于 crossOriginIsolated 状态，
# ffmpeg.wasm 多线程核心才能使用 SharedArrayBuffer。
# ------------------------------------------------------------
import http.server, socketserver, sys, os, threading, webbrowser

args = [a for a in sys.argv[1:] if not a.startswith('--')]
OPEN = '--open' in sys.argv
PORT = int(args[0]) if args else 3000
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class Handler(http.server.SimpleHTTPRequestHandler):
    # 确保 wasm / mjs 的 MIME 类型正确（老版本 Python 不认识）
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.wasm': 'application/wasm', '.js': 'text/javascript', '.mjs': 'text/javascript',
                      '.json': 'application/json'}

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *a):
        if OPEN:  # 双击启动时不刷屏，只显示出错的请求
            if len(a) > 1 and str(a[1]).startswith(('4', '5')):
                super().log_message(fmt, *a)
        else:
            super().log_message(fmt, *a)

class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = False  # 端口被占用时要能发现，换下一个

server = None
for port in range(PORT, PORT + 20):
    try:
        server = Server(('127.0.0.1', port), Handler)
        break
    except OSError:
        print(f'端口 {port} 被占用，换下一个…')
if server is None:
    sys.exit(f'找不到空闲端口（试了 {PORT}~{PORT + 19}）')

url = f'http://localhost:{server.server_address[1]}'
print(f'Eup Preflight 已启动： {url}  （关闭这个窗口或按 Ctrl+C 退出）')
if OPEN:
    threading.Timer(0.6, lambda: webbrowser.open(url)).start()
try:
    server.serve_forever()
except KeyboardInterrupt:
    print('\n已退出')
