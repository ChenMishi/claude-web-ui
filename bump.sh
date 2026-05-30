#!/bin/bash
# ============================================================
# Claude Web UI — 版本号自增脚本 (x.y.z → x.y.z+1)
# 用法: ./bump.sh
# ============================================================
set -e
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION_FILE="$PROJECT_DIR/VERSION"

if [ ! -f "$VERSION_FILE" ]; then
    echo "1.0.0" > "$VERSION_FILE"
fi

OLD=$(cat "$VERSION_FILE")
IFS='.' read -r MAJOR MINOR PATCH <<< "$OLD"
PATCH=$((PATCH + 1))
NEW="$MAJOR.$MINOR.$PATCH"
echo "$NEW" > "$VERSION_FILE"

# Update all version references
SED="sed"
[ "$(uname)" = "Darwin" ] && SED="gsed"  # macOS needs gnu-sed

# 1. Sidebar UI display
SIDEBAR="$PROJECT_DIR/client/src/components/Sidebar.jsx"
[ -f "$SIDEBAR" ] && $SED -i "s/v[0-9]\+\.[0-9]\+\.[0-9]\+/v$NEW/g" "$SIDEBAR"

# 2. package.json
PKG="$PROJECT_DIR/package.json"
[ -f "$PKG" ] && $SED -i "s/\"version\": \"[0-9]\+\.[0-9]\+\.[0-9]\+\"/\"version\": \"$NEW\"/" "$PKG"

# 3. server/index.js (Swagger)
INDEX="$PROJECT_DIR/server/index.js"
[ -f "$INDEX" ] && $SED -i "s/version: '[0-9]\+\.[0-9]\+\.[0-9]\+'/version: '$NEW'/" "$INDEX"

# 4. server/routes/health.js
HEALTH="$PROJECT_DIR/server/routes/health.js"
[ -f "$HEALTH" ] && $SED -i "s/version: '[0-9]\+\.[0-9]\+\.[0-9]\+'/version: '$NEW'/" "$HEALTH"

# 5. Rebuild frontend
echo "构建前端..."
cd "$PROJECT_DIR/client" && npm run build

echo "v$OLD → v$NEW  版本号已全部同步并构建完成"
