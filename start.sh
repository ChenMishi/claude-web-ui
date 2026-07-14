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

# ---------- 检查端口是否已被本项目占用 ----------
if lsof -i ":$PORT" &>/dev/null; then
    # 尝试通过 .pid 文件判断是否本项目
    if [ -f .pid ]; then
        PID_FILE=$(cat .pid)
        if kill -0 "$PID_FILE" 2>/dev/null; then
            # 检查该 PID 的进程是否监听在这个端口上
            if lsof -p "$PID_FILE" -i ":$PORT" &>/dev/null 2>&1; then
                log "服务已在端口 $PORT 运行 (PID: $PID_FILE)"
                echo ""
                echo "  ╔════════════════════════════════════╗"
                echo "  ║  服务已在运行，无需重复启动         ║"
                echo "  ╠════════════════════════════════════╣"
                echo "  ║  端口: $PORT   PID: $PID_FILE"
                echo "  ╠════════════════════════════════════╣"
                echo "  ║  重启: ./restart.sh"
                echo "  ║  停止: ./stop.sh"
                echo "  ╚════════════════════════════════════╝"
                echo ""
                exit 0
            fi
        fi
    fi

    # PID 文件不匹配或不存在，检查进程命令行是否包含本项目路径
    PORT_PID=$(lsof -t -i ":$PORT" 2>/dev/null | head -1)
    if [ -n "$PORT_PID" ]; then
        CMDLINE=$(cat "/proc/$PORT_PID/cmdline" 2>/dev/null | tr '\0' ' ')
        if echo "$CMDLINE" | grep -q "$PROJECT_DIR"; then
            log "服务已在端口 $PORT 运行 (PID: $PORT_PID，匹配本项目路径)"
            echo "$PORT_PID" > .pid
            echo ""
            echo "  ╔════════════════════════════════════╗"
            echo "  ║  服务已在运行，无需重复启动         ║"
            echo "  ╠════════════════════════════════════╣"
            echo "  ║  端口: $PORT   PID: $PORT_PID"
            echo "  ╠════════════════════════════════════╣"
            echo "  ║  重启: ./restart.sh"
            echo "  ║  停止: ./stop.sh"
            echo "  ╚════════════════════════════════════╝"
            echo ""
            exit 0
        fi
    fi

    # 端口被其他进程占用，自动递增
    warn "端口 $PORT 已被其他进程占用，寻找可用端口..."
    while lsof -i ":$PORT" &>/dev/null; do
        PORT=$((PORT + 1))
        [ $PORT -gt 3020 ] && { err "无可用端口 (3000-3020 均被占用)"; exit 1; }
    done
    log "使用端口 $PORT"
else
    # 端口空闲，但检查 .pid 残留（上次未正常 stop）
    if [ -f .pid ]; then
        PID_FILE=$(cat .pid)
        if ! kill -0 "$PID_FILE" 2>/dev/null; then
            warn "上次的 PID 文件残留 ($PID_FILE 已不存在)，清理中..."
            rm -f .pid
        fi
    fi
fi

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
    echo "  ║  重启: ./restart.sh"
    echo "  ║  停止: ./stop.sh"
    echo "  ╚════════════════════════════════════╝"
    echo ""
else
    err "启动失败，查看日志: ${PROJECT_DIR}/server.log"
    exit 1
fi
