---
name: vuln-scanning
displayName: 安全漏洞扫描
description: ''
icon: 🧪
category: 安全
model: null
allowedTools: []
deniedTools: []
permissionMode: bypassPermissions
version: 1.0.0
author: admin
---

# 🔐 全量自动化扫描技能 v3.0

## 功能概述

四阶段全量扫描：Nuclei Web 漏洞 → 弱口令检测（14种协议） → 未授权检测（16种服务） → 合并报告。

```
Phase 1: Nuclei  (CVE/KEV/配置缺陷/信息泄露/默认口令) + 可达性预检 + 代理 + 断点续扫
Phase 2: Hydra   (SSH/FTP/Telnet/SMB/RDP/VNC/MySQL/PostgreSQL/Tomcat/Jenkins/HTTP-Basic + SNMP/Redis/MongoDB)
Phase 3: Curl    (22种服务: 8种数据库 + Docker/K8s/SpringBoot/Jenkins/Kibana/Swagger/.git/.env)
Phase 4: Report  (Markdown + HTML + Webhook通知 + 耗时统计 + 失败清单)
```

---

## Phase 2 弱口令检测原理

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐    ┌─────────────┐
│ 识别目标服务  │───▶│ 构造认证请求  │───▶│ 逐条尝试口令  │───▶│ 判断登录结果  │
│ (端口/协议)  │    │ (协议交互)    │    │ (字典遍历)    │    │ (成功/失败)  │
└─────────────┘    └──────────────┘    └──────────────┘    └─────────────┘
```

### 字典生成引擎（四类来源）

| 来源 | 说明 | 示例 |
|------|------|------|
| ① 静态字典 | Top 高频弱口令 | admin/admin123/password/123456/root/redis/foobared |
| ② 规则变换 | 基础词自动衍生变形 | password→P@ssw0rd/Password123/Password@2026 |
| ③ 信息定制 | 目标域名+年份组合 | cloudwalk→CloudWalk@2026/cw123/CW@2026 |
| ④ 泄露口令库 | SecLists Top1000 动态拉取（超时10s回退内置） | |

### 字典规模

```
用户名: 30+ 条（root/admin/guest + 目标特征用户名）
密码:   1000+ 条（静态60 + 规则200+ + 定制100+ + SecLists动态拉取）
```

---

## 🛡️ Phase 2 对抗策略（防锁定 + 智能裁剪）

```
执行顺序:
  Pass 1: 默认账号检测 → 每个服务只试1-2条出厂默认凭证
  Pass 2: 字典轮询     → -u 交替用户: pass1→全user → pass2→全user

核心防护:
  -u  轮询用户:   pass1试user1,user2,user3 而非 pass1,pass2,pass3连续试user1
  -W  请求间隔:   每次登录间隔 1-2 秒
  -t  单线程:     每个目标单线程顺序尝试
  -f  命中即停:   找到第一个弱口令立即停止该目标
  trap EXIT:     脚本退出自动清理/tmp临时文件
```

### 防御机制 vs 扫描器应对

| 防御机制 | 说明 | 扫描器应对 |
|----------|------|-----------|
| 账号锁定 | 连续失败N次锁定账号 | `-u` 交替不同账号，分散失败次数 |
| 速率限制 | 限制单位时间请求数 | `-W 1` 每次请求间隔1秒 |
| IP黑名单 | 封禁异常IP | 单线程低频率避免触发 |
| 双因素认证 | 需要第二因素验证 | 跳过（弱口令仅覆盖单因素） |

### 安全运行模式

| 模式 | 命令 | 每服务尝试 | 适用场景 |
|------|------|:--:|------|
| 🛡️ 安全模式 | `--safe-mode` | 6 次 | **生产环境** |
| 📐 标准模式 | 默认 | ≤10 次 | 测试环境 |
| ⚡ 跳过 | `--no-brute` | 0 | 跳过 |

---

## 使用方式

```bash
# 安全模式 — 生产环境推荐
bash full-scan.sh -l targets.txt --safe-mode

# 完整扫描（有确认提示）
bash full-scan.sh -l targets.txt

# 只做 Web 漏洞扫描
bash full-scan.sh -l targets.txt --phase1-only

# 只做弱口令（安全模式）
bash full-scan.sh -l targets.txt --phase2-only --safe-mode

# 使用代理
bash full-scan.sh -l targets.txt --proxy socks5://127.0.0.1:1080

# 断点续扫
bash full-scan.sh --resume scan_20260703_150000

# 排除特定目标
bash full-scan.sh -l targets.txt --exclude exclude.txt

# HTML 报告 + Webhook 通知
bash full-scan.sh -l targets.txt --html-report --notify-webhook https://hooks.slack.com/xxx

# 完整参数
bash full-scan.sh -l targets.txt -s critical,high -tags cve,kev --safe-mode -y --debug
```

### 参数说明

| 参数 | 必填 | 默认值 | 说明 |
|------|:--:|------|------|
| `-l` | 是 | — | 目标列表（格式: `IP:PORT` 或 `URL`） |
| `-s` | 否 | `critical,high,medium` | Nuclei 严重级别 |
| `-tags` | 否 | `cve,kev,vkev,misconfig,exposure` | Nuclei 模板标签 |
| `-o` | 否 | `scan_result_时间戳` | 输出文件名前缀 |
| `-timeout` | 否 | `30` | 模板更新超时秒数 |
| `-rate` | 否 | `50` | Nuclei 每秒请求数 |
| `--proxy` | 否 | — | 🔌 代理 (http://或socks5://) |
| `--resume` | 否 | — | 🔄 从目录恢复中断扫描 |
| `--exclude` | 否 | — | 🚫 排除列表文件 |
| `--debug` | 否 | — | 🐛 调试日志 |
| `--html-report` | 否 | — | 📄 生成 HTML 报告 |
| `--notify-webhook` | 否 | — | 📢 扫完后 POST 到此 URL |
| `--skip-update` | 否 | — | 跳过 Nuclei 模板更新 |
| `--user-dict` | 否 | 内置字典 | 弱口令用户名字典 |
| `--pass-dict` | 否 | 内置字典 | 弱口令密码字典 |
| `--safe-mode` | 否 | — | 🛡️ 安全模式：每用户最多2个密码 |
| `--max-attempts` | 否 | `10` | 🛡️ 每服务最大尝试次数 |
| `--phase1-only` | 否 | — | 只执行 Phase 1 (Nuclei) |
| `--phase2-only` | 否 | — | 只执行 Phase 2 (弱口令) |
| `-y` | 否 | — | 跳过交互确认 |
| `--no-brute` | 否 | — | 跳过弱口令扫描 |

---

## 脚本内容

```bash
#!/bin/bash
# ============================================================
# 全量自动化扫描脚本 v3.0
# Phase 1: Nuclei  Web漏洞扫描  (+ 目标预检 + 代理 + 断点续扫)
# Phase 2: Hydra   弱口令检测   (+ FTP/Telnet/Redis/Mongo/HTTP-Basic/SNMP)
# Phase 3: Curl    未授权检测   (+ Docker/K8s/SpringBoot/Jenkins/Kibana/Swagger)
# Phase 4: Report  合并报告     (+ HTML报告 + 耗时统计 + 失败清单)
# ============================================================

set -e

# ============================================================
# 0. 颜色 & 全局变量 & trap清理
# ============================================================
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; MAGENTA='\033[0;35m'; NC='\033[0m'

log_info()  { echo -e "${BLUE}[INFO]${NC}  $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
log_err()   { echo -e "${RED}[ERROR]${NC} $1"; }
log_found() { echo -e "${RED}[FOUND]${NC} $1"; }
log_phase() { echo -e "${MAGENTA}[PHASE]${NC} $1"; }
log_debug() { [ "$DEBUG" = true ] && echo -e "${CYAN}[DEBUG]${NC} $1"; }

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SCAN_START=$(date +%s)
SCAN_DIR="scan_${TIMESTAMP}"
DEBUG=false

# trap 确保退出时清理临时文件
cleanup() {
    rm -f /tmp/nuclei_combo_$$_* /tmp/nuclei_t2_$$_* /tmp/nuclei_precheck_$$.txt 2>/dev/null
    log_debug "临时文件已清理"
}
trap cleanup EXIT

mkdir -p "$SCAN_DIR"

# ============================================================
# 1. 参数解析
# ============================================================
TARGET_FILE=""
EXCLUDE_FILE=""
SEVERITY="critical,high,medium"
TAGS="cve,kev,vkev,misconfig,exposure"
OUTPUT_PREFIX="scan_result"
UPDATE_TIMEOUT=30
RATE_LIMIT=50
CONCURRENCY=25
SKIP_UPDATE=false
HYDRA_THREADS=4
USER_DICT=""
PASS_DICT=""
PHASE1_ONLY=false
PHASE2_ONLY=false
NO_BRUTE=false
SAFE_MODE=false
MAX_ATTEMPTS=10
SKIP_CONFIRM=false
PROXY=""
RESUME_FILE=""
NOTIFY_WEBHOOK=""
HTML_REPORT=false
AUTO_MODE=false
PHASE1_NEEDED=true
PHASE2_NEEDED=true
PHASE3_NEEDED=true

usage() {
    cat << EOF
用法: $0 -l FILE [选项]

必填:
  -l FILE             目标列表（每行一个 IP:PORT 或 URL）

Nuclei 选项:
  -s SEVERITY         严重级别 (默认: critical,high,medium)
  -tags TAGS          模板标签 (默认: cve,kev,vkev,misconfig,exposure)
  -rate N             每秒请求限制 (默认: 50)
  --skip-update       跳过模板更新
  --phase1-only       只执行 Phase 1 (Nuclei)

弱口令选项:
  --user-dict FILE    用户名字典
  --pass-dict FILE    密码字典
  --hydra-threads N   Hydra 线程数 (默认: 4)
  --max-attempts N    每个服务最大尝试次数 (默认: 10, 防止锁死)
  --safe-mode         安全模式: 每用户最多试2个密码 (推荐生产环境)
  --no-brute          跳过弱口令扫描
  --phase2-only       只执行 Phase 2 (弱口令)

网络 & 断点:
  --proxy URL         代理 (如 http://127.0.0.1:8080 或 socks5://127.0.0.1:1080)
  --resume DIR        从目录恢复中断的扫描
  --exclude FILE      排除列表（跳过这些目标）

输出 & 通知:
  -o PREFIX           输出文件名前缀 (默认: scan_result)
  --html-report       额外生成 HTML 报告
  --auto              智能调度: 根据端口指纹自动跳过无关阶段
  --notify-webhook    扫完后 POST 结果摘要到此 URL（如企业微信/钉钉/Slack）
  --debug             输出调试日志
  -y|--yes            跳过交互确认
  -timeout SEC        模板更新超时 (默认: 30)
EOF
    exit 1
}

while [[ $# -gt 0 ]]; do
    case $1 in
        -l) TARGET_FILE="$2"; shift 2 ;;
        -s) SEVERITY="$2"; shift 2 ;;
        -tags) TAGS="$2"; shift 2 ;;
        -o) OUTPUT_PREFIX="$2"; shift 2 ;;
        -timeout) UPDATE_TIMEOUT="$2"; shift 2 ;;
        -rate) RATE_LIMIT="$2"; shift 2 ;;
        -concurrency) CONCURRENCY="$2"; shift 2 ;;
        --hydra-threads) HYDRA_THREADS="$2"; shift 2 ;;
        --max-attempts) MAX_ATTEMPTS="$2"; shift 2 ;;
        --user-dict) USER_DICT="$2"; shift 2 ;;
        --pass-dict) PASS_DICT="$2"; shift 2 ;;
        --proxy) PROXY="$2"; shift 2 ;;
        --resume) RESUME_FILE="$2"; shift 2 ;;
        --exclude) EXCLUDE_FILE="$2"; shift 2 ;;
        --notify-webhook) NOTIFY_WEBHOOK="$2"; shift 2 ;;
        --skip-update) SKIP_UPDATE=true; shift ;;
        --phase1-only) PHASE1_ONLY=true; shift ;;
        --phase2-only) PHASE2_ONLY=true; shift ;;
        --no-brute) NO_BRUTE=true; shift ;;
        --safe-mode) SAFE_MODE=true; shift ;;
        --html-report) HTML_REPORT=true; shift ;;
        --auto) AUTO_MODE=true; shift ;;
        --debug) DEBUG=true; shift ;;
        -y|--yes) SKIP_CONFIRM=true; shift ;;
        -h|--help) usage ;;
        *) echo "未知参数: $1"; usage ;;
    esac
done

if [ -z "$TARGET_FILE" ] && [ -z "$RESUME_FILE" ]; then
    log_err "必须指定 -l 或 --resume 参数"; usage
fi
if [ -n "$TARGET_FILE" ] && [ ! -f "$TARGET_FILE" ]; then
    log_err "目标文件不存在: $TARGET_FILE"; exit 1
fi
if [ -n "$EXCLUDE_FILE" ] && [ ! -f "$EXCLUDE_FILE" ]; then
    log_err "排除文件不存在: $EXCLUDE_FILE"; exit 1
fi

# 断点续扫: 从已有目录恢复
if [ -n "$RESUME_FILE" ] && [ -d "$RESUME_FILE" ]; then
    SCAN_DIR="$RESUME_FILE"
    log_info "断点续扫模式: ${SCAN_DIR}"
    # 检查已有文件
    [ -f "$SCAN_DIR/${OUTPUT_PREFIX}_phase1_nuclei.json" ] && log_ok "跳过 Phase 1 (已完成)" && PHASE1_DONE=true
    [ -f "$SCAN_DIR/${OUTPUT_PREFIX}_phase2_weakpass.txt" ] && log_ok "跳过 Phase 2 (已完成)" && PHASE2_DONE=true
    [ -f "$SCAN_DIR/${OUTPUT_PREFIX}_phase3_unauth.txt" ] && log_ok "跳过 Phase 3 (已完成)" && PHASE3_DONE=true
    # 需要从备份恢复目标文件
    if [ -f "$SCAN_DIR/targets.txt" ]; then
        TARGET_FILE="$SCAN_DIR/targets.txt"
    fi
fi

# 备份目标文件到扫描目录
if [ -n "$TARGET_FILE" ]; then
    cp "$TARGET_FILE" "$SCAN_DIR/targets.txt"
fi

# 排除逻辑
if [ -n "$EXCLUDE_FILE" ]; then
    log_info "应用排除列表: ${EXCLUDE_FILE}"
    TARGET_FILE_FILTERED="$SCAN_DIR/targets_filtered.txt"
    grep -vFf "$EXCLUDE_FILE" "$TARGET_FILE" > "$TARGET_FILE_FILTERED" 2>/dev/null || true
    TARGET_FILE="$TARGET_FILE_FILTERED"
fi

# Nuclei 代理
NUCLEI_PROXY=""
if [ -n "$PROXY" ]; then
    NUCLEI_PROXY="-proxy $PROXY"
    log_info "代理: ${PROXY}"
fi

# ============================================================
# 0.5 目标可达性预检
# ============================================================
precheck_targets() {
    echo ""
    log_info "目标可达性预检..."
    local precheck_out="$SCAN_DIR/precheck.txt"
    local reachable="$SCAN_DIR/targets_reachable.txt"
    > "$precheck_out"
    > "$reachable"

    local total=0; local ok=0; local fail=0

    while IFS= read -r line; do
        [[ -z "$line" || "$line" =~ ^# ]] && continue
        total=$((total + 1))
        local host=""; local port=""
        if [[ "$line" =~ ^https?:// ]]; then
            host=$(echo "$line" | sed -E 's|https?://||' | cut -d: -f1)
            port=$(echo "$line" | sed -E 's|https?://||' | cut -d: -f2 -s)
            [ -z "$port" ] && port="443"
            local proto=$(echo "$line" | grep -q "^https" && echo "https" || echo "http")
            if curl -sk --connect-timeout 5 -o /dev/null -w "%{http_code}" "${proto}://${host}:${port}" 2>/dev/null | grep -qE '^[0-9]+$'; then
                echo "$line" >> "$reachable"
                ok=$((ok + 1))
            else
                echo "UNREACHABLE|$line" >> "$precheck_out"
                fail=$((fail + 1))
            fi
        else
            host=$(echo "$line" | cut -d: -f1)
            port=$(echo "$line" | cut -d: -f2 -s)
            [ -z "$port" ] && port="80"
            if timeout 3 bash -c "echo >/dev/tcp/${host}/${port}" 2>/dev/null; then
                echo "$line" >> "$reachable"
                ok=$((ok + 1))
            else
                echo "UNREACHABLE|$line" >> "$precheck_out"
                fail=$((fail + 1))
            fi
        fi
    done < "$TARGET_FILE"

    echo "  总计: ${total}  |  可达: ${ok}  |  不可达: ${fail}"
    if [ $fail -gt 0 ]; then
        log_warn "${fail} 个目标不可达，已记录到 ${precheck_out}"
    fi

    # 如果全部不可达，退出
    if [ $ok -eq 0 ]; then
        log_err "所有目标均不可达，请检查网络/代理"
        exit 1
    fi

    # 用可达列表替换
    TARGET_FILE="$reachable"
    cp "$reachable" "$SCAN_DIR/targets.txt"
}
precheck_targets

# ============================================================
# 2. 弱口令字典生成（四类来源）
#   ① 静态字典：Top 高频弱口令
#   ② 规则变换：基于基础口令衍生变形
#   ③ 信息定制：从目标域名提取关键词 + 年份组合
#   ④ 泄露口令库：SecLists Top1000 动态拉取（超时10s回退内置）
#
#   策略：高频优先 → 命中即停(-f) → 低并发(-t 2) → 防锁死
# ============================================================
build_default_dicts() {
    local dict_dir="$SCAN_DIR/dicts"
    mkdir -p "$dict_dir"

    # ── 提取目标特征（用于信息定制） ──
    local target_keywords=""
    if [ -f "$TARGET_FILE" ]; then
        target_keywords=$(grep -oP '(?<=://)[^/:]+|(?<=\.)[a-zA-Z0-9-]+(?=\.com|\.cn|\.net|\.org)' "$TARGET_FILE" 2>/dev/null | \
                          grep -vP '^\d+\.\d+\.\d+\.\d+$' | tr '.' '\n' | tr '-' '\n' | \
                          awk 'length($0) >= 2 && $0 !~ /^(com|cn|net|org|gov|edu|www|http|https|mail|ftp|smtp|pop|imap|dns|ns[0-9]?)$/' | \
                          sort -u | head -10 | tr '\n' ' ')
        local bare_ips=$(grep -oP '\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}' "$TARGET_FILE" 2>/dev/null | sort -u | tr '\n' ' ')
    fi
    local current_year=$(date +%Y)
    local last_year=$((current_year - 1))
    local next_year=$((current_year + 1))

    # ── 用户名字典 ──
    if [ -z "$USER_DICT" ] || [ ! -f "$USER_DICT" ]; then
        USER_DICT="$dict_dir/users.txt"
        cat > "$USER_DICT" << 'USEREOF'
root
admin
administrator
guest
user
test
sa
system
manager
operator
supervisor
webmaster
mysql
postgres
oracle
tomcat
jenkins
deploy
ubuntu
centos
debian
ec2-user
ftpuser
nobody
USEREOF

        for kw in $target_keywords; do
            kw_len=${#kw}
            [ $kw_len -lt 2 ] && continue
            [ $kw_len -gt 20 ] && continue
            echo "$kw" >> "$USER_DICT"
            [ $kw_len -le 10 ] && echo "${kw}admin" >> "$USER_DICT"
            [ $kw_len -le 10 ] && echo "${kw}user" >> "$USER_DICT"
            local abbr=$(echo "$kw" | sed 's/[aeiou]//g' | head -c 3)
            [ ${#abbr} -ge 2 ] && [ ${#abbr} -le 5 ] && echo "$abbr" >> "$USER_DICT"
        done

        log_info "用户名字典: $(wc -l < "$USER_DICT") 条 (含目标特征)"
    fi

    # ── 密码字典（四类来源合并，高频在前） ──
    if [ -z "$PASS_DICT" ] || [ ! -f "$PASS_DICT" ]; then
        PASS_DICT="$dict_dir/pass.txt"

        {
            # ====== ① 静态字典：Top 高频弱口令 ======
            cat << 'STATICEOF'
admin
admin123
admin123456
admin888
password
Password
password123
Password123
P@ssw0rd
P@ssword
passwd
pass
root
root123
root123456
root888
123456
12345678
123456789
1234567890
1234
12345
111111
000000
88888888
666666
123123
qwerty
QWERTY
qwerty123
qwer1234
qazwsx
1qaz2wsx
1qaz@WSX
abc123
ABCD1234
iloveyou
monkey
dragon
master
hello
letmein
welcome
Welcome
test
test123
guest
guest123
changeme
changeme123
default
redis
foobared
mongo
mongodb
snmp
public
private
STATICEOF

            # ====== ② 规则变换：基础口令衍生 ======
            local base_words="password admin root test guest cloud cw manager system server"
            local suffixes="123 123456 888 2024 2025 2026 @2024 @2025 @2026 123! @123 #123 !@# 1 01 001"
            local prefixes="Admin Root Test Cloud CW"

            for w in $base_words; do
                for s in $suffixes; do
                    echo "${w}${s}"
                    echo "${w}${s}" | sed 's/.*/\u&/'
                done
            done
            for w in $prefixes; do
                for s in 123 123456 888 @2024 @2025 @2026; do
                    echo "${w}${s}"
                done
            done

            for w in admin password root; do
                echo "${w}@123"; echo "${w}#123"; echo "${w}.123"
                echo "${w}@2024"; echo "${w}@2025"; echo "${w}@2026"
                echo "$(echo ${w:0:1} | tr '[:lower:]' '[:upper:]')${w:1}@123"
                echo "$(echo ${w:0:1} | tr '[:lower:]' '[:upper:]')${w:1}#123"
            done

            # ====== ③ 信息定制：目标特征 + 年份 ======
            local years="$last_year $current_year $next_year"
            for kw in $target_keywords; do
                [ ${#kw} -lt 2 ] && continue
                [ ${#kw} -gt 20 ] && continue
                local kw_cap="$(echo ${kw:0:1} | tr '[:lower:]' '[:upper:]')${kw:1}"
                echo "${kw}"; echo "${kw_cap}"
                echo "${kw}123"; echo "${kw_cap}123"
                echo "${kw}123456"; echo "${kw_cap}123456"
                echo "${kw}888"; echo "${kw_cap}888"
                echo "${kw}@123"; echo "${kw_cap}@123"
                echo "${kw}#123"; echo "${kw_cap}#123"
                echo "${kw}@123456"; echo "${kw}admin"
                for y in $years; do
                    echo "${kw}@${y}"; echo "${kw_cap}@${y}"
                    echo "${kw}${y}"; echo "${kw_cap}${y}"
                done
            done

            # ====== ④ 泄露口令库：SecLists Top1000 动态拉取（超时10s回退内置）======
            local leak_cache="/tmp/nuclei_leak_top1000.cache"
            local leak_fetched=false

            if [ -f "$leak_cache" ] && [ $(find "$leak_cache" -mmin -1440 2>/dev/null | wc -l) -gt 0 ]; then
                cat "$leak_cache"
                leak_fetched=true
            else
                log_info "  ④ 正在拉取 SecLists Top1000..."
                if timeout 10 curl -sL \
                    "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials/10-million-password-list-top-1000.txt" \
                    -o "$leak_cache" 2>/dev/null && [ -s "$leak_cache" ]; then
                    local fetched=$(wc -l < "$leak_cache")
                    log_info "    拉取成功: ${fetched} 条（缓存24h）"
                    cat "$leak_cache"
                    leak_fetched=true
                else
                    log_warn "    拉取超时/失败，回退内置泄露库"
                    rm -f "$leak_cache"
                fi
            fi

            if ! $leak_fetched; then
                cat << 'LEAKFALLBACK'
123456
password
12345678
qwerty
123456789
12345
1234
111111
1234567
sunshine
qwerty123
iloveyou
princess
admin
welcome
666666
abc123
football
123123
monkey
654321
!@#$%^&*
charlie
aa123456
donald
password1
qwerty12345
1234567890
letmein
password123
dragon
baseball
adobe123
admin123
trustno1
hottie
master
ashley
batman
starwars
access
flower
shadow
michael
lovely
qazwsx
zaq12wsx
1q2w3e4r
1qaz2wsx
Passw0rd
Password1
p@ssword
pass@123
Admin@123
Root@123
test@123
mysql
oracle
postgres
superman
jordan
harley
andrew
joshua
maggie
matthew
summer
ginger
justin
george
robert
buster
soccer
tigger
michelle
pepper
thomas
daniel
jessica
jennifer
william
cookie
nicole
hunter
killer
sandra
chelsea
joseph
amanda
asdfgh
jessie
miller
peanut
thunder
biteme
victory
ranger
yankees
phantom
hockey
turtle
midnight
brandon
taylor
snoopy
loveyou
dallas
passion
samantha
winner
golfer
magic
love123
iloveyou1
dragon1
master1
password2
admin1
welcome1
monkey1
shadow1
michael1
sunshine1
princess1
batman1
starwars1
flower1
lovely1
trustno1
access1
passw0rd
p@ssw0rd
P@ssword
Passw0rd!
password!
Password!
PASSWORD
Pa$$w0rd
admin2024
admin2025
admin2026
admin@123
admin#123
admin123!
admin1234
admin12345
root2024
root2025
root2026
root@123
root#123
root123!
root1234
test2024
test2025
test2026
guest2024
guest2025
guest2026
user2024
user2025
user2026
system2024
system2025
manager2024
manager2025
operator2024
operator2025
webmaster2024
webmaster2025
mysql2024
mysql2025
mysql@123
oracle2024
postgres2024
tomcat1
tomcat2024
tomcat@123
jenkins1
jenkins2024
jenkins@123
deploy1
deploy2024
deploy@123
ubuntu1
ubuntu2024
ubuntu@123
centos1
centos2024
centos@123
debian1
debian2024
nobody1
nobody2024
ftpuser1
ftpuser2024
sunshine1
sunshine123
princess1
princess123
abc123!
abc1234
abc12345
123abc
123qwe
qwe123
qweasd
qweasdzxc
asd123
asdf1234
asdfghjkl
zxcvbnm
zxcvbn
1q2w3e
1q2w3e4r5t
qwertyuiop
qwerty1
qwerty!
qwerty@123
football1
football123
baseball1
baseball123
basketball
basketball1
hockey1
soccer1
soccer123
golfer1
tennis
tennis1
swimming
swimming1
running
running1
fitness
fitness1
gym123
workout
workout123
harley1
harley123
mustang
mustang1
corvette
corvette1
ferrari
ferrari1
porsche
porsche1
bmw123
mercedes
mercedes1
toyota
toyota1
honda1
honda123
nissan
nissan1
ford123
chevy1
chevy123
dodge1
dodge123
jeep123
jordan23
jordan123
michael123
james1
james123
john1
john123
david1
david123
william1
william123
richard1
richard123
joseph1
joseph123
thomas1
thomas123
daniel1
daniel123
matthew1
matthew123
anthony1
anthony123
mark1
mark123
steven1
steven123
paul1
paul123
chicken
chicken1
butterfly
butterfly1
purple
purple1
orange
orange1
yellow
yellow1
green1
green123
blue123
blue1234
red123
red1234
black1
black123
white1
white123
silver1
silver123
gold123
gold1234
coffee
coffee1
coffee123
chocolate
chocolate1
cheese
cheese1
pepper1
pepper123
ginger1
ginger123
sugar1
sugar123
honey1
honey123
tiger1
tiger123
lion1
lion123
wolf1
wolf123
eagle1
eagle123
hawk1
hawk123
snake1
snake123
spider
spider1
spider123
freedom
freedom1
liberty
liberty1
victory1
victory123
winner1
winner123
champion
champion1
legend
legend1
rockstar
rockstar1
ninja
ninja1
ninja123
samurai
samurai1
pirate
pirate1
wizard
wizard1
phoenix
phoenix1
griffin
griffin1
raider
raider1
patriot
patriot1
cowboy
cowboy1
cowboy123
bandit
bandit1
outlaw
outlaw1
sheriff
sheriff1
marine
marine1
soldier
soldier1
warrior
warrior1
knight
knight1
king123
king1234
queen1
queen123
prince1
prince123
angel1
angel123
devil1
devil123
demon1
demon123
ghost1
ghost123
zombie
zombie1
vampire
vampire1
werewolf
werewolf1
assassin
assassin1
sniper
sniper1
commando
commando1
mercenary
mercenary1
slayer
slayer1
beast
beast1
monster
monster1
alien
alien1
robot
robot1
cyborg
cyborg1
terminator
terminator1
predator
predator1
wolverine
wolverine1
spiderman
spiderman1
ironman
ironman1
thor123
thor1234
hulk123
hulk1234
batman1
batman123
superman1
superman123
flash1
flash123
arrow1
arrow123
daredevil
daredevil1
punisher
punisher1
deadpool
deadpool1
gambit
gambit1
cyclops
cyclops1
magneto
magneto1
joker1
joker123
riddler
riddler1
penguin
penguin1
catwoman
catwoman1
robin1
robin123
alfred
alfred1
gordon
gordon1
lexluthor
lexluthor1
doomsday
doomsday1
darkseid
darkseid1
thanos1
thanos123
loki1
loki123
odin1
odin123
zeus1
zeus123
apollo
apollo1
ares1
ares123
athena
athena1
hercules
hercules1
merlin
merlin1
excalibur
excalibur1
arthur1
arthur123
lancelot
lancelot1
gawain
gawain1
mordred
mordred1
camelot
camelot1
avalon
avalon1
olympus
olympus1
valhalla
valhalla1
asgard
asgard1
midgard
midgard1
atlantis
atlantis1
el_dorado
shangrila
utopia
utopia1
paradise
paradise1
heaven1
heaven123
nirvana
nirvana1
bliss1
bliss123
zen1
zen123
harmony
harmony1
serenity
serenity1
tranquility
peace1
peace123
love123
love1234
hope123
hope1234
faith1
faith123
dream1
dream123
wish1
wish123
lucky1
lucky123
fortune
fortune1
destiny
destiny1
fate1
fate123
qwerty12
qwerty1234
abcde
abcdef
abcdefg
123321
112233
121212
131313
232323
212121
696969
789456
159753
147258
258369
369258
456123
741852
852963
963852
987654
987654321
q1w2e3r4
zaqxsw
xsw2zaq
!qaz2wsx
#EDC4rfv
qazwsxedc
werty
poiuyt
lkjhgf
mnbvcxz
0987654321
pass123
pass1234
password2
password4
password5
password6
password7
password8
password9
password0
admin2
admin3
admin4
admin5
admin6
admin7
admin8
admin9
admin0
LEAKFALLBACK
            fi
        } | sort -u > "$PASS_DICT"

        local pass_count=$(wc -l < "$PASS_DICT")
        log_info "密码字典: ${pass_count} 条 (静态+规则变换+信息定制+泄露库)"
    fi
}

# ============================================================
# 3. 主流程
# ============================================================

# ── 智能分析：扫描目标指纹，决定执行策略 ──
analyze_targets() {
    local phase1_count=0; local phase2_count=0; local phase3_count=0
    local total=0

    # 端口分类定义
    # Phase 2 端口: 需要弱口令爆破的服务
    local p2_ports="21 22 23 445 3389 5900 5901 5902 3306 5432 8080 18080 7443 6000 8087 8000 8003 7003 9999"
    # Phase 3 端口: 需要未授权检测的服务
    local p3_ports="25 53 123 389 636 873 1099 1433 1521 2049 2375 2376 3000 5601 5984 6379 6443 8443 8500 9000 9001 9090 9200 11211 15672 5672 27017 2181"

    while IFS= read -r line; do
        [[ -z "$line" || "$line" =~ ^# ]] && continue
        total=$((total + 1))

        local port=""
        if [[ "$line" =~ ^https?:// ]]; then
            port=$(echo "$line" | sed -E 's|https?://||' | cut -d: -f2 -s)
            [ -z "$port" ] && port="443"
            # HTTP/HTTPS URL → Phase 1 必须
            phase1_count=$((phase1_count + 1))
        else
            port=$(echo "$line" | cut -d: -f2 -s)
            [ -z "$port" ] && port="80"
        fi

        # 检查端口是否匹配 Phase 2
        for pp in $p2_ports; do
            [ "$port" = "$pp" ] && phase2_count=$((phase2_count + 1)) && break
        done
        # 检查端口是否匹配 Phase 3
        for pp in $p3_ports; do
            [ "$port" = "$pp" ] && phase3_count=$((phase3_count + 1)) && break
        done
        # HTTP URL 没有特定端口的也纳入 Phase 1
        if [[ "$line" =~ ^https?:// ]] && [ -z "$(echo "$line" | cut -d: -f2 -s)" ]; then
            phase1_count=$((phase1_count + 1))
        fi
    done < "$TARGET_FILE"

    # 纠正 Phase 1: 所有 http/https URL 都算
    phase1_count=$(grep -cP '^https?://' "$TARGET_FILE" 2>/dev/null)
    phase1_count=${phase1_count:-0}
    # 非 URL 行但端口为常见 Web 端口也算
    local web_ports_count=$(grep -cP ':(80|443|8080|8443|8000|8003|8087|8888|9999)$' "$TARGET_FILE" 2>/dev/null)
    web_ports_count=${web_ports_count:-0}
    phase1_count=$((phase1_count + web_ports_count))

    echo ""
    echo "  ┌──────────────────────────────────────────┐"
    echo "  │  📊 目标指纹分析                           │"
    printf "  │  总目标: %-3s                              │\n" "$total"
    printf "  │  Phase 1 (Web漏洞):   %-3s 个目标           │\n" "$phase1_count"
    printf "  │  Phase 2 (弱口令):    %-3s 个目标           │\n" "$phase2_count"
    printf "  │  Phase 3 (未授权):    %-3s 个目标           │\n" "$phase3_count"
    echo "  └──────────────────────────────────────────┘"

    if $AUTO_MODE; then
        [ "$phase1_count" -eq 0 ] && PHASE1_NEEDED=false
        [ "$phase2_count" -eq 0 ] && PHASE2_NEEDED=false
        [ "$phase3_count" -eq 0 ] && PHASE3_NEEDED=false
        echo ""
        [ "$PHASE1_NEEDED" = false ] && log_info ">>> 智能跳过 Phase 1: 无 HTTP 目标"
        [ "$PHASE2_NEEDED" = false ] && log_info ">>> 智能跳过 Phase 2: 无爆破型服务端口"
        [ "$PHASE3_NEEDED" = false ] && log_info ">>> 智能跳过 Phase 3: 无检测型服务端口"
        echo ""
    fi
}

main() {
    echo ""
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║     全量自动化扫描 v3.0                                 ║"
    echo "║     Nuclei + 弱口令 + 未授权 + Docker/K8s + 报告        ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo ""
    log_info "扫描时间: $(date '+%Y-%m-%d %H:%M:%S')"
    log_info "目标文件: ${TARGET_FILE} ($(wc -l < $TARGET_FILE) 个目标)"
    log_info "输出目录: ${SCAN_DIR}/"
    [ -n "$PROXY" ] && log_info "代理: ${PROXY}"
    [ "$AUTO_MODE" = true ] && log_info "模式: 智能调度（按端口指纹自动选择阶段）"
    echo ""

    # ── 智能分析：扫描目标指纹，决定执行策略 ──
    analyze_targets

    build_default_dicts

    if $PHASE2_ONLY; then
        phase2_weak_passwords
    elif $PHASE1_ONLY; then
        phase1_nuclei
    else
        [ "$PHASE1_NEEDED" = true ] && [ "$PHASE1_DONE" != true ] && phase1_nuclei || log_info "Phase 1 跳过（无 HTTP 目标）"
        [ "$PHASE2_NEEDED" = true ] && [ "$PHASE2_DONE" != true ] && phase2_weak_passwords || log_info "Phase 2 跳过（无爆破型服务端口）"
        [ "$PHASE3_NEEDED" = true ] && [ "$PHASE3_DONE" != true ] && phase3_unauth_services || log_info "Phase 3 跳过（无检测型服务端口）"
        phase4_generate_report
    fi
}

# ============================================================
# PHASE 1: Nuclei Web 漏洞扫描
# ============================================================
phase1_nuclei() {
    echo ""
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║  PHASE 1/4: Nuclei Web 漏洞扫描                         ║"
    echo "╚══════════════════════════════════════════════════════════╝"

    check_install_nuclei

    if [ "$SKIP_UPDATE" = false ]; then
        update_templates
    else
        log_warn "跳过模板更新"
    fi

    show_nuclei_stats

    local nuclei_out="$SCAN_DIR/${OUTPUT_PREFIX}_phase1_nuclei.json"
    local phase1_start=$(date +%s)
    
    echo ""
    log_phase "开始 Nuclei 扫描..."
    echo ""

    nuclei \
        -l "$TARGET_FILE" \
        -severity "$SEVERITY" \
        -tags "$TAGS" \
        -rl "$RATE_LIMIT" \
        -c "$CONCURRENCY" \
        -timeout 10 \
        -retries 2 \
        -stats \
        -stats-interval 30 \
        -json-export "$nuclei_out" \
        -no-mhe \
        $NUCLEI_PROXY \
        2>&1 | while IFS= read -r line; do
            if echo "$line" | grep -qE "\[critical\]|\[high\]|\[medium\]"; then
                echo -e "  ${RED}🔴${NC} $line"
            fi
        done

    local phase1_end=$(date +%s)
    echo ""
    log_ok "Phase 1 完成! 耗时 $((phase1_end - phase1_start))s"

    if [ -f "$nuclei_out" ]; then
        local total=$(wc -l < "$nuclei_out")
        local crit=$(grep -c '"critical"' "$nuclei_out" 2>/dev/null || echo 0)
        local high=$(grep -c '"high"' "$nuclei_out" 2>/dev/null || echo 0)
        local med=$(grep -c '"medium"' "$nuclei_out" 2>/dev/null || echo 0)
        echo "  Nuclei 发现: ${total} 条 | 🔴${crit} 🟠${high} 🟡${med}"
    fi
}

check_install_nuclei() {
    log_info "检查 Nuclei..."
    if command -v nuclei &>/dev/null; then
        log_ok "Nuclei: $(nuclei -version 2>&1 | head -1)"
        return 0
    fi
    log_warn "Nuclei 未安装，自动安装中..."
    if command -v go &>/dev/null; then
        go install -v github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest
        export PATH="$HOME/go/bin:$PATH"
        log_ok "Nuclei 安装完成"
    else
        log_err "需要 Go 环境，请手动安装: https://go.dev/dl/"
        exit 1
    fi
}

update_templates() {
    log_info "更新 Nuclei 模板 (超时: ${UPDATE_TIMEOUT}s)..."
    if timeout ${UPDATE_TIMEOUT} nuclei -update-templates 2>&1; then
        log_ok "模板更新成功"
    else
        log_warn "模板更新超时，使用现有模板继续"
    fi
}

show_nuclei_stats() {
    for d in "$HOME/nuclei-templates" "/root/nuclei-templates"; do
        if [ -d "$d" ]; then
            local t=$(find "$d" -name "*.yaml" | wc -l)
            local cve=$(find "$d/http/cves" -name "*.yaml" 2>/dev/null | wc -l)
            log_ok "模板库: ${t} 个 YAML | ${cve} 个 CVE"
            return
        fi
    done
}

# ============================================================
# PHASE 2: 弱口令检测 (Hydra + nc)
# ============================================================
phase2_weak_passwords() {
    echo ""
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║  PHASE 2/4: 弱口令检测（14种协议）                       ║"
    echo "╚══════════════════════════════════════════════════════════╝"

    if $NO_BRUTE; then
        log_warn "--no-brute 已设置，跳过弱口令扫描"
        return
    fi

    check_install_hydra
    if $NO_BRUTE; then return; fi

    # 1. 收集需要爆破的目标
    declare -A brute_targets
    declare -A nc_targets  # nc-based brute (Redis, MongoDB, SNMP)
    while IFS= read -r line; do
        [[ -z "$line" || "$line" =~ ^# ]] && continue
        local host=""; local port=""
        if [[ "$line" =~ ^https?:// ]]; then
            host=$(echo "$line" | sed -E 's|https?://||' | cut -d: -f1)
            port=$(echo "$line" | sed -E 's|https?://||' | cut -d: -f2 -s)
        else
            host=$(echo "$line" | cut -d: -f1)
            port=$(echo "$line" | cut -d: -f2 -s)
        fi
        [ -z "$host" ] && continue

        case "$port" in
            21)      brute_targets["${host}:${port}"]="FTP" ;;
            22)      brute_targets["${host}:${port}"]="SSH" ;;
            23)      brute_targets["${host}:${port}"]="TELNET" ;;
            161)     nc_targets["${host}:${port}"]="SNMP" ;;
            445)     brute_targets["${host}:${port}"]="SMB" ;;
            3389)    brute_targets["${host}:${port}"]="RDP" ;;
            5900|5901|5902) brute_targets["${host}:${port}"]="VNC" ;;
            3306)    brute_targets["${host}:${port}"]="MySQL" ;;
            5432)    brute_targets["${host}:${port}"]="PostgreSQL" ;;
            6379)    nc_targets["${host}:${port}"]="Redis" ;;
            27017)   nc_targets["${host}:${port}"]="MongoDB" ;;
            18080|8080) brute_targets["${host}:${port}"]="Tomcat" ;;
            7443)    brute_targets["${host}:${port}"]="Jenkins" ;;
            6000|8087|8000|8003|7003|9999) brute_targets["${host}:${port}"]="HTTP-Basic" ;;
        esac
    done < "$TARGET_FILE"

    # 2. 计算并确认
    local total_targets=$((${#brute_targets[@]} + ${#nc_targets[@]}))
    if [ $total_targets -eq 0 ]; then
        log_ok "目标列表中没有弱口令检测型服务，跳过 Phase 2"
        return
    fi

    local user_count=$(wc -l < "$USER_DICT")
    local pass_count=$(wc -l < "$PASS_DICT")
    local full_attempts=$((user_count * pass_count))

    if $SAFE_MODE; then
        local per_target=6
    else
        if [ "$full_attempts" -gt "$MAX_ATTEMPTS" ]; then
            pass_count=$((MAX_ATTEMPTS / user_count))
            [ "$pass_count" -lt 1 ] && pass_count=1
        fi
        local per_target=$((user_count * pass_count))
    fi

    echo ""
    echo "  ┌─────────────────────────────────────────────┐"
    echo "  │  ⚠️  弱口令检测前确认                         │"
    echo "  ├─────────────────────────────────────────────┤"
    echo "  │  策略: 默认账号优先 → 字典轮询 → 命中即停   │"
    echo "  │  防护: -u交替用户 + -W请求间隔 + -t单线程    │"
    printf "  │  检测目标数:    %-3s 个 (Hydra:%s + nc:%s)\n" "$total_targets" "${#brute_targets[@]}" "${#nc_targets[@]}"
    echo "  ├─────────────────────────────────────────────┤"
    for t in "${!brute_targets[@]}"; do
        printf "  │    %-25s (%s)\n" "$t" "${brute_targets[$t]}"
    done
    for t in "${!nc_targets[@]}"; do
        printf "  │    %-25s (%s - nc方式)\n" "$t" "${nc_targets[$t]}"
    done
    echo "  └─────────────────────────────────────────────┘"
    echo ""

    if ! $SKIP_CONFIRM; then
        echo -ne "  ${YELLOW}确认执行弱口令检测? [y/N]${NC} "
        read -r confirm
        if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
            log_warn "用户取消，跳过 Phase 2"
            return
        fi
    fi

    # 3. 执行
    local hydra_out="$SCAN_DIR/${OUTPUT_PREFIX}_phase2_weakpass.txt"
    > "$hydra_out"
    local phase2_start=$(date +%s)

    if $SAFE_MODE; then
        log_info "🛡️  安全模式: 每用户最多 2 个密码"
    else
        log_info "执行策略: 默认账号 → 交替轮询(最多${per_target}次/服务)..."
    fi
    echo ""

    # === Hydra targets ===
    for target in "${!brute_targets[@]}"; do
        local h="${target%%:*}"
        local p="${target##*:}"
        local svc="${brute_targets[$target]}"

        # Pass 1: 默认凭证
        local default_creds="$(get_default_creds "$svc")"
        if [ -n "$default_creds" ]; then
            local tmp_combo="/tmp/nuclei_combo_$$_${h}_${p}.txt"
            echo "$default_creds" > "$tmp_combo"

            case "$svc" in
                FTP)
                    hydra -C "$tmp_combo" -t 1 -f -W 1 -o "$hydra_out" \
                          "ftp://${h}" -s "$p" 2>/dev/null & ;;
                TELNET)
                    hydra -C "$tmp_combo" -t 1 -f -W 1 -o "$hydra_out" \
                          "telnet://${h}" -s "$p" 2>/dev/null & ;;
                SMB)
                    hydra -C "$tmp_combo" -t 1 -f -W 1 -o "$hydra_out" \
                          "smb://${h}" -s "$p" 2>/dev/null & ;;
                HTTP-Basic)
                    hydra -C "$tmp_combo" -t 1 -f -W 1 -o "$hydra_out" \
                          "${h}" http-get "/" -s "$p" 2>/dev/null & ;;
                SSH|RDP|VNC|MySQL|PostgreSQL)
                    hydra -C "$tmp_combo" -t 1 -f -W 1 -o "$hydra_out" \
                          "${svc,,}://${h}" -s "$p" 2>/dev/null & ;;
                Tomcat)
                    hydra -C "$tmp_combo" -t 1 -f -W 1 -o "$hydra_out" \
                          "${h}" http-get "/manager/html" -s "$p" 2>/dev/null & ;;
                Jenkins)
                    hydra -C "$tmp_combo" -t 1 -f -W 1 -o "$hydra_out" \
                          "${h}" http-form-post \
                          "/j_acegi_security_check:j_username=^USER^&j_password=^PASS^&from=%2F:Invalid" \
                          -s "$p" 2>/dev/null & ;;
            esac
        fi

        # Pass 2: 字典轮询
        if $SAFE_MODE; then
            local t2_combo="/tmp/nuclei_t2_$$_${h}_${p}.txt"
            local t2_users=$(head -3 "$USER_DICT")
            local t2_pass=$(head -2 "$PASS_DICT")
            > "$t2_combo"
            while IFS= read -r upass; do
                while IFS= read -r uuser; do
                    echo "${uuser}:${upass}" >> "$t2_combo"
                done <<< "$t2_users"
            done <<< "$t2_pass"

            case "$svc" in
                FTP)         hydra -C "$t2_combo" -t 1 -f -W 2 -o "$hydra_out" "ftp://${h}" -s "$p" 2>/dev/null & ;;
                TELNET)      hydra -C "$t2_combo" -t 1 -f -W 2 -o "$hydra_out" "telnet://${h}" -s "$p" 2>/dev/null & ;;
                SMB)         hydra -C "$t2_combo" -t 1 -f -W 2 -o "$hydra_out" "smb://${h}" -s "$p" 2>/dev/null & ;;
                HTTP-Basic)  hydra -C "$t2_combo" -t 1 -f -W 2 -o "$hydra_out" "${h}" http-get "/" -s "$p" 2>/dev/null & ;;
                SSH|RDP|VNC|MySQL|PostgreSQL|Tomcat|Jenkins)
                    hydra -C "$t2_combo" -t 1 -f -W 2 -o "$hydra_out" "${svc,,}://${h}" -s "$p" 2>/dev/null & ;;
            esac
        else
            local u_count=$user_count
            local p_count=$pass_count
            [ "$full_attempts" -gt "$MAX_ATTEMPTS" ] && p_count=$((MAX_ATTEMPTS / u_count)) && [ "$p_count" -lt 1 ] && p_count=1
            case "$svc" in
                FTP|TELNET|SMB|SSH|RDP|VNC|MySQL|PostgreSQL)
                    hydra -L <(head -"$u_count" "$USER_DICT") -P <(head -"$p_count" "$PASS_DICT") \
                          -t 1 -f -u -W 1 -o "$hydra_out" "${svc,,}://${h}" -s "$p" 2>/dev/null & ;;
                HTTP-Basic)
                    hydra -L <(head -"$u_count" "$USER_DICT") -P <(head -"$p_count" "$PASS_DICT") \
                          -t 1 -f -u -W 1 -o "$hydra_out" "${h}" http-get "/" -s "$p" 2>/dev/null & ;;
                Tomcat)
                    hydra -L <(head -"$u_count" "$USER_DICT") -P <(head -"$p_count" "$PASS_DICT") \
                          -t 1 -f -u -W 1 -o "$hydra_out" "${h}" http-get "/manager/html" -s "$p" 2>/dev/null & ;;
                Jenkins)
                    hydra -L <(head -"$u_count" "$USER_DICT") -P <(head -"$p_count" "$PASS_DICT") \
                          -t 1 -f -u -W 1 -o "$hydra_out" "${h}" http-form-post \
                          "/j_acegi_security_check:j_username=^USER^&j_password=^PASS^&from=%2F:Invalid" \
                          -s "$p" 2>/dev/null & ;;
            esac
        fi
        log_info "启动: ${svc} ${h}:${p}"
    done

    # === nc-based targets (Redis/MongoDB/SNMP) ===
    for target in "${!nc_targets[@]}"; do
        local h="${target%%:*}"
        local p="${target##*:}"
        local svc="${nc_targets[$target]}"

        log_info "[nc检测] ${svc} ${h}:${p}"
        case "$svc" in
            SNMP)
                # SNMP community string check: public/private
                for comm in public private; do
                    if timeout 3 snmpwalk -v2c -c "$comm" "$h" 1.3.6.1.2.1.1.1.0 2>/dev/null | grep -q .; then
                        log_found "SNMP ${h}:${p} community: ${comm}!"
                        echo "[SNMP] host: ${h}  login: ${comm}  password: ${comm}" >> "$hydra_out"
                    fi
                done ;;
            Redis)
                # Try redis-cli AUTH with common passwords
                for pw in redis foobared admin 123456 password root; do
                    if timeout 3 bash -c "echo -e 'AUTH ${pw}\nPING' | nc -w 2 ${h} ${p}" 2>/dev/null | grep -q "+PONG"; then
                        log_found "Redis ${h}:${p} 认证密码: ${pw}!"
                        echo "[Redis] host: ${h}  password: ${pw}" >> "$hydra_out"
                        break
                    fi
                done ;;
            MongoDB)
                # Check if auth is required and try defaults
                local unauth=$(timeout 3 bash -c "echo 'db.version()' | nc -w 2 ${h} ${p}" 2>/dev/null)
                if echo "$unauth" | grep -qE '[0-9]+\.[0-9]+'; then
                    log_found "MongoDB ${h}:${p} 未授权（无认证）!"
                    echo "[MongoDB] host: ${h}  login: none  password: none" >> "$hydra_out"
                fi ;;
        esac
    done

    wait

    local phase2_end=$(date +%s)
    if [ -s "$hydra_out" ]; then
        echo ""
        log_found "⚠️  发现弱口令!"
        cat "$hydra_out" | while IFS= read -r line; do
            log_found "  $line"
        done
    else
        log_ok "未发现弱口令"
    fi
    log_ok "Phase 2 完成! 耗时 $((phase2_end - phase2_start))s"
}

# ============================================================
# 默认凭证数据库（v3.0 扩展：FTP/Telnet/SMB/HTTP-Basic/SNMP）
# ============================================================
get_default_creds() {
    local svc="$1"
    case "$svc" in
        FTP)
            echo "anonymous:anonymous"
            echo "ftp:ftp" ;;
        TELNET)
            echo "root:root"
            echo "admin:admin" ;;
        SSH)
            echo "root:root"
            echo "root:admin" ;;
        SMB)
            echo "administrator:admin"
            echo "guest:" ;;
        RDP)
            echo "administrator:admin"
            echo "administrator:123456" ;;
        VNC)
            echo ":password"
            echo ":admin" ;;
        MySQL)
            echo "root:root"
            echo "root:mysql" ;;
        PostgreSQL)
            echo "postgres:postgres"
            echo "postgres:admin" ;;
        Tomcat)
            echo "admin:admin"
            echo "tomcat:tomcat" ;;
        Jenkins)
            echo "admin:admin"
            echo "admin:jenkins" ;;
        HTTP-Basic)
            echo "admin:admin"
            echo "admin:admin123"
            echo "root:root"
            echo "admin:password" ;;
        *)  echo "" ;;
    esac
}

check_install_hydra() {
    log_info "检查 Hydra..."
    if command -v hydra &>/dev/null; then
        log_ok "Hydra: $(hydra 2>&1 | head -1 || echo 'installed')"
        return 0
    fi
    log_warn "Hydra 未安装，尝试自动安装..."
    if command -v apt-get &>/dev/null; then
        apt-get update -qq && apt-get install -y -qq hydra snmp snmpwalk 2>/dev/null
    elif command -v yum &>/dev/null; then
        yum install -y hydra net-snmp-utils 2>/dev/null
    elif command -v brew &>/dev/null; then
        brew install hydra net-snmp 2>/dev/null
    fi
    if command -v hydra &>/dev/null; then
        log_ok "Hydra 安装完成"
    else
        log_err "Hydra 安装失败"
        log_warn "跳过 Phase 2 弱口令扫描"
        NO_BRUTE=true
    fi
}

# ============================================================
# PHASE 3: 非HTTP服务未授权检测 (Curl/nc) — v3.0 扩展
# ============================================================
phase3_unauth_services() {
    echo ""
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║  PHASE 3/4: 未授权检测 (16种服务)                        ║"
    echo "╚══════════════════════════════════════════════════════════╝"

    local unauth_out="$SCAN_DIR/${OUTPUT_PREFIX}_phase3_unauth.txt"
    > "$unauth_out"
    local phase3_start=$(date +%s)

    while IFS= read -r line; do
        [[ -z "$line" || "$line" =~ ^# ]] && continue

        local host=""; local port=""
        if [[ "$line" =~ ^https?:// ]]; then
            host=$(echo "$line" | sed -E 's|https?://||' | cut -d: -f1)
            port=$(echo "$line" | sed -E 's|https?://||' | cut -d: -f2 -s)
        else
            host=$(echo "$line" | cut -d: -f1)
            port=$(echo "$line" | cut -d: -f2 -s)
        fi
        [ -z "$host" ] && continue

        case "$port" in
            25|587|465)   check_smtp "$host" "$port" "$unauth_out" ;;
            53)           check_dns_zonetransfer "$host" "$port" "$unauth_out" ;;
            123)          check_ntp "$host" "$port" "$unauth_out" ;;
            389|636)      check_ldap "$host" "$port" "$unauth_out" ;;
            873)          check_rsync "$host" "$port" "$unauth_out" ;;
            1099)         check_rmi "$host" "$port" "$unauth_out" ;;
            1433)        check_mssql "$host" "$port" "$unauth_out" ;;
            1521)        check_oracle "$host" "$port" "$unauth_out" ;;
            2049)         check_nfs "$host" "$port" "$unauth_out" ;;
            2375|2376)   check_docker "$host" "$port" "$unauth_out" ;;
            3000)        check_grafana "$host" "$port" "$unauth_out" ;;
            3306|3310)   check_mysql_vuln "$host" "$port" "$unauth_out" ;;
            5432)        check_postgres_vuln "$host" "$port" "$unauth_out" ;;
            5601|9200)   check_elastic "$host" "$port" "$unauth_out" ;;
            5984)        check_couchdb "$host" "$port" "$unauth_out" ;;
            6379)        check_redis_vuln "$host" "$port" "$unauth_out" ;;
            6443|8443)   check_k8s "$host" "$port" "$unauth_out" ;;
            7003)        check_weblogic "$host" "$port" "$unauth_out" ;;
            7443)        check_jenkins_unauth "$host" "$port" "$unauth_out" ;;
            8080|18080)  check_tomcat "$host" "$port" "$unauth_out" ;;
            8500)        check_consul "$host" "$port" "$unauth_out" ;;
            9000|9001)   check_minio "$host" "$port" "$unauth_out" ;;
            9090)        check_prometheus "$host" "$port" "$unauth_out" ;;
            11211)       check_memcached "$host" "$port" "$unauth_out" ;;
            15672|5672)  check_rabbitmq "$host" "$port" "$unauth_out" ;;
            27017)       check_mongodb_vuln "$host" "$port" "$unauth_out" ;;
            2181)        check_zookeeper "$host" "$port" "$unauth_out" ;;
            9999|8000|8003|8087|6000)
                check_http_unauth "$host" "$port" "$unauth_out" ;;
        esac
    done < "$TARGET_FILE"

    local findings=$(wc -l < "$unauth_out")
    local phase3_end=$(date +%s)
    if [ "$findings" -gt 0 ]; then
        log_found "发现 ${findings} 个未授权访问!"
    else
        log_ok "未发现未授权访问"
    fi
    log_ok "Phase 3 完成! 耗时 $((phase3_end - phase3_start))s"
}

# === 数据库漏洞检测函数 ===

check_mysql_vuln() {
    local h="$1"; local p="$2"; local o="$3"
    # 抓取 MySQL banner（包含版本号）
    local banner=$(timeout 3 bash -c "echo '' | nc -w 2 ${h} ${p}" 2>/dev/null | head -1)
    if echo "$banner" | grep -qi "mysql\|mariadb"; then
        local ver=$(echo "$banner" | grep -oP '\d+\.\d+\.\d+' | head -1)
        log_info "MySQL ${h}:${p} version: ${ver:-unknown}"
        # 已知高危 CVE 检测
        if [ -n "$ver" ]; then
            # CVE-2012-2122: auth bypass in MySQL < 5.5.24/5.1.63
            if [ "$(printf '%s\n' "$ver" "5.5.24" | sort -V | head -1)" = "$ver" ] && [ "$ver" != "5.5.24" ]; then
                log_found "MySQL ${h}:${p} CVE-2012-2122 认证绕过! (version: ${ver})"
                echo "MySQL|${h}|${p}|CVE-2012-2122|版本${ver}存在认证绕过" >> "$o"
            fi
            # CVE-2016-6662: RCE via my.cnf
            if [ "$(printf '%s\n' "$ver" "5.7.15" | sort -V | head -1)" = "$ver" ]; then
                log_found "MySQL ${h}:${p} CVE-2016-6662 RCE! (version: ${ver})"
                echo "MySQL|${h}|${p}|CVE-2016-6662|版本${ver}存在RCE漏洞" >> "$o"
            fi
        fi
        # Banner 已输出在 log_info，即视为已检测
        echo "MySQL|${h}|${p}|version|${banner:0:80}" >> "$o"
    fi
}

check_postgres_vuln() {
    local h="$1"; local p="$2"; local o="$3"
    # PostgreSQL 需要构造完整 StartupMessage 握手包来获取版本
    # 简化：尝试 SSLRequest + 看响应
    local resp=$(timeout 3 bash -c "echo -ne '\x00\x00\x00\x08\x04\xd2\x16\x2f' | nc -w 2 ${h} ${p} 2>/dev/null | xxd -p | head -c 20")
    if [ -n "$resp" ]; then
        log_info "PostgreSQL ${h}:${p} 响应检测（需要认证）"
    fi
    # CVE-2019-9193: COPY FROM PROGRAM (9.3-11.2)
    echo "PostgreSQL|${h}|${p}|detected|需手动确认版本和CVE-2019-9193" >> "$o"
}

check_oracle() {
    local h="$1"; local p="$2"; local o="$3"
    # Oracle TNS listener version probe
    local resp=$(timeout 3 bash -c "echo -ne '\x00\x57\x00\x00\x01\x00\x00\x00\x01\x38\x01\x2c\x00\x00\x08\x00\x7f\xff\xc6\x0e\x00\x00\x01\x00\x00\x19\x00\x00\x00\x3c\x00\x00\x00\x00\x00\x00\x00\x00\x00(CONNECT_DATA=(COMMAND=version))' | nc -w 2 ${h} ${p} 2>/dev/null | strings")
    if [ -n "$resp" ]; then
        log_found "Oracle TNS ${h}:${p} 可访问!"
        echo "Oracle|${h}|${p}|TNS-open|TNS Listener可访问" >> "$o"
        if echo "$resp" | grep -qi "12c\|19c\|21c"; then
            local ver=$(echo "$resp" | grep -oiP '1[2892]c|21c' | head -1)
            log_info "Oracle ${h}:${p} version: ${ver}"
            echo "Oracle|${h}|${p}|version|${ver}" >> "$o"
        fi
    fi
}

check_mssql() {
    local h="$1"; local p="$2"; local o="$3"
    # MSSQL TDS pre-login packet
    local resp=$(timeout 3 bash -c "echo -ne '\x12\x01\x00\x34\x00\x00\x00\x00\x00\x00\x15\x00\x06\x01\x00\x1b\x00\x01\x02\x00\x1c\x00\x0c\x03\x00\x28\x00\x04\xff\x08\x00\x01\x55\x00\x00\x00\x4d\x53\x53\x51\x4c\x53\x65\x72\x76\x65\x72\x00\x48\x0b\x00\x00' | nc -w 2 ${h} ${p} 2>/dev/null | xxd -p | head -c 20")
    if [ -n "$resp" ]; then
        log_found "MSSQL ${h}:${p} TDS 响应!"
        echo "MSSQL|${h}|${p}|TDS-open|MSSQL服务可访问" >> "$o"
    fi
}

check_couchdb() {
    local h="$1"; local p="$2"; local o="$3"
    local resp=$(curl -s "http://${h}:${p}/" --connect-timeout 5 2>/dev/null)
    if echo "$resp" | grep -q "couchdb\|CouchDB"; then
        local ver=$(echo "$resp" | grep -oP '"version":"[^"]+"' | head -1)
        log_found "CouchDB ${h}:${p} ${ver} 未授权!"
        echo "CouchDB|${h}|${p}|unauth|${ver}" >> "$o"
    fi
    # 检查 _all_dbs
    local alldbs=$(curl -s "http://${h}:${p}/_all_dbs" --connect-timeout 5 2>/dev/null)
    if echo "$alldbs" | grep -q '\[.*\]'; then
        log_found "CouchDB ${h}:${p} 可列出所有数据库!"
        echo "CouchDB|${h}|${p}|_all_dbs|可列出所有DB" >> "$o"
    fi
}

check_memcached() {
    local h="$1"; local p="$2"; local o="$3"
    local stats=$(timeout 3 bash -c "echo -e 'stats\r\n' | nc -w 2 ${h} ${p} 2>/dev/null" | head -5)
    if echo "$stats" | grep -q "STAT "; then
        local ver=$(echo "$stats" | grep "STAT version" | awk '{print $3}')
        local items=$(timeout 3 bash -c "echo -e 'stats items\r\n' | nc -w 2 ${h} ${p} 2>/dev/null" | grep "STAT items" | head -1)
        log_found "Memcached ${h}:${p} 未授权! version: ${ver:-unknown}"
        echo "Memcached|${h}|${p}|unauth|version_${ver:-unknown}" >> "$o"
        # UDD 反射放大检测
        local udp_test=$(timeout 2 bash -c "echo -ne '\x00\x00\x00\x00\x00\x01\x00\x00stats\r\n' | nc -u -w1 ${h} ${p} 2>/dev/null | head -1")
        if echo "$udp_test" | grep -q "STAT"; then
            log_found "Memcached ${h}:${p} UDP 反射放大风险!"
            echo "Memcached|${h}|${p}|UDP-amp|可被用于DDoS反射放大" >> "$o"
        fi
    fi
}

check_redis_vuln() {
    local h="$1"; local p="$2"; local o="$3"
    # 先做未授权检测
    local resp=$(timeout 5 bash -c "echo -e 'INFO\r\n' | nc -w 3 ${h} ${p} 2>/dev/null")
    if echo "$resp" | grep -q "redis_version"; then
        local ver=$(echo "$resp" | grep "redis_version" | cut -d: -f2 | tr -d '\r')
        log_found "Redis ${h}:${p} 未授权! version: ${ver:-unknown}"
        echo "Redis|${h}|${p}|unauth|version_${ver:-unknown}" >> "$o"

        # CVE-2022-0543: Lua sandbox escape RCE
        if [ -n "$ver" ] && [ "$(printf '%s\n' "${ver}" "6.2.7" | sort -V | head -1)" = "${ver}" ] && [ "${ver}" != "6.2.7" ]; then
            log_found "Redis ${h}:${p} CVE-2022-0543 Lua沙箱逃逸RCE! (version: ${ver})"
            echo "Redis|${h}|${p}|CVE-2022-0543|RCE" >> "$o"
        fi
        # 检查关键配置
        if echo "$resp" | grep -q "protected-mode:no"; then
            log_found "Redis ${h}:${p} protected-mode=no!"
        fi
        if echo "$resp" | grep -q "^slave-read-only:no\|^replica-read-only:no"; then
            log_found "Redis ${h}:${p} 主节点可写!"
        fi
    fi
}

check_mongodb_vuln() {
    local h="$1"; local p="$2"; local o="$3"
    local resp=$(timeout 5 bash -c "echo 'db.version()' | nc -w 3 ${h} ${p} 2>/dev/null | head -5")
    if echo "$resp" | grep -qE '[0-9]+\.[0-9]+'; then
        local ver=$(echo "$resp" | grep -oP '\d+\.\d+\.\d+' | head -1)
        log_found "MongoDB ${h}:${p} 未授权! version: ${ver:-unknown}"
        echo "MongoDB|${h}|${p}|unauth|version_${ver:-unknown}" >> "$o"
        # CVE-2019-2386: pre-4.0 auth bypass
        if [ -n "$ver" ] && [ "$(printf '%s\n' "${ver}" "4.0.0" | sort -V | head -1)" = "${ver}" ]; then
            log_found "MongoDB ${h}:${p} CVE-2019-2386 认证绕过! (version: ${ver})"
            echo "MongoDB|${h}|${p}|CVE-2019-2386|认证绕过" >> "$o"
        fi
    fi
    # 检查 HTTP 管理接口 (27017+1000=28017)
    local http_port=$((p + 1000))
    local http_resp=$(curl -s -o /dev/null -w "%{http_code}" "http://${h}:${http_port}/" --connect-timeout 3 2>/dev/null)
    if [ "$http_resp" = "200" ]; then
        log_found "MongoDB ${h}:${http_port} HTTP管理接口开放!"
        echo "MongoDB|${h}|${http_port}|HTTP-open|管理接口可访问" >> "$o"
    fi
}

# === 网络服务检测函数 ===

check_smtp() {
    local h="$1"; local p="$2"; local o="$3"
    local banner=$(timeout 3 bash -c "echo -e 'EHLO scan.local\r\nQUIT\r\n' | nc -w 2 ${h} ${p}" 2>/dev/null | head -5)
    if echo "$banner" | grep -qi "ESMTP\|Sendmail\|Postfix\|Exim\|Exchange"; then
        log_info "SMTP ${h}:${p} $(echo "$banner" | head -1 | tr -d '\r')"
        # VRFY root 用户枚举
        local vrfy=$(timeout 3 bash -c "echo -e 'VRFY root\r\nQUIT\r\n' | nc -w 2 ${h} ${p}" 2>/dev/null | head -3)
        if echo "$vrfy" | grep -q "252"; then
            log_found "SMTP ${h}:${p} VRFY 命令可用 (用户枚举)!"
            echo "SMTP|${h}|${p}|VRFY-open|VRFY命令可用" >> "$o"
        fi
        # EXPN 命令
        local expn=$(timeout 3 bash -c "echo -e 'EXPN root\r\nQUIT\r\n' | nc -w 2 ${h} ${p}" 2>/dev/null | head -3)
        if echo "$expn" | grep -q "250"; then
            log_found "SMTP ${h}:${p} EXPN 命令可用!"
            echo "SMTP|${h}|${p}|EXPN-open|EXPN命令可用" >> "$o"
        fi
        echo "SMTP|${h}|${p}|banner|$(echo "$banner" | head -1 | tr -d '\r')" >> "$o"
    fi
}

check_dns_zonetransfer() {
    local h="$1"; local p="$2"; local o="$3"
    # 先尝试获取 SOA 记录来获取域名
    local domains=""
    # 简单：用 host 命令做 zone transfer 尝试
    for ns in $(timeout 3 host -t ns "$h" "$h" 2>/dev/null | grep "name server" | awk '{print $NF}' | head -3); do
        for domain in $(timeout 3 host -l "$ns" "$h" 2>/dev/null | grep "has address" | awk '{print $1}' | head -3); do
            if [ -n "$domain" ]; then
                domains="$domains $domain"
            fi
        done
    done
    if [ -n "$domains" ]; then
        log_found "DNS ${h}:${p} 域传送漏洞!"
        echo "DNS|${h}|${p}|zonetransfer|可获取域记录" >> "$o"
    fi
}

check_ntp() {
    local h="$1"; local p="$2"; local o="$3"
    # NTP monlist 反射放大检测
    local monlist=$(timeout 3 bash -c "echo -ne '\x17\x00\x03\x2a\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00'" | nc -u -w2 ${h} ${p} 2>/dev/null | wc -c)
    if [ "$monlist" -gt 100 ]; then
        log_found "NTP ${h}:${p} monlist 反射放大! 响应: ${monlist} bytes"
        echo "NTP|${h}|${p}|monlist|DDoS反射放大" >> "$o"
    fi
    # version 查询
    local ver=$(timeout 3 bash -c "ntpq -c 'rv 0 version' ${h} 2>/dev/null" | grep -oP 'ntpd [0-9.]+' | head -1)
    if [ -n "$ver" ]; then
        log_info "NTP ${h}:${p} ${ver}"
    fi
}

check_ldap() {
    local h="$1"; local p="$2"; local o="$3"
    # 匿名绑定测试
    local resp=$(timeout 3 bash -c "echo -ne '\x30\x0c\x02\x01\x01\x60\x07\x02\x01\x03\x04\x00\x80\x00'" | nc -w 2 ${h} ${p} 2>/dev/null | xxd -p | head -c 30)
    if [ -n "$resp" ]; then
        log_info "LDAP ${h}:${p} 服务可访问"
        echo "LDAP|${h}|${p}|open|LDAP服务可访问" >> "$o"
    fi
}

check_rsync() {
    local h="$1"; local p="$2"; local o="$3"
    # 匿名 rsync 模块列表
    local modules=$(timeout 5 rsync --list-only --timeout=3 "rsync://${h}:${p}/" 2>/dev/null | grep -v "^$" | head -10)
    if [ -n "$modules" ]; then
        log_found "Rsync ${h}:${p} 可匿名列出模块!"
        echo "Rsync|${h}|${p}|anonymous|可列出模块" >> "$o"
        echo "$modules" >> "$o"
    fi
}

check_rmi() {
    local h="$1"; local p="$2"; local o="$3"
    # Java RMI 检测
    local resp=$(timeout 3 bash -c "echo -ne '\x4a\x52\x4d\x49\x00\x02\x4b' | nc -w 2 ${h} ${p} 2>/dev/null | xxd -p | head -c 20")
    if [ -n "$resp" ]; then
        log_found "Java RMI ${h}:${p} 可访问!"
        echo "RMI|${h}|${p}|open|JavaRMI服务可访问" >> "$o"
    fi
}

check_nfs() {
    local h="$1"; local p="$2"; local o="$3"
    # NFS export list
    local exports=$(timeout 5 showmount -e "$h" 2>/dev/null | grep -v "^$" | head -10)
    if echo "$exports" | grep -q "^/"; then
        log_found "NFS ${h}:${p} 可列出导出目录!"
        echo "NFS|${h}|${p}|exports|导出目录泄露" >> "$o"
        echo "$exports" >> "$o"
    fi
}
check_rabbitmq() {
    local h="$1"; local p="$2"; local o="$3"
    local http_port=15672
    local resp=$(curl -s -o /dev/null -w "%{http_code}" -u guest:guest \
                 "http://${h}:${http_port}/api/overview" --connect-timeout 5 2>/dev/null)
    [ "$resp" = "200" ] && log_found "RabbitMQ ${h}:${http_port} guest/guest!" && echo "RabbitMQ|${h}|${http_port}|guest/guest|默认口令" >> "$o"
}

check_docker() {
    local h="$1"; local p="$2"; local o="$3"
    local resp=$(curl -s "http://${h}:${p}/containers/json" --connect-timeout 5 2>/dev/null)
    if echo "$resp" | grep -qE '\[.*\].*"Id"|"Names"'; then
        log_found "Docker API ${h}:${p} 未授权! 可列出容器"
        echo "Docker|${h}|${p}|unauth|可列出所有容器" >> "$o"
    fi
}

check_grafana() {
    local h="$1"; local p="$2"; local o="$3"
    local resp=$(curl -s -o /dev/null -w "%{http_code}" \
                 "http://${h}:${p}/api/org" --connect-timeout 5 2>/dev/null)
    [ "$resp" = "200" ] && log_found "Grafana ${h}:${p} 未授权!" && echo "Grafana|${h}|${p}|unauth|未授权API" >> "$o"
}

check_prometheus() {
    local h="$1"; local p="$2"; local o="$3"
    local resp=$(curl -s -o /dev/null -w "%{http_code}" \
                 "http://${h}:${p}/api/v1/targets" --connect-timeout 5 2>/dev/null)
    [ "$resp" = "200" ] && log_found "Prometheus ${h}:${p} 未授权!" && echo "Prometheus|${h}|${p}|unauth|可获取targets" >> "$o"
}

check_minio() {
    local h="$1"; local p="$2"; local o="$3"
    local resp=$(curl -s -o /dev/null -w "%{http_code}" \
                 "http://${h}:${p}/minio/admin/v3/info" \
                 -H "Authorization: Basic $(echo -n 'minioadmin:minioadmin' | base64)" \
                 --connect-timeout 5 2>/dev/null)
    [ "$resp" = "200" ] && log_found "MinIO ${h}:${p} minioadmin/minioadmin!" && echo "MinIO|${h}|${p}|minioadmin/minioadmin|默认口令" >> "$o"
}

check_consul() {
    local h="$1"; local p="$2"; local o="$3"
    local resp=$(curl -s -o /dev/null -w "%{http_code}" \
                 "http://${h}:${p}/v1/agent/members" --connect-timeout 5 2>/dev/null)
    [ "$resp" = "200" ] && log_found "Consul ${h}:${p} 未授权!" && echo "Consul|${h}|${p}|unauth|未授权API" >> "$o"
}

check_elastic() {
    local h="$1"; local p="$2"; local o="$3"
    local resp=$(curl -s -o /dev/null -w "%{http_code}" \
                 "http://${h}:${p}/_cat/indices" --connect-timeout 5 2>/dev/null)
    [ "$resp" = "200" ] && log_found "Elasticsearch ${h}:${p} 未授权!" && echo "Elasticsearch|${h}|${p}|unauth|可查看索引" >> "$o"
}

check_redis() {
    local h="$1"; local p="$2"; local o="$3"
    local resp=$(timeout 5 bash -c "echo -e 'INFO\r\n' | nc -w 3 ${h} ${p} 2>/dev/null | head -1")
    if echo "$resp" | grep -q "redis_version"; then
        log_found "Redis ${h}:${p} 未授权（无密码）!"
        echo "Redis|${h}|${p}|unauth|无密码认证" >> "$o"
    fi
}

check_mongodb() {
    local h="$1"; local p="$2"; local o="$3"
    local resp=$(timeout 5 bash -c "echo 'db.version()' | nc -w 3 ${h} ${p} 2>/dev/null | head -1")
    if echo "$resp" | grep -qE '[0-9]+\.[0-9]+'; then
        log_found "MongoDB ${h}:${p} 未授权!"
        echo "MongoDB|${h}|${p}|unauth|疑似无认证" >> "$o"
    fi
}

check_zookeeper() {
    local h="$1"; local p="$2"; local o="$3"
    local resp=$(timeout 5 bash -c "echo 'envi' | nc -w 3 ${h} ${p} 2>/dev/null | head -5")
    if echo "$resp" | grep -q "zookeeper.version"; then
        log_found "ZooKeeper ${h}:${p} 未授权!"
        echo "ZooKeeper|${h}|${p}|unauth|可执行envi" >> "$o"
    fi
}

check_k8s() {
    local h="$1"; local p="$2"; local o="$3"
    local proto="https"
    [ "$p" = "8080" ] && proto="http"
    local resp=$(curl -sk -o /dev/null -w "%{http_code}" \
                 "${proto}://${h}:${p}/api/v1/namespaces" --connect-timeout 5 2>/dev/null)
    if [ "$resp" = "200" ]; then
        log_found "Kubernetes API ${h}:${p} 未授权!"
        echo "Kubernetes|${h}|${p}|unauth|可列出命名空间" >> "$o"
    fi
}

check_jenkins_unauth() {
    local h="$1"; local p="$2"; local o="$3"
    # 检查 /script 控制台
    local resp=$(curl -s -o /dev/null -w "%{http_code}" \
                 "http://${h}:${p}/script" --connect-timeout 5 2>/dev/null)
    if [ "$resp" = "200" ]; then
        log_found "Jenkins ${h}:${p} /script 可访问!"
        echo "Jenkins|${h}|${p}|unauth|/script控制台可访问" >> "$o"
    fi
    # 检查 /computer
    local resp2=$(curl -s -o /dev/null -w "%{http_code}" \
                  "http://${h}:${p}/computer/api/json" --connect-timeout 5 2>/dev/null)
    [ "$resp2" = "200" ] && log_found "Jenkins ${h}:${p} /computer 可访问!" && echo "Jenkins|${h}|${p}|unauth|节点信息泄露" >> "$o"
}

check_weblogic() {
    local h="$1"; local p="$2"; local o="$3"
    local resp=$(curl -s -o /dev/null -w "%{http_code}" \
                 "http://${h}:${p}/console" --connect-timeout 5 2>/dev/null)
    [ "$resp" = "200" ] && log_found "WebLogic ${h}:${p} /console 开放!" && echo "WebLogic|${h}|${p}|open|管理控制台" >> "$o"
}

check_tomcat() {
    local h="$1"; local p="$2"; local o="$3"
    local resp=$(curl -s -o /dev/null -w "%{http_code}" \
                 "http://${h}:${p}/manager/html" --connect-timeout 5 2>/dev/null)
    if [ "$resp" = "401" ]; then
        log_info "Tomcat ${h}:${p} /manager (需认证)"
    elif [ "$resp" = "200" ]; then
        log_found "Tomcat ${h}:${p} /manager 无需认证!"
        echo "Tomcat|${h}|${p}|unauth|管理页面无需认证" >> "$o"
    fi
}

check_http_unauth() {
    local h="$1"; local p="$2"; local o="$3"
    local resp=$(curl -s -o /dev/null -w "%{http_code}" \
                 "http://${h}:${p}/" --connect-timeout 5 2>/dev/null)
    if [ "$resp" != "000" ]; then
        # 检查常见敏感路径
        for path in "/.git/HEAD" "/.env" "/swagger-ui.html" "/actuator/env" "/api-docs" "/.DS_Store"; do
            local sp_resp=$(curl -s -o /dev/null -w "%{http_code}" \
                            "http://${h}:${p}${path}" --connect-timeout 5 2>/dev/null)
            if [ "$sp_resp" = "200" ]; then
                case "$path" in
                    "/.git/HEAD")     log_found "${h}:${p}${path} Git泄露!"; echo "GitLeak|${h}|${p}|${path}|Git仓库暴露" >> "$o" ;;
                    "/.env")          log_found "${h}:${p}${path} .env泄露!"; echo "EnvLeak|${h}|${p}|${path}|环境变量泄露" >> "$o" ;;
                    "/swagger-ui.html") log_found "${h}:${p}${path} Swagger文档!"; echo "Swagger|${h}|${p}|${path}|API文档暴露" >> "$o" ;;
                    "/actuator/env")  log_found "${h}:${p}${path} Actuator泄露!"; echo "Actuator|${h}|${p}|${path}|Spring Boot配置泄露" >> "$o" ;;
                    "/api-docs")      log_found "${h}:${p}${path} API Docs!"; echo "ApiDocs|${h}|${p}|${path}|API文档暴露" >> "$o" ;;
                    "/.DS_Store")     log_found "${h}:${p}${path} DS_Store!"; echo "DSStore|${h}|${p}|${path}|macOS文件泄露" >> "$o" ;;
                esac
            fi
        done
    fi
}

# ============================================================
# PHASE 4: 合并报告 + HTML + 通知
# ============================================================
phase4_generate_report() {
    echo ""
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║  PHASE 4/4: 生成合并报告                                 ║"
    echo "╚══════════════════════════════════════════════════════════╝"

    local SCAN_END=$(date +%s)
    local SCAN_DURATION=$((SCAN_END - SCAN_START))

    local report="$SCAN_DIR/${OUTPUT_PREFIX}_REPORT.md"
    local nuc_out="$SCAN_DIR/${OUTPUT_PREFIX}_phase1_nuclei.json"
    local hydra_out="$SCAN_DIR/${OUTPUT_PREFIX}_phase2_weakpass.txt"
    local unauth_out="$SCAN_DIR/${OUTPUT_PREFIX}_phase3_unauth.txt"
    local precheck_out="$SCAN_DIR/precheck.txt"

    cat > "$report" << EOF
# 🔐 全量扫描报告

**扫描时间**: $(date '+%Y-%m-%d %H:%M:%S')
**总耗时**:   ${SCAN_DURATION}s ($((SCAN_DURATION / 60))m $((SCAN_DURATION % 60))s)
**目标数量**: $(wc -l < "$TARGET_FILE")
**输出目录**: ${SCAN_DIR}/

---

## 📊 结果总览

| 阶段 | 工具 | 发现数 | 耗时 |
|------|------|:--:|------|
| Phase 1 | Nuclei | $(wc -l < "$nuc_out" 2>/dev/null || echo 0) | CVE/KEV/misconfig |
| Phase 2 | Hydra/nc | $(wc -l < "$hydra_out" 2>/dev/null || echo 0) | 弱口令 |
| Phase 3 | Curl/nc | $(wc -l < "$unauth_out" 2>/dev/null || echo 0) | 未授权 |
| **总计** | | | |

---

## ❌ 不可达目标

EOF

    if [ -f "$precheck_out" ] && [ -s "$precheck_out" ]; then
        cat "$precheck_out" | while IFS='|' read -r status target; do
            echo "- ${target}" >> "$report"
        done
    else
        echo "全部目标可达 ✅" >> "$report"
    fi

    cat >> "$report" << EOF

---

## Phase 1: Nuclei Web 漏洞

EOF

    if [ -f "$nuc_out" ] && [ -s "$nuc_out" ]; then
        python3 -c "
import json
with open('${nuc_out}') as f:
    findings = [json.loads(l) for l in f if l.strip()]
from collections import defaultdict
by_sev = defaultdict(list)
for d in findings:
    sev = d.get('info',{}).get('severity','unknown')
    by_sev[sev].append(d)
for sev in ['critical','high','medium','low','info']:
    items = by_sev.get(sev, [])
    if items:
        print(f'### {\"🔴\" if sev==\"critical\" else \"🟠\" if sev==\"high\" else \"🟡\"} {sev.upper()} ({len(items)} 个)')
        print()
        for d in items:
            name = d.get('info',{}).get('name','?')
            host = d.get('host','?')
            desc = d.get('info',{}).get('description','')[:100]
            print(f'- **{name}**')
            print(f'  - 目标: {host}')
            print(f'  - {desc}')
            print()
" >> "$report" 2>/dev/null
    else
        echo "无发现" >> "$report"
    fi

    cat >> "$report" << EOF

---

## Phase 2: 弱口令检测

EOF
    if [ -f "$hydra_out" ] && [ -s "$hydra_out" ]; then
        cat "$hydra_out" >> "$report"
    else
        echo "未发现弱口令" >> "$report"
    fi

    cat >> "$report" << EOF

---

## Phase 3: 未授权检测

EOF
    if [ -f "$unauth_out" ] && [ -s "$unauth_out" ]; then
        cat "$unauth_out" >> "$report"
    else
        echo "未发现未授权访问" >> "$report"
    fi

    # 手工验证清单
    cat >> "$report" << EOF

---

## 📋 手工验证清单

以下服务自动化工具无法完全覆盖，建议手工验证：

| 服务 | 端口 | 验证方法 |
|------|------|----------|
| RabbitMQ | 5672/15672 | curl -u guest:guest http://IP:15672/api/overview |
| Kafka | 9092 | 使用 kafkacat 连接验证 |
| VNC | 5900-5902 | vncviewer IP:5902 尝试空密码 |
| CAS SSO | 8443 | 检查 /cas/login 是否存在 |
| Kibana | 5601 | 检查是否可未授权查看日志 |
| WebLogic | 7001/7003 | 检查 /console |
| ZooKeeper | 2181 | echo envi \| nc IP 2181 |

---

## 🛠️ 后续建议

1. **Nuclei 发现的高危漏洞** → 优先验证和修复
2. **弱口令** → 立即修改密码，启用多因素认证
3. **未授权访问** → 配置认证/防火墙白名单
4. **手工清单** → 逐项人工验证

---

> 扫描脚本: full-scan.sh v3.0
> 输出目录: ${SCAN_DIR}/
EOF

    log_ok "Markdown 报告已生成: ${report}"

    # HTML 报告
    if $HTML_REPORT; then
        local html_report="$SCAN_DIR/${OUTPUT_PREFIX}_REPORT.html"
        python3 -c "
md = open('${report}').read()
html = '''<html><head><meta charset=\"UTF-8\"><style>
body{font-family:Arial,sans-serif;max-width:960px;margin:40px auto;padding:20px;background:#fff;color:#333}
h1{color:#1a3350;border-bottom:3px solid #1a3350;padding-bottom:10px}
h2{color:#2c5282;margin-top:30px}
h3{color:#444}
table{border-collapse:collapse;width:100%;margin:15px 0}
th{background:#1a3350;color:#fff;padding:8px 12px;text-align:left}
td{padding:6px 12px;border-bottom:1px solid #eee}
.crit{color:#e53e3e;font-weight:bold}
.high{color:#dd6b20;font-weight:bold}
.med{color:#d69e2e}
pre{background:#f7fafc;padding:12px;border-radius:4px;overflow-x:auto}
</style></head><body>
''' + md.replace('\\n', '<br>\\n').replace('\\n#', '<br>\\n<h1>').replace('\\n##', '<br>\\n<h2>').replace('\\n###', '<br>\\n<h3>').replace('---', '<hr>') + '</body></html>'
open('${html_report}','w').write(html)
print(f'HTML 报告已生成: ${html_report}')
" 2>/dev/null
    fi

    # Webhook 通知
    if [ -n "$NOTIFY_WEBHOOK" ]; then
        local nuc_count=$(wc -l < "$nuc_out" 2>/dev/null || echo 0)
        local weak_count=$(wc -l < "$hydra_out" 2>/dev/null || echo 0)
        local unauth_count=$(wc -l < "$unauth_out" 2>/dev/null || echo 0)
        local msg="{\"text\":\"🔐 扫描完成\\nNuclei: ${nuc_count} | 弱口令: ${weak_count} | 未授权: ${unauth_count}\\n耗时: ${SCAN_DURATION}s\\n报告: ${report}\"}"
        curl -s -X POST -H "Content-Type: application/json" -d "$msg" "$NOTIFY_WEBHOOK" 2>/dev/null
        log_ok "通知已发送"
    fi

    echo ""
    log_ok "报告已生成: ${report}"
    echo ""
    cat "$report"
}

# ============================================================
# 入口
# ============================================================
main
```

---

## 扫描阶段详解

### Phase 1: Nuclei Web 漏洞

```
覆盖: CVE/KEV/配置缺陷/默认口令/信息泄露
新增: 目标可达性预检（不通的自动排除）
新增: --proxy 代理支持
新增: --resume 断点续扫
工具: nuclei + nuclei-templates (12,000+ YAML)
输出: phase1_nuclei.json
```

### Phase 2: 弱口令检测（14种协议）

```
Hydra 方式 (11种):
  FTP(21)     → hydra ftp        默认: anonymous:anonymous
  SSH(22)     → hydra ssh        默认: root:root
  TELNET(23)  → hydra telnet     默认: root:root
  SMB(445)    → hydra smb        默认: administrator:admin
  RDP(3389)   → hydra rdp        默认: administrator:123456
  VNC(5902)   → hydra vnc        默认: :password
  MySQL(3306) → hydra mysql      默认: root:mysql
  PostgreSQL  → hydra postgres   默认: postgres:postgres
  Tomcat(8080)→ hydra http-get   默认: tomcat:tomcat
  Jenkins(7443)→hydra http-form  默认: admin:jenkins
  HTTP-Basic  → hydra http-get   默认: admin:admin

nc 方式 (3种):
  SNMP(161)   → snmpwalk public/private
  Redis(6379) → AUTH 命令尝试 redis/foobared/admin
  MongoDB     → 检测无认证 + 尝试默认

🛡️ 防锁定: -u轮询用户 + -W间隔 + -t单线程 + -f命中即停
```

### Phase 3: 未授权检测（16种服务）

```
原有检测:
  RabbitMQ      → guest/guest → /api/overview
  Grafana       → /api/org (200=未授权)
  Prometheus    → /api/v1/targets
  MinIO         → minioadmin/minioadmin
  Consul        → /v1/agent/members
  Elasticsearch → /_cat/indices
  Redis         → INFO 命令 (无密码)
  MongoDB       → db.version()
  ZooKeeper     → envi 命令

v3.0 新增:
  Docker API    → /containers/json (可列出容器)
  Kubernetes    → /api/v1/namespaces
  Spring Boot   → /actuator/env
  Jenkins       → /script + /computer/api/json
  WebLogic      → /console
  Tomcat        → /manager/html 免认证
  Swagger       → /swagger-ui.html + /api-docs
  Git泄露       → /.git/HEAD
  .env泄露      → /.env
  macOS泄露     → /.DS_Store
```

### Phase 4: 合并报告

```
v3.0 新增:
  ✅ 耗时统计（每个Phase + 总耗时）
  ✅ 不可达目标清单
  ✅ --html-report 生成 HTML 报告
  ✅ --notify-webhook 扫描完成通知（企业微信/钉钉/Slack）
  ✅ trap EXIT 确保临时文件清理
```

---

## 常用场景

### 场景一：CloudWalk 全量扫描

```bash
bash full-scan.sh -l cloudwalk_targets.txt --safe-mode --html-report
```

### 场景二：只扫高危 CVE + KEV

```bash
bash full-scan.sh -l targets.txt -s critical,high -tags cve,kev,vkev
```

### 场景三：安全模式弱口令

```bash
bash full-scan.sh -l targets.txt --phase2-only --safe-mode
```

### 场景四：内网扫描（通过 SOCKS5 代理）

```bash
bash full-scan.sh -l targets.txt --proxy socks5://127.0.0.1:1080
```

### 场景五：断点续扫

```bash
bash full-scan.sh --resume scan_20260703_150000
```

### 场景六：CI/CD 自动化

```bash
bash full-scan.sh -l targets.txt --safe-mode -y --html-report --notify-webhook https://hooks.slack.com/xxx
```

---

## 输出目录结构

```
scan_20260703_150000/
├── targets.txt                     # 目标备份
├── targets_reachable.txt           # 可达目标
├── precheck.txt                    # 不可达清单
├── dicts/
│   ├── users.txt                   # 用户名字典
│   └── pass.txt                    # 密码字典
├── scan_result_phase1_nuclei.json  # Nuclei 结果
├── scan_result_phase2_weakpass.txt # 弱口令结果
├── scan_result_phase3_unauth.txt   # 未授权结果
├── scan_result_REPORT.md           # Markdown 报告
└── scan_result_REPORT.html         # HTML 报告 (--html-report)
```

---

## 故障处理

| 问题 | 解决方案 |
|------|----------|
| `nuclei: command not found` | 需要 Go 环境: `apt install golang-go` |
| `hydra: command not found` | `apt-get install hydra snmp` |
| 模板下载超时 | 自动跳过，或 `--skip-update` |
| 全部目标不可达 | 检查网络/代理，或 `--proxy` |
| 扫描中断 | `--resume scan_DIR` 断点续扫 |
| 不想扫某些目标 | `--exclude exclude.txt` |
| nc 连接超时 | Phase 3 部分不影响整体 |
| 大量误报 | `-tags cve,kev` 只扫高可信度 |
