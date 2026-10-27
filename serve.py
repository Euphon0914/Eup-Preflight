#!/usr/bin/env python3
# ------------------------------------------------------------
# 本地静态服务器（没有 Node.js 时用）：python3 serve.py [端口]
# 额外加上 COOP/COEP 响应头，这样页面处于 crossOriginIsolated 状态，
# ffmpeg.wasm 多线程核心才能使用 SharedArrayBuffer。
# ------------------------------------------------------------
import http.server, socketserver, sys, os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
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

class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

print(f'Eup Preflight 已启动： http://localhost:{PORT}  （Ctrl+C 退出）')
Server(('127.0.0.1', PORT), Handler).serve_forever()
