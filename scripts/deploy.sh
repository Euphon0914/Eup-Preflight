#!/usr/bin/env bash
# ------------------------------------------------------------
# 一键上线：打包 → 只上传有改动的文件到腾讯云 COS 存储桶 → 逐个文件和线上比对
#   dist/web  → 存储桶的 web/
#   dist/root → 存储桶根目录（打开域名时跳转到 web/ 的页面）
#   dist/review → 存储桶的 review/（匿名评审版，竞赛评审用，地址是 <域名>/review/）
# 需要：本机装好 coscli（默认在 ~/.local/coscli/coscli），并用 coscli config init 配好密钥和存储桶别名 eup
#   密钥用只能读写这个存储桶的子账号（腾讯云 访问管理 › 策略 eup-preflight-deploy），存在 ~/.cos.yaml，不进仓库
# 用法：bash scripts/deploy.sh
# 线上已经不用的旧文件不会自动删除，脚本最后会列出来，需要时到 COS 控制台手动删
# ------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

COSCLI="${COSCLI:-$HOME/.local/coscli/coscli}"
BUCKET="${BUCKET:-cos://eup}"
SITE="${SITE:-https://eup-preflight-d6gz1q4ji14b7385a-1409272358.tcloudbaseapp.com}"
# 比对时单个文件最多等 60 秒、失败重试 3 次（网络慢时不会一直卡住）
[ -x "$COSCLI" ] || { echo "没有找到 coscli：$COSCLI"; exit 1; }
[ -f "$HOME/.cos.yaml" ] || { echo "还没配置 coscli，先运行 $COSCLI config init"; exit 1; }

bash scripts/package.sh

# coscli 的过程日志写到 dist/，不留在项目根目录
LOG=(--log-path dist/coscli --process-log-path dist/coscli --fail-output-path dist/coscli)
echo "== 上传 web/"
"$COSCLI" sync dist/web/ "$BUCKET/web/" -r "${LOG[@]}"
echo "== 上传 review/（匿名评审版）"
"$COSCLI" sync dist/review/ "$BUCKET/review/" -r "${LOG[@]}"
echo "== 上传根目录跳转页"
"$COSCLI" sync dist/root/index.html "$BUCKET/index.html" "${LOG[@]}"

echo "== 和线上比对"
bad=0
for dir in web review; do
  while IFS= read -r f; do
    l=$(shasum "dist/$dir/$f" | cut -c1-40)
    r=$(curl -fsS --max-time 60 --retry 3 --retry-all-errors "$SITE/$dir/$f" | shasum | cut -c1-40) || r=""
    [ "$l" = "$r" ] || { echo "  不一致：$dir/$f"; bad=1; }
  done < <(cd "dist/$dir" && find . -type f ! -path './vendor/*' | sed 's|^\./||' | sort)
done
l=$(shasum dist/root/index.html | cut -c1-40); r=$(curl -fsS --max-time 60 --retry 3 --retry-all-errors "$SITE/index.html" | shasum | cut -c1-40) || r=""
[ "$l" = "$r" ] || { echo "  不一致：index.html（根目录）"; bad=1; }

# 线上 web/、review/ 里有、本地打包里没有的文件（已经不用的旧文件）
stale=$(for dir in web review; do
  "$COSCLI" ls "$BUCKET/$dir/" -r --log-path dist/coscli 2>/dev/null \
    | awk -F'|' '$2 ~ /STANDARD/ { gsub(/^ +| +$/, "", $1); print $1 }' \
    | sed "s|^$dir/||" | grep -v '^$' | while IFS= read -r k; do [ -e "dist/$dir/$k" ] || echo "$dir/$k"; done
done || true)
[ -z "$stale" ] || { echo "== 线上已经不用的旧文件（不影响网站，需要时到 COS 控制台删）："; echo "$stale" | sed 's/^/  /'; }

if [ "$bad" = 0 ]; then echo "完成：线上和本地打包一致（vendor/ 未逐个比对）"; else echo "有文件不一致，见上面"; exit 1; fi
