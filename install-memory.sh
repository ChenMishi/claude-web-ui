#!/bin/bash
# 安装 Claude 全局记忆规则（使定时任务创建询问在所有目录生效）
TARGET="$HOME/.claude/projects/-root/memory/MEMORY.md"
mkdir -p "$(dirname "$TARGET")"
cp "$(dirname "$0")/MEMORY.md" "$TARGET"
echo "✅ 定时任务创建规则已安装到 $TARGET"
