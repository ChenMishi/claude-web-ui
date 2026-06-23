#!/usr/bin/env python3
"""脚本2：随机密码生成器 - 生成指定长度和复杂度的随机密码"""

import secrets
import string
import argparse

def generate_password(length=16, upper=True, lower=True, digits=True, symbols=True):
    pool = ""
    if lower:
        pool += string.ascii_lowercase
    if upper:
        pool += string.ascii_uppercase
    if digits:
        pool += string.digits
    if symbols:
        pool += "!@#$%^&*_-+=?"

    if not pool:
        return "错误：至少选择一种字符类型"

    password = ""
    # 确保每种类型至少出现一次
    if lower:
        password += secrets.choice(string.ascii_lowercase)
    if upper:
        password += secrets.choice(string.ascii_uppercase)
    if digits:
        password += secrets.choice(string.digits)
    if symbols:
        password += secrets.choice("!@#$%^&*_-+=?")

    password += ''.join(secrets.choice(pool) for _ in range(length - len(password)))

    # 打乱
    lst = list(password)
    secrets.SystemRandom().shuffle(lst)
    return ''.join(lst)

# 生成 10 个密码展示
print("🔐 随机密码生成器\n")
print(f"{'强度':<8} {'长度':<6} 密码")
print("-" * 50)

configs = [
    ("简单", 8,  {"lower": True, "upper": False, "digits": True,  "symbols": False}),
    ("中等", 12, {"lower": True, "upper": True,  "digits": True,  "symbols": False}),
    ("强",   16, {"lower": True, "upper": True,  "digits": True,  "symbols": True}),
    ("极强", 24, {"lower": True, "upper": True,  "digits": True,  "symbols": True}),
]

for label, length, kwargs in configs:
    for _ in range(2):
        pwd = generate_password(length=length, **kwargs)
        print(f"{label:<8} {length:<6} {pwd}")

# 评估熵值
pwd = generate_password(16, True, True, True, True)
pool_size = 26 + 26 + 10 + 12  # 小写+大写+数字+符号
import math
entropy = math.log2(pool_size ** len(pwd))
print(f"\n📊 16位强密码熵值: {entropy:.0f} bits (相当于 2^{entropy:.0f} 种组合)")
