#!/bin/bash
# ============================================================
# Claude Web UI — 一键部署脚本
# 用法: ./deploy.sh [端口号]
#       ./deploy.sh        # 默认 3000，被占用则自动选择
#       ./deploy.sh 8080   # 指定端口
# ============================================================
set -e

GOGS_REPO="http://10.178.5.224:3000/gogs/claude-web-ui.git"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_NAME="claude-web-ui"

# ---------- 颜色 ----------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[INFO]${NC}  $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $1" >&2; }
err()  { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# ---------- 端口检测 ----------
find_port() {
    local port=${1:-3000}
    while lsof -i ":$port" &>/dev/null; do
        warn "端口 $port 已被占用"
        port=$((port + 1))
        if [ $port -gt 3020 ]; then
            err "端口范围 3000-3020 全部被占用，请手动指定"
            exit 1
        fi
    done
    echo "$port"
}

# ---------- 拉取代码 ----------
setup_code() {
    if [ -f "$PROJECT_DIR/server/index.js" ]; then
        log "已有代码，跳过克隆"
        return
    fi
    PARENT_DIR="$(dirname "$PROJECT_DIR")"
    if [ "$(basename "$PROJECT_DIR")" = "$PROJECT_NAME" ] && [ ! -f "$PROJECT_DIR/server/index.js" ]; then
        log "克隆代码: $GOGS_REPO"
        cd "$PARENT_DIR"
        git clone "$GOGS_REPO" "$(basename "$PROJECT_DIR")"
    else
        log "项目目录: $PROJECT_DIR"
    fi
}

# ---------- 安装 Node.js ----------
install_node() {
    local need_install=false

    if ! command -v node &>/dev/null; then need_install=true; fi
    if ! command -v npm &>/dev/null; then need_install=true; fi

    if [ "$need_install" = false ]; then
        log "Node.js $(node -v) / npm $(npm -v 2>/dev/null || echo '?') 已就绪"
        return
    fi

    warn "未检测到完整 Node.js 环境，正在安装..."

    if command -v apt &>/dev/null; then
        # Debian / Ubuntu - nodejs package may not include npm
        log "检测到 apt，安装 Node.js 及 npm..."
        if ! command -v node &>/dev/null; then
            curl -fsSL https://deb.nodesource.com/setup_22.x | bash - 2>&1 | tail -1
        fi
        apt install -y nodejs npm 2>&1 | tail -1
    elif command -v dnf &>/dev/null; then
        log "检测到 dnf，安装 Node.js..."
        curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - 2>&1 | tail -1
        dnf install -y nodejs 2>&1 | tail -1
    elif command -v yum &>/dev/null; then
        log "检测到 yum，安装 Node.js..."
        curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - 2>&1 | tail -1
        yum install -y nodejs 2>&1 | tail -1
    elif command -v apk &>/dev/null; then
        log "检测到 apk，安装 Node.js..."
        apk add --no-cache nodejs npm 2>&1 | tail -1
    elif command -v pacman &>/dev/null; then
        log "检测到 pacman，安装 Node.js..."
        pacman -S --noconfirm nodejs npm 2>&1 | tail -1
    else
        err "无法识别包管理器，请手动安装 Node.js >= 18"
        echo "  下载: https://nodejs.org/"
        exit 1
    fi

    if ! command -v node &>/dev/null; then
        err "Node.js 安装失败"
        exit 1
    fi
    log "Node.js $(node -v) 安装完成"
}

# ---------- 安装 git ----------
install_git() {
    if command -v git &>/dev/null; then
        return
    fi
    warn "未检测到 git，正在安装..."
    if command -v apt &>/dev/null; then
        apt install -y git 2>&1 | tail -1
    elif command -v dnf &>/dev/null; then
        dnf install -y git 2>&1 | tail -1
    elif command -v yum &>/dev/null; then
        yum install -y git 2>&1 | tail -1
    elif command -v apk &>/dev/null; then
        apk add --no-cache git 2>&1 | tail -1
    elif command -v pacman &>/dev/null; then
        pacman -S --noconfirm git 2>&1 | tail -1
    fi
    log "git 安装完成"
}

# ---------- 安装项目依赖 ----------
install_deps() {
    cd "$PROJECT_DIR"
    log "安装服务端依赖..."
    npm install --production 2>&1 | tail -1
    log "安装前端依赖..."
    cd client && npm install 2>&1 | tail -1
    cd "$PROJECT_DIR"
}

# ---------- 构建前端 ----------
build_client() {
    cd "$PROJECT_DIR/client"
    log "构建前端..."
    npm run build 2>&1 | tail -1
    cd "$PROJECT_DIR"
}

# ---------- 启动服务 ----------
start_server() {
    local port=$1
    cd "$PROJECT_DIR"

    # 停止旧进程（按端口 + 按 PID 双重保险）
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

    # 写入端口
    export PORT=$port

    log "启动服务 (端口 $port)..."
    echo "$port" > .port
    nohup node server.js > server.log 2>&1 &
    NEW_PID=$!
    echo "$NEW_PID" > .pid

    sleep 3
    # Check if port is actually listening (more reliable than PID check)
    if lsof -i ":$port" &>/dev/null; then
        SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
        [ -z "$SERVER_IP" ] && SERVER_IP="localhost"
        log "服务启动成功"
        echo ""
        echo "  ╔════════════════════════════════════╗"
        echo "  ║   Claude Web UI 已启动              ║"
        echo "  ╠════════════════════════════════════╣"
        echo "  ║  地址: http://${SERVER_IP}:${port}"
        echo "  ║  文档: http://${SERVER_IP}:${port}/docs"
        echo "  ║  日志: ${PROJECT_DIR}/server.log"
        echo "  ║  PID : ${NEW_PID}"
        echo "  ╠════════════════════════════════════╣"
        echo "  ║  停止: kill ${NEW_PID}"
        echo "  ╚════════════════════════════════════╝"
        echo ""
        err "服务启动失败，查看日志: $PROJECT_DIR/server.log"
        exit 1
    fi
}

# ==================== 主流程 ====================
echo ""
echo "  ╔══════════════════════════════╗"
echo "  ║   Claude Web UI 一键部署     ║"
echo "  ╚══════════════════════════════╝"
echo ""

PORT=$(find_port "${1:-3000}")
log "使用端口: $PORT"

install_node
install_git
setup_code
install_deps
build_client
start_server "$PORT"
