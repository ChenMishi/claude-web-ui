#!/bin/bash
# ============================================================
# Claude Web UI — 停止服务
# 用法: ./stop.sh
# ============================================================
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[INFO]${NC}  $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $1"; }

# 读取记录端口
PORT=3000
[ -f .port ] && PORT=$(cat .port)
STOPPED=false

# 按端口清理（最可靠）
if lsof -i ":$PORT" &>/dev/null 2>&1; then
    log "端口 $PORT 上有服务在运行，停止中..."
    kill $(lsof -t -i ":$PORT") 2>/dev/null
    sleep 2
    # 如果还没死就强杀
    lsof -i ":$PORT" &>/dev/null 2>&1 && kill -9 $(lsof -t -i ":$PORT") 2>/dev/null
    STOPPED=true
    log "已停止"
elif [ -f .pid ]; then
    # 端口上没有进程，尝试按 PID 清理
    PID=$(cat .pid)
    if kill -0 "$PID" 2>/dev/null; then
        warn "端口 $PORT 无进程，但 PID $PID 仍存活，清理中..."
        kill "$PID" 2>/dev/null
        sleep 1
        kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
        STOPPED=true
    fi
else
    log "服务未在运行"
fi

rm -f .pid
[ "$STOPPED" = true ] && log "完成" || log "无需操作"
