#!/bin/bash
# ============================================================
# Claude Web UI — 启动服务（不重新构建）
# 用法: ./start.sh [端口号]
#       ./start.sh        # 使用上次端口或默认 3000
#       ./start.sh 8080   # 指定端口
# ============================================================
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[INFO]${NC}  $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $1" >&2; }
err()  { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# ---------- 确定端口 ----------
PORT=${1:-}
if [ -z "$PORT" ] && [ -f .port ]; then
    PORT=$(cat .port)
fi
PORT=${PORT:-3000}

while lsof -i ":$PORT" &>/dev/null; do
    warn "端口 $PORT 已被占用"
    PORT=$((PORT + 1))
    [ $PORT -gt 3020 ] && { err "无可用端口"; exit 1; }
done

echo "$PORT" > .port

# ---------- 确保 Node.js ----------
if ! command -v node &>/dev/null; then
    err "未检测到 Node.js，请先运行 ./deploy.sh"
    exit 1
fi

# ---------- 启动 ----------
export PORT=$PORT
log "启动服务 (端口 $PORT)..."
nohup node server.js > server.log 2>&1 &
PID=$!
echo "$PID" > .pid

sleep 3
if lsof -i ":$PORT" &>/dev/null; then
    SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    [ -z "$SERVER_IP" ] && SERVER_IP="localhost"
    log "启动成功"
    echo ""
    echo "  ╔════════════════════════════════════╗"
    echo "  ║   Claude Web UI 已启动              ║"
    echo "  ╠════════════════════════════════════╣"
    echo "  ║  地址: http://${SERVER_IP}:${PORT}"
    echo "  ║  日志: ${PROJECT_DIR}/server.log"
    echo "  ║  PID : ${PID}"
    echo "  ╠════════════════════════════════════╣"
    echo "  ║  停止: ./stop.sh"
    echo "  ╚════════════════════════════════════╝"
    echo ""
else
    err "启动失败，查看日志: ${PROJECT_DIR}/server.log"
    exit 1
fi
