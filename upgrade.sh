#!/bin/bash
# ============================================================
# Claude Web UI — 一键升级脚本
# 用法: ./upgrade.sh
# ============================================================
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[INFO]${NC}  $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $1" >&2; }
err()  { echo -e "${RED}[ERROR]${NC} $1" >&2; }
pct()  { echo "[PROGRESS] $1"; }

# ---------- 确保 Node.js ----------
ensure_node() {
    if command -v node &>/dev/null; then
        log "Node.js $(node -v) 就绪"
        return
    fi
        warn "未检测到 Node.js，正在安装..."
        if command -v apt &>/dev/null; then
            curl -fsSL https://deb.nodesource.com/setup_22.x | bash - 2>&1 | tail -1
            apt install -y nodejs 2>&1 | tail -1
        elif command -v dnf &>/dev/null; then
            curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - 2>&1 | tail -1
            dnf install -y nodejs 2>&1 | tail -1
        elif command -v yum &>/dev/null; then
            curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - 2>&1 | tail -1
            yum install -y nodejs 2>&1 | tail -1
        elif command -v apk &>/dev/null; then
            apk add --no-cache nodejs npm 2>&1 | tail -1
        else
            err "请先手动安装 Node.js >= 18"
            exit 1
        fi
    log "Node.js $(node -v) 就绪"
}

echo ""
echo "  ╔══════════════════════════════╗"
echo "  ║   Claude Web UI 一键升级     ║"
echo "  ╚══════════════════════════════╝"
echo ""

cd "$PROJECT_DIR"

ensure_node

pct 5
# ---------- 停止服务 ----------
if [ -f .port ]; then
    OLD_PORT=$(cat .port)
    if lsof -i ":$OLD_PORT" &>/dev/null 2>&1; then
        log "停止旧服务 (端口 $OLD_PORT)"
        kill $(lsof -t -i ":$OLD_PORT") 2>/dev/null
        sleep 2
        lsof -i ":$OLD_PORT" &>/dev/null 2>&1 && kill -9 $(lsof -t -i ":$OLD_PORT") 2>/dev/null
    fi
fi
if [ -f .pid ]; then
    OLD_PID=$(cat .pid)
    kill -0 "$OLD_PID" 2>/dev/null && kill "$OLD_PID" 2>/dev/null
    rm -f .pid
fi

# ---------- 拉取最新代码 ----------
# 删除运行时文件避免 git pull 冲突（会被脚本重新生成）
rm -f .pid .port
pct 10
log "拉取最新代码..."
git pull origin master 2>&1 | tail -3

# ---------- 更新依赖 ----------
pct 20
log "检查服务端依赖..."
npm install --production 2>&1 | tail -1
pct 30
log "编译原生模块 (node-pty)..."
npm rebuild node-pty 2>&1 | tail -1

pct 40

log "检查前端依赖..."
cd client && npm install 2>&1 | tail -1
cd "$PROJECT_DIR"

# ---------- 重新构建前端 ----------
pct 60
log "重新构建前端..."
cd client && npm run build 2>&1 | tail -1
cd "$PROJECT_DIR"

# ---------- 读取端口 ----------
pct 80
PORT=${OLD_PORT:-3000}

# 检查端口是否可用（如果被占用了说明之前的停止失败，顺延）
while lsof -i ":$PORT" &>/dev/null 2>&1; do
    warn "端口 $PORT 已被占用"
    PORT=$((PORT + 1))
    [ $PORT -gt 3020 ] && { err "无可用端口"; exit 1; }
done

# ---------- 启动服务 ----------
export PORT=$PORT
echo "$PORT" > .port

pct 90
log "启动服务 (端口 $PORT)..."
nohup node server.js > server.log 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > .pid

sleep 3
# Check if port is actually listening
if lsof -i ":$PORT" &>/dev/null; then
    pct 100
    SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    [ -z "$SERVER_IP" ] && SERVER_IP="localhost"
    log "升级完成！"
    echo ""
    echo "  ╔════════════════════════════════════╗"
    echo "  ║   Claude Web UI 已更新              ║"
    echo "  ╠════════════════════════════════════╣"
    echo "  ║  地址: http://${SERVER_IP}:${PORT}"
    echo "  ║  PID : ${NEW_PID}"
    echo "  ╚════════════════════════════════════╝"
    echo ""
else
    err "启动失败，查看日志: $PROJECT_DIR/server.log"
    exit 1
fi
