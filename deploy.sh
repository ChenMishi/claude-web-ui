#!/bin/bash
# ============================================================
# Claude Web UI — 一键部署脚本
# 用法: ./deploy.sh [端口号]
#       GIT_REPO=git@xxx:repo.git ./deploy.sh   # 指定 git 仓库
#       ./deploy.sh 8080                        # 指定端口
# ============================================================
set -e

# Git 仓库地址（可通过环境变量覆盖）
GIT_REPO="${GIT_REPO:-}"
GIT_BRANCH="${GIT_BRANCH:-master}"
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

# ---------- 生成默认管理员密码 ----------
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
if [ -z "$ADMIN_PASSWORD" ]; then
    if command -v openssl &>/dev/null; then
        ADMIN_PASSWORD=$(openssl rand -base64 12 | tr -dc 'a-zA-Z0-9' | head -c 12)
    else
        ADMIN_PASSWORD=$(head -c 16 /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 12)
    fi
    # Fallback if both fail
    ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin$(date +%s | tail -c 7)}"
fi
export ADMIN_PASSWORD

# ---------- 安装基础系统工具（lsof, curl, git）----------
install_system_tools() {
  local need_lsof=false need_curl=false need_git=false
  command -v lsof &>/dev/null || need_lsof=true
  command -v curl &>/dev/null || need_curl=true
  command -v git  &>/dev/null || need_git=true

  if [ "$need_lsof" = false ] && [ "$need_curl" = false ] && [ "$need_git" = false ]; then
    return
  fi

  warn "安装基础工具 (lsof/curl/git)..."
  if command -v apt &>/dev/null; then
    apt update -qq 2>/dev/null
    $need_lsof && apt install -y -qq lsof 2>&1 | tail -1
    $need_curl && apt install -y -qq curl 2>&1 | tail -1
    $need_git  && apt install -y -qq git 2>&1 | tail -1
  elif command -v dnf &>/dev/null; then
    $need_lsof && dnf install -y lsof 2>&1 | tail -1
    $need_curl && dnf install -y curl 2>&1 | tail -1
    $need_git  && dnf install -y git 2>&1 | tail -1
  elif command -v yum &>/dev/null; then
    $need_lsof && yum install -y lsof 2>&1 | tail -1
    $need_curl && yum install -y curl 2>&1 | tail -1
    $need_git  && yum install -y git 2>&1 | tail -1
  elif command -v apk &>/dev/null; then
    $need_lsof && apk add --no-cache lsof 2>&1 | tail -1
    $need_curl && apk add --no-cache curl 2>&1 | tail -1
    $need_git  && apk add --no-cache git 2>&1 | tail -1
  elif command -v pacman &>/dev/null; then
    $need_lsof && pacman -S --noconfirm lsof 2>&1 | tail -1
    $need_curl && pacman -S --noconfirm curl 2>&1 | tail -1
    $need_git  && pacman -S --noconfirm git 2>&1 | tail -1
  fi
  log "基础工具就绪"
}

# ---------- 安装编译工具（node-pty / bcrypt 原生模块需要）----------
install_build_tools() {
  if command -v make &>/dev/null && command -v gcc &>/dev/null && command -v python3 &>/dev/null; then
    log "编译工具已就绪"
    return
  fi
  warn "安装编译工具 (make/gcc/python3)..."
  if command -v apt &>/dev/null; then
    apt install -y -qq build-essential python3 2>&1 | tail -1
  elif command -v dnf &>/dev/null; then
    dnf install -y make gcc gcc-c++ python3 2>&1 | tail -1
  elif command -v yum &>/dev/null; then
    yum install -y make gcc gcc-c++ python3 2>&1 | tail -1
  elif command -v apk &>/dev/null; then
    apk add --no-cache build-base python3 2>&1 | tail -1
  elif command -v pacman &>/dev/null; then
    pacman -S --noconfirm base-devel python3 2>&1 | tail -1
  fi
  log "编译工具就绪"
}

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

    if [ -z "$GIT_REPO" ]; then
        err "未设置 GIT_REPO 环境变量，且当前目录无项目代码"
        echo ""
        echo "  用法示例:"
        echo "    GIT_REPO=http://your-git-server/repo.git ./deploy.sh"
        echo "    GIT_REPO=git@github.com:user/repo.git ./deploy.sh"
        exit 1
    fi

    PARENT_DIR="$(dirname "$PROJECT_DIR")"
    log "克隆代码: $GIT_REPO ($GIT_BRANCH)"

    # Clone to a temp dir first, then move files to PROJECT_DIR
    TMP_CLONE=$(mktemp -d -p "$PARENT_DIR" claude-web-ui-tmp.XXXXXX)
    git clone -b "$GIT_BRANCH" "$GIT_REPO" "$TMP_CLONE" 2>&1 | tail -3
    # Move all including hidden files to PROJECT_DIR (keep deploy.sh if present)
    shopt -s dotglob
    mv "$TMP_CLONE"/* "$PROJECT_DIR"/ 2>/dev/null || true
    shopt -u dotglob
    rmdir "$TMP_CLONE" 2>/dev/null || true
    log "代码克隆完成"
    cd "$PROJECT_DIR"
}

# ---------- 安装 Node.js ----------
install_node() {
    local need_install=false

    if command -v node &>/dev/null && command -v npm &>/dev/null; then
        local major=$(node -v | sed 's/v\([0-9]*\).*/\1/')
        if [ "$major" -ge 20 ]; then
            log "Node.js $(node -v) / npm $(npm -v) 已就绪"
            return
        fi
        warn "Node.js $(node -v) 版本过低 (需要 >= 20)，升级中..."
        need_install=true
    else
        need_install=true
    fi

    if [ "$need_install" = true ]; then
        warn "安装 Node.js 22.x..."
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
        elif command -v pacman &>/dev/null; then
            pacman -S --noconfirm nodejs npm 2>&1 | tail -1
        else
            err "无法识别包管理器，请手动安装 Node.js >= 20"
            echo "  下载: https://nodejs.org/"
            exit 1
        fi
    fi

    if ! command -v node &>/dev/null; then
        err "Node.js 安装失败"
        exit 1
    fi
    log "Node.js $(node -v) / npm $(npm -v) 安装完成"
}

# ---------- 安装项目依赖 ----------
install_deps() {
    cd "$PROJECT_DIR"
    log "安装服务端依赖..."
    npm install --production 2>&1 | tail -3
    log "编译原生模块 (node-pty / bcrypt)..."
    npm rebuild node-pty bcrypt 2>&1 | tail -3 || warn "部分原生模块编译失败，终端功能可能不可用"
    log "安装前端依赖..."
    cd client && npm install 2>&1 | tail -3
    cd "$PROJECT_DIR"
}

# ---------- 构建前端 ----------
build_client() {
    cd "$PROJECT_DIR/client"
    log "构建前端..."
    if npm run build 2>&1; then
        log "前端构建成功"
    else
        err "前端构建失败，查看上方输出"
        exit 1
    fi
    cd "$PROJECT_DIR"
}

# ---------- 启动服务 ----------
start_server() {
    local port=$1
    cd "$PROJECT_DIR"

    # 停止旧进程
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

    export PORT=$port
    echo "$port" > .port

    log "启动服务 (端口 $port)..."
    nohup node server.js > server.log 2>&1 &
    NEW_PID=$!
    echo "$NEW_PID" > .pid

    sleep 3
    if lsof -i ":$port" &>/dev/null; then
        SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
        [ -z "$SERVER_IP" ] && SERVER_IP="localhost"
        log "服务启动成功"
        echo ""
        echo "  ╔══════════════════════════════════════════╗"
        echo "  ║     Claude Web UI 已启动                  ║"
        echo "  ╠══════════════════════════════════════════╣"
        echo "  ║  地址:     http://${SERVER_IP}:${port}"
        echo "  ║  文档:     http://${SERVER_IP}:${port}/docs"
        echo "  ║  日志:     ${PROJECT_DIR}/server.log"
        echo "  ║  PID :     ${NEW_PID}"
        echo "  ╠══════════════════════════════════════════╣"
        echo "  ║  管理员:   admin"
        echo "  ║  密码:     ${ADMIN_PASSWORD}"
        echo "  ╠══════════════════════════════════════════╣"
        echo "  ║  停止:     ./stop.sh"
        echo "  ╚══════════════════════════════════════════╝"
        echo ""
    else
        err "服务启动失败，查看日志: $PROJECT_DIR/server.log"
        cat "$PROJECT_DIR/server.log" | tail -20
        exit 1
    fi
}

# ==================== 主流程 ====================
echo ""
echo "  ╔══════════════════════════════╗"
echo "  ║   Claude Web UI 一键部署     ║"
echo "  ╚══════════════════════════════╝"
echo ""

install_system_tools
PORT=$(find_port "${1:-3000}")
log "使用端口: $PORT"

install_build_tools
install_node
setup_code
install_deps
build_client
start_server "$PORT"
