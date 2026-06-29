#!/bin/bash
# ============================================================
# Claude Web UI — 版本号变更脚本
# 用法:
#   ./bump.sh             自动自增 PATCH (x.y.z → x.y.z+1)
#   ./bump.sh 2.3.0       同步到指定版本号
# ============================================================
set -e
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION_FILE="$PROJECT_DIR/VERSION"

if [ ! -f "$VERSION_FILE" ]; then
    echo "1.0.0" > "$VERSION_FILE"
fi

OLD=$(cat "$VERSION_FILE")

if [ -n "$1" ]; then
    # 指定版本号模式
    NEW="$1"
    if ! echo "$NEW" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        echo "错误: 版本号格式不正确，应为 x.y.z (例: 2.3.0)"
        exit 1
    fi
else
    # 自增 PATCH 模式
    IFS='.' read -r MAJOR MINOR PATCH <<< "$OLD"
    PATCH=$((PATCH + 1))
    NEW="$MAJOR.$MINOR.$PATCH"
fi

echo "$NEW" > "$VERSION_FILE"

# Update all version references
SED="sed"
[ "$(uname)" = "Darwin" ] && SED="gsed"

VPAT="[0-9]\+\.[0-9]\+\.[0-9]\+"

# 1-3. Frontend version display (Sidebar / Login / Settings)
for f in \
    client/src/components/Sidebar.jsx \
    client/src/components/LoginPage.jsx \
    client/src/components/SettingsPanel.jsx; do
    $SED -i "s/v$VPAT/v$NEW/g" "$PROJECT_DIR/$f"
done

# 4. Root package.json
$SED -i "s/\"version\": \"$VPAT\"/\"version\": \"$NEW\"/" "$PROJECT_DIR/package.json"

# 5. server/routes/health.js
$SED -i "s/version: '$VPAT'/version: '$NEW'/" "$PROJECT_DIR/server/routes/health.js"

# 6. Rebuild frontend (also updates server/index.js which reads from package.json)
echo "构建前端..."
cd "$PROJECT_DIR/client" && npm run build

echo "v$OLD → v$NEW  版本号已全部同步并构建完成"
