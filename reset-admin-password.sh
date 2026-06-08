#!/bin/bash
# ============================================================
# 重置管理员密码
# 用法:
#   ./reset-admin-password.sh <新密码>
#   ./reset-admin-password.sh           （交互式输入）
# ============================================================
set -e
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

NEW_PASSWORD="$1"

if [ -z "$NEW_PASSWORD" ]; then
  echo -n "请输入管理员新密码: "
  read -rs NEW_PASSWORD
  echo
  if [ -z "$NEW_PASSWORD" ]; then
    echo -e "${RED}错误: 密码不能为空${NC}"
    exit 1
  fi
  echo -n "请再次输入确认: "
  read -rs CONFIRM
  echo
  if [ "$NEW_PASSWORD" != "$CONFIRM" ]; then
    echo -e "${RED}错误: 两次输入的密码不一致${NC}"
    exit 1
  fi
fi

if [ ${#NEW_PASSWORD} -lt 6 ]; then
  echo -e "${RED}错误: 密码长度不能少于6位${NC}"
  exit 1
fi

# 通过环境变量传递密码，避免特殊字符破坏 JS 语法
export CCUI_NEW_PASSWORD="$NEW_PASSWORD"

cd "$PROJECT_DIR"
node -e '
const fs = require("fs");
const path = require("path");
const os = require("os");
const bcrypt = require("bcrypt");

const USERS_FILE = path.join(os.homedir(), ".claude-web-ui", "users.json");
const NEW_PASSWORD = process.env.CCUI_NEW_PASSWORD;

(async () => {
  if (!fs.existsSync(USERS_FILE)) {
    console.error("\x1b[0;31m错误: 用户文件不存在: " + USERS_FILE + "\x1b[0m");
    console.error("请先启动一次服务以初始化用户数据库。");
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  let admin = data.users.find(u => u.role === "admin");

  if (!admin) {
    // 如果没有 admin 角色，尝试找 username === "admin"
    admin = data.users.find(u => u.username === "admin");
    if (admin) {
      admin.role = "admin";
      admin.passwordHash = await bcrypt.hash(NEW_PASSWORD, 12);
      const tmp = USERS_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, USERS_FILE);
      console.log("\x1b[0;32m✓ 已将用户 \"admin\" 提升为管理员并重置密码\x1b[0m");
      process.exit(0);
    }

    console.error("\x1b[0;31m错误: 未找到管理员用户\x1b[0m");
    console.error("用户列表:");
    data.users.forEach(u => console.error("  - " + u.username + " (" + u.role + ")"));
    process.exit(1);
  }

  admin.passwordHash = await bcrypt.hash(NEW_PASSWORD, 12);

  const tmp = USERS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);

  console.log("\x1b[0;32m✓ 管理员密码已重置\x1b[0m");
  console.log("  用户: " + admin.username);
  console.log("  角色: " + admin.role);
})().catch(err => {
  console.error("\x1b[0;31m错误: " + err.message + "\x1b[0m");
  process.exit(1);
});
'

echo -e "${CYAN}完成后请重启 web UI 服务${NC}"
