#!/usr/bin/env python3
"""脚本1：目录空间占用分析 - 扫描当前目录，按大小排序显示子目录占用"""

import os
from pathlib import Path

def get_dir_size(path):
    total = 0
    try:
        for entry in os.scandir(path):
            if entry.is_file(follow_symlinks=False):
                total += entry.stat().st_size
            elif entry.is_dir(follow_symlinks=False):
                total += get_dir_size(entry.path)
    except PermissionError:
        pass
    return total

def format_size(size):
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"

target = os.getcwd()
print(f"📂 扫描目录: {target}\n")
items = []
for entry in os.scandir(target):
    if entry.is_dir():
        size = get_dir_size(entry.path)
        items.append((entry.name, size))

items.sort(key=lambda x: x[1], reverse=True)
for name, size in items[:20]:
    bar = "█" * int(size / max(1, items[0][1]) * 30)
    print(f"  {format_size(size):>10}  {bar}  {name}")

file_count = sum(1 for e in os.scandir(target) if e.is_file())
print(f"\n📄 根目录文件: {file_count} 个")
