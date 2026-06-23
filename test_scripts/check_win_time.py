#!/usr/bin/env python3
"""检查 Windows 系统时间是否正确（纯 Python，无需安装依赖）"""

import subprocess
import time
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime


def run_cmd(cmd):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=10)
        return r.stdout.strip() or r.stderr.strip()
    except Exception:
        return ""


def format_offset(seconds):
    """格式化偏差"""
    s = abs(seconds)
    if s < 1:
        return "0 秒"
    elif s < 60:
        return f"{s:.1f} 秒"
    else:
        m, sec = divmod(s, 60)
        return f"{int(m)} 分 {sec:.0f} 秒"


def main():
    print("=" * 55)
    print("  Windows 系统时间检查")
    print("=" * 55)

    # 1. 系统信息
    print("\n[1] 系统信息")
    info = run_cmd("systeminfo | findstr /C:\"主机名\" /C:\"OS 名称\" /C:\"系统类型\" /C:\"时区\"")
    if info:
        for line in info.split("\n"):
            print(f"    {line.strip()}")
    else:
        print(f"    主机名: {run_cmd('hostname')}")
        print(f"    OS: {run_cmd('ver')}")

    # 2. 当前时间
    print("\n[2] 当前系统时间")
    now = datetime.now()
    now_utc = datetime.now(timezone.utc)
    print(f"    本地时间:  {now.strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]}")
    print(f"    UTC 时间:  {now_utc.strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]}")
    print(f"    时间戳:    {int(time.time())}")

    # 3. 时区
    print("\n[3] 时区")
    tz = run_cmd("tzutil /g")
    if tz:
        print(f"    时区: {tz}")
        utc_offset = now.utcoffset()
        if utc_offset:
            hours = utc_offset.total_seconds() / 3600
            print(f"    UTC 偏移: UTC{hours:+.0f}")

    # 4. NTP / 时间服务状态
    print("\n[4] NTP 时间同步状态")
    w32tm = run_cmd("w32tm /query /status")
    if w32tm:
        for line in w32tm.split("\n"):
            line = line.strip()
            if any(k in line for k in ("源", "Source", "轮询间隔", "Poll", " stratum", "参考", "Reference")):
                print(f"    {line}")
    else:
        print("    (w32tm 不可用)")

    # 来源
    source = run_cmd('w32tm /query /source')
    if source:
        print(f"    时间源: {source}")

    # 5. 网络时间比对（HTTP Date 方式）
    print("\n[5] 网络时间比对")
    remote_time = None
    for url in ["https://www.baidu.com", "https://www.microsoft.com", "https://www.bing.com"]:
        try:
            req = urllib.request.Request(url, method="HEAD")
            resp = urllib.request.urlopen(req, timeout=5)
            date_str = resp.headers.get("Date", "")
            if date_str:
                remote_time = parsedate_to_datetime(date_str)
                break
        except Exception:
            continue

    if remote_time:
        local_utc = datetime.now(timezone.utc)
        diff = (local_utc - remote_time).total_seconds()
        print(f"    远程时间: {remote_time.strftime('%Y-%m-%d %H:%M:%S')} UTC")
        print(f"    本地 UTC: {local_utc.strftime('%Y-%m-%d %H:%M:%S')} UTC")
        print(f"    偏差:     {format_offset(diff)}")

        abs_diff = abs(diff)
        print()
        if abs_diff <= 2:
            print("    ✅ 时间正常（偏差 ≤ 2 秒）")
        elif abs_diff <= 60:
            print(f"    ⚠️  偏差 {abs_diff:.0f} 秒，建议同步")
            print("    运行: w32tm /resync")
        elif abs_diff <= 3600:
            print(f"    ⚠️  偏差 {abs_diff/60:.1f} 分钟，时间不准！")
            print("    运行: net start w32time && w32tm /resync")
        else:
            print(f"    ❌ 偏差 {abs_diff/60:.0f} 分钟（{abs_diff/3600:.1f} 小时），严重不准！")
            print("    先手动校准: net stop w32time")
            print("    w32tm /unregister && w32tm /register")
            print("    net start w32time && w32tm /resync")
    else:
        print("    ⚠️  无法获取网络时间（检查网络连接）")

    # 6. 快速修复提示
    print("\n" + "=" * 55)
    print("  快速修复命令（管理员 PowerShell）：")
    print("  w32tm /resync")
    print("=" * 55)


if __name__ == "__main__":
    main()
