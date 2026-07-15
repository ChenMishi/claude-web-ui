#!/bin/bash
# ============================================================
# Claude Web UI — 版本回滚脚本
# 用法: ./rollback.sh <tag>
# 例:   ./rollback.sh v2.3.5
# ============================================================
set -e
set -o pipefail

TAG="$1"
if [ -z "$TAG" ]; then
    echo "用法: ./rollback.sh <tag>" >&2
    exit 1
fi

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[INFO]${NC}  $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $1" >&2; }
err()  { echo -e "${RED}[ERROR]${NC} $1" >&2; }
pct()  {
  echo "[PROGRESS] $1" >&2
  echo "{\"status\":\"running\",\"progress\":$1,\"message\":\"$2\"}" > /tmp/claude-web-ui-upgrade.status.tmp && mv /tmp/claude-web-ui-upgrade.status.tmp /tmp/claude-web-ui-upgrade.status.json
}

echo ""
echo "  ╔══════════════════════════════╗"
echo "  ║   Claude Web UI 版本回滚     ║"
echo "  ║   目标: $TAG"
echo "  ╚══════════════════════════════╝"
echo ""

cd "$PROJECT_DIR"

# ---------- 保存旧服务端口 ----------
OLD_PORT=""
if [ -f .port ]; then
    OLD_PORT=$(cat .port)
fi
PORT=${OLD_PORT:-3000}

# ---------- Fetch tags ----------
pct 5 "拉取版本标签..."
log "拉取版本标签..."
git fetch --tags --quiet 2>&1 || warn "标签拉取失败（继续尝试本地）"

# ---------- Checkout target tag ----------
pct 15 "切换到 $TAG ..."
log "切换到 $TAG ..."
git checkout "$TAG" 2>&1 || {
    err "切换失败，版本标签 $TAG 不存在"
    echo "{\"status\":\"error\",\"progress\":15,\"message\":\"切换失败，版本标签 $TAG 不存在\"}" > /tmp/claude-web-ui-upgrade.status.tmp && mv /tmp/claude-web-ui-upgrade.status.tmp /tmp/claude-web-ui-upgrade.status.json
    exit 1
}
log "已切换到 $TAG ($(git rev-parse --short HEAD))"

# ---------- Install dependencies ----------
pct 30 "安装服务端依赖..."
log "安装服务端依赖..."
npm install --production 2>&1 | tail -3

pct 40 "编译原生模块..."
npm rebuild node-pty bcrypt 2>&1 | tail -3 || warn "部分原生模块编译失败，终端功能可能不可用"

pct 50 "安装前端依赖..."
cd client && npm install 2>&1 | tail -3
cd "$PROJECT_DIR"

# ---------- Build frontend ----------
pct 60 "构建前端..."
cd client
if npm run build 2>&1; then
    pct 75 "构建成功，准备启动..."
    log "前端构建成功"
else
    err "前端构建失败"
    echo "{\"status\":\"error\",\"progress\":70,\"message\":\"构建失败\"}" > /tmp/claude-web-ui-upgrade.status.tmp && mv /tmp/claude-web-ui-upgrade.status.tmp /tmp/claude-web-ui-upgrade.status.json
    exit 1
fi
cd "$PROJECT_DIR"

# ---------- Stop old service ----------
pct 85 "停止旧服务..."
log "停止旧服务..."
if [ -n "$PORT" ] && lsof -i ":$PORT" &>/dev/null 2>&1; then
    kill $(lsof -t -i ":$PORT") 2>/dev/null
    sleep 2
    lsof -i ":$PORT" &>/dev/null 2>&1 && kill -9 $(lsof -t -i ":$PORT") 2>/dev/null
fi
rm -f .pid .port

# ---------- Start new service ----------
pct 90 "启动新服务..."
export PORT=$PORT
echo "$PORT" > .port

log "启动服务 (端口 $PORT)..."
nohup node server.js > server.log 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > .pid

sleep 3
TARGET_VER=$(cat VERSION 2>/dev/null || echo "?")
if lsof -i ":$PORT" &>/dev/null; then
    echo "{\"status\":\"done\",\"progress\":100,\"message\":\"已回滚到 v$TARGET_VER，请刷新页面\",\"newVersion\":\"$TARGET_VER\"}" > /tmp/claude-web-ui-upgrade.status.tmp && mv /tmp/claude-web-ui-upgrade.status.tmp /tmp/claude-web-ui-upgrade.status.json
    pct 100 "回滚完成！"
    SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    [ -z "$SERVER_IP" ] && SERVER_IP="localhost"
    log "回滚完成！"
    echo ""
    echo "  ╔════════════════════════════════════╗"
    echo "  ║   已回滚到 v$TARGET_VER             ║"
    echo "  ╠════════════════════════════════════╣"
    echo "  ║  地址: http://${SERVER_IP}:${PORT}"
    echo "  ║  PID : ${NEW_PID}"
    echo "  ╚════════════════════════════════════╝"
    echo ""
else
    echo "{\"status\":\"error\",\"progress\":100,\"message\":\"启动失败，查看日志\"}" > /tmp/claude-web-ui-upgrade.status.tmp && mv /tmp/claude-web-ui-upgrade.status.tmp /tmp/claude-web-ui-upgrade.status.json
    err "启动失败，查看日志: $PROJECT_DIR/server.log"
    exit 1
fi
