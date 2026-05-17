#!/bin/bash
# ============================================================
# Claude Web UI — 版本号自增脚本 (x.y.z → x.y.z+1)
# 用法: ./bump.sh
# ============================================================
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

# Update the sidebar display
SIDEBAR="$PROJECT_DIR/client/src/components/Sidebar.jsx"
if [ -f "$SIDEBAR" ]; then
    if command -v sed &>/dev/null; then
        sed -i "s/v[0-9]\+\.[0-9]\+\.[0-9]\+/v$NEW/g" "$SIDEBAR"
    fi
fi

echo "v$OLD → v$NEW"
