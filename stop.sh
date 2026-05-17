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

# 读取端口
PORT=3000
[ -f .port ] && PORT=$(cat .port)

# 按 PID 停止
if [ -f .pid ]; then
    PID=$(cat .pid)
    if kill -0 "$PID" 2>/dev/null; then
        echo -e "${GREEN}[INFO]${NC}  停止服务 (PID $PID, 端口 $PORT)..."
        kill "$PID"
        sleep 2
        # 如果还没死就强杀
        kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
        echo -e "${GREEN}[INFO]${NC}  已停止"
    else
        echo -e "${YELLOW}[WARN]${NC} PID $PID 已不存在"
    fi
    rm -f .pid
else
    echo -e "${YELLOW}[WARN]${NC} 未找到 .pid 文件"
fi

# 兜底：按端口清理
if lsof -i ":$PORT" &>/dev/null 2>&1; then
    echo -e "${YELLOW}[WARN]${NC} 端口 $PORT 仍有残留进程，强制清理..."
    kill -9 $(lsof -t -i ":$PORT") 2>/dev/null
    echo -e "${GREEN}[INFO]${NC}  已清理"
fi

echo -e "${GREEN}[INFO]${NC}  服务已停止"
