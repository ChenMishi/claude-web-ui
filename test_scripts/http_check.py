#!/usr/bin/env python3
"""脚本3：简易 HTTP 服务状态探测 - 批量检查一组 URL 的可用性和响应时间"""

import urllib.request
import urllib.error
import time
import ssl

URLS = [
    "https://www.baidu.com",
    "https://www.google.com",
    "https://www.github.com",
    "https://www.bilibili.com",
    "https://httpbin.org/status/404",
    "https://this-does-not-exist-12345.com",
]

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

print("🌐 HTTP 服务探测\n")
print(f"{'状态':<6} {'耗时':<10} {'URL'}")
print("-" * 70)

results = []
for url in URLS:
    start = time.time()
    status = "❓"
    try:
        req = urllib.request.Request(url, method="HEAD")
        resp = urllib.request.urlopen(req, timeout=5, context=ctx)
        status = f"  {resp.status} "
        elapsed = (time.time() - start) * 1000
    except urllib.error.HTTPError as e:
        status = f"  {e.code} "
        elapsed = (time.time() - start) * 1000
    except Exception as e:
        status = " FAIL"
        elapsed = (time.time() - start) * 1000

    icon = "🟢" if "200" in status else "🟡" if "404" in status or "301" in status else "🔴"
    print(f"{icon}{status:<4} {elapsed:>7.0f}ms   {url}")
    results.append((url, status.strip(), elapsed))

ok = sum(1 for _, s, _ in results if s == "200")
print(f"\n📊 总计: {len(results)} 个站点, {ok} 个正常, {len(results)-ok} 个异常")
