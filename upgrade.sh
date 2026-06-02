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
pct()  {
  echo "[PROGRESS] $1" >&2
  echo "{\"status\":\"running\",\"progress\":$1,\"message\":\"$2\"}" > /tmp/claude-web-ui-upgrade.status.tmp && mv /tmp/claude-web-ui-upgrade.status.tmp /tmp/claude-web-ui-upgrade.status.json
}

# ---------- 安装基础系统工具 ----------
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
  fi
}

# ---------- 确保编译工具 ----------
ensure_build_tools() {
  if command -v make &>/dev/null && command -v gcc &>/dev/null && command -v python3 &>/dev/null; then
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

# ---------- 确保 Node.js ----------
ensure_node() {
    if command -v node &>/dev/null && command -v npm &>/dev/null; then
        log "Node.js $(node -v) 就绪"
        return
    fi
    if command -v node &>/dev/null && command -v npm &>/dev/null; then
        local major=$(node -v | sed 's/v\([0-9]*\).*/\1/')
        if [ "$major" -ge 20 ]; then
            log "Node.js $(node -v) 就绪"
            return
        fi
        warn "Node.js $(node -v) 版本过低 (需要 >= 20)，升级中..."
    else
        warn "安装 Node.js..."
    fi
    if command -v apt &>/dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
        apt install -y nodejs
    elif command -v dnf &>/dev/null; then
        curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
        dnf install -y nodejs
    elif command -v yum &>/dev/null; then
        curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
        yum install -y nodejs
    elif command -v apk &>/dev/null; then
        apk add --no-cache nodejs npm
    else
        err "请先手动安装 Node.js >= 20"
        exit 1
    fi
    # Verify upgrade
    local new_major=$(node -v | sed 's/v\([0-9]*\).*/\1/')
    if [ "$new_major" -lt 20 ]; then
        err "Node.js 升级失败，当前版本 $(node -v) 仍低于 20"
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

pct 1 "检查系统工具..."
install_system_tools
pct 3 "检查 Node.js 环境..."
ensure_node

pct 5 "升级中..."

# ---------- 保存旧服务端口（稍后重启时复用）----------
OLD_PORT=""
OLD_PID=""
if [ -f .port ]; then
    OLD_PORT=$(cat .port)
fi
if [ -f .pid ]; then
    OLD_PID=$(cat .pid)
fi

# ---------- 拉取最新代码 ----------
pct 10 "拉取最新代码..."
log "拉取最新代码..."

# 暂存本地改动然后拉取，避免冲突
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    warn "检测到本地改动，暂存后拉取..."
    git stash push -m "upgrade-auto-stash-$(date +%s)" 2>/dev/null || true
fi
git pull 2>&1 | tail -3 || {
    err "git pull 失败，请手动更新"
    exit 1
}

# ---------- 确保编译工具 ----------
pct 15 "检查编译工具..."
ensure_build_tools

# ---------- 更新依赖 ----------
pct 20 "安装服务端依赖..."
log "更新服务端依赖..."
npm install --production 2>&1 | tail -3
pct 25 "编译原生模块..."
log "编译原生模块 (node-pty / bcrypt)..."
npm rebuild node-pty bcrypt 2>&1 | tail -3 || warn "部分原生模块编译失败，终端功能可能不可用"

pct 35 "安装前端依赖..."
log "更新前端依赖..."
cd client && npm install 2>&1 | tail -3
cd "$PROJECT_DIR"

# ---------- 重新构建前端 ----------
pct 50 "构建前端准备..."
log "开始构建前端..."
cd client
if npm run build 2>&1; then
    pct 75 "构建成功，准备启动..."
    log "前端构建成功"
else
    err "前端构建失败，查看上方输出"
    echo "{\"status\":\"error\",\"progress\":70,\"message\":\"构建失败\"}" > /tmp/claude-web-ui-upgrade.status.tmp && mv /tmp/claude-web-ui-upgrade.status.tmp /tmp/claude-web-ui-upgrade.status.json
    exit 1
fi
cd "$PROJECT_DIR"

# ---------- 报告完成（旧服务仍在运行，前端可看到进度）----------
pct 85 "升级完成，准备重启服务..."
NEW_VERSION=$(cat VERSION 2>/dev/null || echo "?")
echo "{\"status\":\"done\",\"progress\":100,\"message\":\"升级完成，请刷新页面\",\"newVersion\":\"$NEW_VERSION\"}" > /tmp/claude-web-ui-upgrade.status.tmp && mv /tmp/claude-web-ui-upgrade.status.tmp /tmp/claude-web-ui-upgrade.status.json

# ---------- 停止旧服务 ----------
pct 90 "停止旧服务..."
log "停止旧服务..."
PORT=${OLD_PORT:-3000}
if [ -n "$OLD_PORT" ] && lsof -i ":$OLD_PORT" &>/dev/null 2>&1; then
    log "停止旧服务 (端口 $OLD_PORT)"
    kill $(lsof -t -i ":$OLD_PORT") 2>/dev/null
    sleep 2
    lsof -i ":$OLD_PORT" &>/dev/null 2>&1 && kill -9 $(lsof -t -i ":$OLD_PORT") 2>/dev/null
fi
if [ -n "$OLD_PID" ]; then
    kill -0 "$OLD_PID" 2>/dev/null && kill "$OLD_PID" 2>/dev/null
fi
rm -f .pid .port

# ---------- 启动新服务 ----------
pct 95 "启动新服务..."
export PORT=$PORT
echo "$PORT" > .port

log "启动服务 (端口 $PORT)..."
nohup node server.js > server.log 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > .pid

sleep 3
if lsof -i ":$PORT" &>/dev/null; then
    NEW_VERSION=$(cat VERSION 2>/dev/null || echo "?")
    echo "{\"status\":\"done\",\"progress\":100,\"message\":\"升级完成，请刷新页面\",\"newVersion\":\"$NEW_VERSION\"}" > /tmp/claude-web-ui-upgrade.status.tmp && mv /tmp/claude-web-ui-upgrade.status.tmp /tmp/claude-web-ui-upgrade.status.json
    pct 100 "升级完成，请刷新页面！"
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
    echo "{\"status\":\"error\",\"progress\":100,\"message\":\"启动失败，查看日志\"}" > /tmp/claude-web-ui-upgrade.status.tmp && mv /tmp/claude-web-ui-upgrade.status.tmp /tmp/claude-web-ui-upgrade.status.json
    err "启动失败，查看日志: $PROJECT_DIR/server.log"
    cat "$PROJECT_DIR/server.log" | tail -20
    exit 1
fi
