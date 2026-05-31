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
CYAN='\033[0;36m'
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
    ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin$(date +%s | tail -c 7)}"
fi
export ADMIN_PASSWORD

# ──────────────────────────────────────────────
# 进度步骤包装器 — 隐藏正常输出，只在出错时显示
# ──────────────────────────────────────────────
TOTAL_STEPS=8
CURRENT_STEP=0

run_step() {
  CURRENT_STEP=$((CURRENT_STEP + 1))
  local desc="$1"; shift
  local log_file
  log_file=$(mktemp /tmp/deploy-step.XXXXXX)

  local start_time
  start_time=$(date +%s)

  # 在子 shell 中运行，全部输出重定向到日志文件
  ("$@" >"$log_file" 2>&1) &
  local cmd_pid=$!

  # 动画 spinner + 耗时
  local spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  local i=0
  while kill -0 $cmd_pid 2>/dev/null; do
    local elapsed
    elapsed=$(($(date +%s) - start_time))
    printf "\r${CYAN}  [%d/%d]${NC} %s %s (${elapsed}s)" "$CURRENT_STEP" "$TOTAL_STEPS" "${spin:$i:1}" "$desc"
    i=$(( (i+1) % ${#spin} ))
    sleep 0.15
  done
  wait $cmd_pid
  local rc=$?
  local elapsed
  elapsed=$(($(date +%s) - start_time))

  if [ $rc -eq 0 ]; then
    printf "\r${GREEN}  [%d/%d] ✅${NC} %s — 完成 (${elapsed}s)\n" "$CURRENT_STEP" "$TOTAL_STEPS" "$desc"
    rm -f "$log_file"
    return 0
  else
    printf "\r${RED}  [%d/%d] ❌${NC} %s — 失败 (${elapsed}s)\n\n" "$CURRENT_STEP" "$TOTAL_STEPS" "$desc"
    echo -e "${RED}──── 错误日志 ────${NC}"
    cat "$log_file"
    echo -e "${RED}──────────────────${NC}"
    rm -f "$log_file"
    exit 1
  fi
}

# ──────────────────────────────────────────────
# 各步骤函数 (输出会进日志，无需自行 log/warn)
# ──────────────────────────────────────────────

# ---------- 安装基础系统工具（lsof, curl, git）----------
install_system_tools() {
  local need_lsof=false need_curl=false need_git=false
  command -v lsof &>/dev/null || need_lsof=true
  command -v curl &>/dev/null || need_curl=true
  command -v git  &>/dev/null || need_git=true

  if [ "$need_lsof" = false ] && [ "$need_curl" = false ] && [ "$need_git" = false ]; then
    return 0
  fi

  if command -v apt &>/dev/null; then
    apt update -qq 2>/dev/null
    $need_lsof && apt install -y -qq lsof
    $need_curl && apt install -y -qq curl
    $need_git  && apt install -y -qq git
  elif command -v dnf &>/dev/null; then
    $need_lsof && dnf install -y lsof
    $need_curl && dnf install -y curl
    $need_git  && dnf install -y git
  elif command -v yum &>/dev/null; then
    $need_lsof && yum install -y lsof
    $need_curl && yum install -y curl
    $need_git  && yum install -y git
  elif command -v apk &>/dev/null; then
    $need_lsof && apk add --no-cache lsof
    $need_curl && apk add --no-cache curl
    $need_git  && apk add --no-cache git
  elif command -v pacman &>/dev/null; then
    $need_lsof && pacman -S --noconfirm lsof
    $need_curl && pacman -S --noconfirm curl
    $need_git  && pacman -S --noconfirm git
  fi
}

# ---------- 安装编译工具（node-pty / bcrypt 原生模块需要）----------
install_build_tools() {
  if command -v make &>/dev/null && command -v gcc &>/dev/null && command -v python3 &>/dev/null; then
    return 0
  fi
  if command -v apt &>/dev/null; then
    apt install -y -qq build-essential python3
  elif command -v dnf &>/dev/null; then
    dnf install -y make gcc gcc-c++ python3
  elif command -v yum &>/dev/null; then
    yum install -y make gcc gcc-c++ python3
  elif command -v apk &>/dev/null; then
    apk add --no-cache build-base python3
  elif command -v pacman &>/dev/null; then
    pacman -S --noconfirm base-devel python3
  fi
}

# ---------- 端口检测 ----------
find_port() {
    local port=${1:-3000}
    while lsof -i ":$port" &>/dev/null; do
        port=$((port + 1))
        if [ $port -gt 3020 ]; then
            echo "端口范围 3000-3020 全部被占用，请手动指定" >&2
            exit 1
        fi
    done
    echo "$port"
}

# ---------- 拉取代码 ----------
setup_code() {
    if [ -f "$PROJECT_DIR/server/index.js" ]; then
        return 0
    fi

    if [ -z "$GIT_REPO" ]; then
        echo "未设置 GIT_REPO 环境变量，且当前目录无项目代码" >&2
        echo "  用法示例:" >&2
        echo "    GIT_REPO=http://your-git-server/repo.git ./deploy.sh" >&2
        echo "    GIT_REPO=git@github.com:user/repo.git ./deploy.sh" >&2
        exit 1
    fi

    PARENT_DIR="$(dirname "$PROJECT_DIR")"
    echo "克隆代码: $GIT_REPO ($GIT_BRANCH)"

    TMP_CLONE=$(mktemp -d -p "$PARENT_DIR" claude-web-ui-tmp.XXXXXX)
    git clone -b "$GIT_BRANCH" "$GIT_REPO" "$TMP_CLONE"
    shopt -s dotglob
    mv "$TMP_CLONE"/* "$PROJECT_DIR"/ 2>/dev/null || true
    shopt -u dotglob
    rmdir "$TMP_CLONE" 2>/dev/null || true
    cd "$PROJECT_DIR"
}

# ---------- 安装 Node.js ----------
install_node() {
    local need_install=false

    if command -v node &>/dev/null && command -v npm &>/dev/null; then
        local major
        major=$(node -v | sed 's/v\([0-9]*\).*/\1/')
        if [ "$major" -ge 20 ]; then
            echo "Node.js $(node -v) / npm $(npm -v) 已就绪"
            return 0
        fi
        echo "Node.js $(node -v) 版本过低 (需要 >= 20)，升级中..."
        need_install=true
    else
        need_install=true
    fi

    if [ "$need_install" = true ]; then
        # Fix broken dpkg state first
        if command -v apt &>/dev/null; then
            dpkg --configure -a 2>/dev/null || true
            if dpkg --audit 2>/dev/null | grep -q .; then
                echo "检测到损坏的软件包，尝试修复..."
                apt --fix-broken install -y 2>/dev/null || true
                dpkg -l 2>/dev/null | grep -E '^.[ci]F|^.[ci]U' | awk '{print $2}' | while read -r pkg; do
                    echo "强制移除损坏的包: $pkg"
                    dpkg --remove --force-remove-reinstreq "$pkg" 2>/dev/null || true
                done
                apt --fix-broken install -y 2>/dev/null || true
            fi
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
        elif command -v pacman &>/dev/null; then
            pacman -S --noconfirm nodejs npm
        else
            echo "无法识别包管理器，请手动安装 Node.js >= 20" >&2
            echo "  下载: https://nodejs.org/" >&2
            exit 1
        fi
    fi

    # Verify the installed version
    if command -v node &>/dev/null; then
        local new_major
        new_major=$(node -v | sed 's/v\([0-9]*\).*/\1/')
        if [ "$new_major" -lt 20 ]; then
            echo "Node.js 升级失败，当前版本 $(node -v) 仍低于 20" >&2
            exit 1
        fi
    else
        echo "Node.js 安装失败" >&2
        exit 1
    fi
    echo "Node.js $(node -v) / npm $(npm -v) 安装完成"
}

# ---------- 安装项目依赖 ----------
install_deps() {
    cd "$PROJECT_DIR"
    npm install --production --registry=https://registry.npmmirror.com
    npm rebuild node-pty bcrypt --registry=https://registry.npmmirror.com || echo "注意: 部分原生模块编译失败，终端功能可能不可用"
    cd client && npm install --registry=https://registry.npmmirror.com
    cd "$PROJECT_DIR"
}

# ---------- 确保 SDK 二进制可正常运行 ----------
ensure_sdk_binary() {
    cd "$PROJECT_DIR"

    local sdk_bin=""
    for candidate in \
        node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude \
        node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude \
        node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude \
        node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64-musl/claude \
    ; do
        if [ -f "$candidate" ]; then
            sdk_bin="$candidate"
            break
        fi
    done

    if [ -z "$sdk_bin" ]; then
        echo "注意: 未找到 SDK 二进制文件，请手动安装 @anthropic-ai/claude-agent-sdk"
        return 0
    fi

    echo "检查 SDK 二进制: $sdk_bin"

    # Fix permissions
    if [ ! -x "$sdk_bin" ]; then
        chmod +x "$sdk_bin"
    fi

    # Quick smoke test
    if "$sdk_bin" --version &>/dev/null; then
        echo "SDK 自检通过 ($("$sdk_bin" --version 2>&1 | head -1))"
    else
        echo "注意: SDK 二进制 --version 测试失败，可能是动态库缺失"
        if command -v ldd &>/dev/null; then
            echo "缺失的依赖库:"
            ldd "$sdk_bin" 2>&1 | grep "not found" || true
        fi
    fi

    # Verify Node can load the SDK module
    local sdk_ok
    sdk_ok=$(cd "$PROJECT_DIR" && node -e "
        try {
            require.resolve('@anthropic-ai/claude-agent-sdk');
            console.log('OK');
        } catch(e) {
            console.log('FAIL:' + e.message);
        }
    " 2>&1)
    if [ "$sdk_ok" = "OK" ]; then
        echo "SDK Node 模块加载正常"
    else
        echo "注意: SDK Node 模块加载失败: $sdk_ok"
    fi

    # If binary doesn't work, try to fix missing libs
    if "$sdk_bin" --version &>/dev/null; then
        return 0
    fi

    local missing_libs=""
    if command -v ldd &>/dev/null; then
        missing_libs=$(ldd "$sdk_bin" 2>&1 | grep "not found" || true)
    fi

    if [ -n "$missing_libs" ]; then
        echo "检测到缺失的动态库:"
        echo "$missing_libs"

        if command -v apt &>/dev/null; then
            apt update -qq 2>/dev/null
            echo "$missing_libs" | grep -q "libstdc++" && apt install -y -qq libstdc++6
            echo "$missing_libs" | grep -q "libc.so\|libc.musl\|ld-musl" && apt install -y -qq musl 2>/dev/null || true
            echo "$missing_libs" | grep -q "libgcc_s" && apt install -y -qq libgcc-s1
            echo "$missing_libs" | grep -q "not found" && apt install -y -qq libc6 libgcc-s1 libstdc++6 2>/dev/null || true
        elif command -v dnf &>/dev/null; then
            dnf install -y glibc libstdc++ libgcc || true
        elif command -v yum &>/dev/null; then
            yum install -y glibc libstdc++ libgcc || true
        elif command -v apk &>/dev/null; then
            apk add --no-cache gcompat libstdc++ || true
        fi

        if "$sdk_bin" --version &>/dev/null; then
            echo "SDK 二进制修复成功"
            return 0
        fi

        echo "SDK 二进制修复后仍然无法启动，诊断信息:"
        echo "  - 系统架构: $(uname -m)"
        echo "  - 内核版本: $(uname -r)"
        if command -v ldd &>/dev/null; then
            echo "  - 依赖库状态:"
            ldd "$sdk_bin" 2>&1 | head -20
        fi
        echo "注意: 缺少 musl 相关库，请尝试手动安装 musl-dev"
    else
        if command -v getenforce &>/dev/null && [ "$(getenforce)" = "Enforcing" ]; then
            echo "注意: SELinux 处于 Enforcing 模式，可能阻止了 SDK 二进制"
        fi
        echo "无法确定原因，请手动测试: $sdk_bin --version"
    fi
}

# ---------- 构建前端 ----------
build_client() {
    cd "$PROJECT_DIR/client"
    npm run build
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

    nohup node server.js > server.log 2>&1 &
    NEW_PID=$!
    echo "$NEW_PID" > .pid

    sleep 3
    if lsof -i ":$port" &>/dev/null; then
        SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
        [ -z "$SERVER_IP" ] && SERVER_IP="localhost"
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
        echo "服务启动失败，查看日志: $PROJECT_DIR/server.log"
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

run_step "安装系统工具 (lsof/curl/git)" install_system_tools

PORT=$(find_port "${1:-3000}")
echo -e "${GREEN}  ✅${NC} 使用端口: ${CYAN}${PORT}${NC}"

run_step "安装编译工具 (make/gcc/python3)" install_build_tools
run_step "安装 Node.js 22.x" install_node
run_step "拉取代码" setup_code
run_step "安装项目依赖 (npm install)" install_deps
run_step "检查 SDK 二进制" ensure_sdk_binary
run_step "构建前端" build_client

start_server "$PORT"
