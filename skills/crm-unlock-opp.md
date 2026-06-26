---
name: crm-unlock-opp
displayName: CRM商机解锁
description: ''
icon: 🛠
category: 其他
model: null
allowedTools: []
deniedTools: []
permissionMode: bypassPermissions
version: 1.0.0
author: admin
---

# CRM 商机解锁 Skill

## 概述

在 CloudWalk CloudCC CRM 系统中，通过商机 EID 搜索并解除商机锁定状态。

## 前置条件

无额外依赖，使用系统自带 `curl`、`grep`、`md5sum` 即可。

## 执行流程

### 1. 登录 CRM 获取 Session

```bash
# 获取登录页面，提取 loginnum
LOGINNUM=$(curl -k -s "https://crm.cloudwalk.cn:9443/" | grep -oP 'id="loginnum"[^>]+value="([^"]+)"' | grep -oP 'value="[^"]+' | cut -d'"' -f2)

# MD5 加密密码
MD5_PWD=$(echo -n "<密码>" | md5sum | awk '{print $1}')

# 提交登录
curl -k -s -L -c /tmp/crm_cookies.txt -b /tmp/crm_cookies.txt \
  -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "loginnum=$LOGINNUM&tblOpUser.username=<用户名>&tblOpUser.pwd=$MD5_PWD&tblOpUser.md5pw=true" \
  "https://crm.cloudwalk.cn:9443/Login_userLogin.action"
```

### 2. 搜索商机

商机对象 ID 为 `002`，使用 `listAjaxRecentData` API 按商机 EID 搜索：

```bash
curl -k -s -L -b /tmp/crm_cookies.txt \
  -H "X-Requested-With: XMLHttpRequest" \
  "https://crm.cloudwalk.cn:9443/query.action?obj=002&m=listAjaxRecentData&viewId=0&page=1&pageSize=25&searchKeyWord=<商机EID>&isAllTag=true"
```

返回 JSON，关键字段：

| 字段 | 含义 | 示例 |
|------|------|------|
| `sjbh` | 商机编号（EID） | `E202406270142` |
| `id` | 记录 ID | `0022024AF40CFEDKCzTd` |
| `name` | 商机名称 | `2022年联通数科...` |
| `sjzt` | 审批状态 | `审批通过` |
| `jieduan` | 当前阶段 | `S3-方案交流` |
| `owneridccname` | 负责人 | `史玉峰` |

### 3. 打开商机详情页，确认锁定状态

```bash
curl -k -s -L -b /tmp/crm_cookies.txt \
  "https://crm.cloudwalk.cn:9443/query.action?id=<记录ID>&m=query" \
  | grep -oP "解除锁定[^<]*"
```

- 如果页面中存在「**解除锁定**」按钮，说明商机处于锁定状态，需要解锁。
- 如果不存在该按钮，说明商机已解锁，无需操作。

### 4. 解除锁定

商机详情页中「解除锁定」按钮的 JS 逻辑为：弹出 `confirm('您确定吗？')` 确认框，用户确认后跳转解锁 URL。

直接用 curl 调用解锁 URL 即可（等效于点击确认）：

```bash
curl -k -s -L -b /tmp/crm_cookies.txt \
  "https://crm.cloudwalk.cn:9443/query.action?id=<记录ID>&m=unlocked&rtnURL=%2Fquery.action%3Fid%3D<记录ID>%26m%3Dquery"
```

- `m=unlocked`：执行解锁操作
- `rtnURL`：解锁成功后回跳的详情页地址（需 URL 编码）

### 5. 验证解锁结果

再次请求详情页，检查「解除锁定」按钮是否消失：

```bash
curl -k -s -L -b /tmp/crm_cookies.txt \
  "https://crm.cloudwalk.cn:9443/query.action?id=<记录ID>&m=query" \
  | grep -oP "解除锁定[^<]*"
```

无输出即表示解锁成功。此时页面应出现「编辑」和「删除」按钮。

## 一键脚本

将以下内容保存为 `unlock_opportunity.sh`，修改前三行参数后执行：

```bash
#!/bin/bash
CRM_USER="<用户名>"
CRM_PASS="<密码>"
OPP_EID="<商机EID>"

COOKIE_FILE=/tmp/crm_cookies.txt
BASE_URL="https://crm.cloudwalk.cn:9443"

# 1. 登录
LOGINNUM=$(curl -k -s "$BASE_URL/" | grep -oP 'id="loginnum"[^>]+value="([^"]+)"' | grep -oP 'value="[^"]+' | cut -d'"' -f2)
MD5_PWD=$(echo -n "$CRM_PASS" | md5sum | awk '{print $1}')
curl -k -s -L -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -X POST -H "Content-Type: application/x-www-form-urlencoded" \
  -d "loginnum=$LOGINNUM&tblOpUser.username=$CRM_USER&tblOpUser.pwd=$MD5_PWD&tblOpUser.md5pw=true" \
  "$BASE_URL/Login_userLogin.action" > /dev/null

# 2. 搜索商机
RESP=$(curl -k -s -L -b "$COOKIE_FILE" \
  -H "X-Requested-With: XMLHttpRequest" \
  "$BASE_URL/query.action?obj=002&m=listAjaxRecentData&viewId=0&page=1&pageSize=25&searchKeyWord=$OPP_EID&isAllTag=true")

OPP_ID=$(echo "$RESP" | grep -oP '"id":"([^"]+)"' | head -1 | cut -d'"' -f4)
OPP_NAME=$(echo "$RESP" | grep -oP '"name":"([^"]+)"' | head -1 | cut -d'"' -f4)

if [ -z "$OPP_ID" ]; then
  echo "未找到商机 EID: $OPP_EID"
  exit 1
fi
echo "找到商机: $OPP_NAME (ID: $OPP_ID)"

# 3. 检查锁定状态
DETAIL=$(curl -k -s -L -b "$COOKIE_FILE" "$BASE_URL/query.action?id=$OPP_ID&m=query")
if echo "$DETAIL" | grep -q "解除锁定"; then
  echo "商机已锁定，正在解除..."

  # 4. 解除锁定
  RTNURL=$(echo -n "/query.action?id=$OPP_ID&m=query" | sed 's/&/%26/g; s/=/%3D/g; s/\//%2F/g')
  curl -k -s -L -b "$COOKIE_FILE" \
    "$BASE_URL/query.action?id=$OPP_ID&m=unlocked&rtnURL=$RTNURL" > /dev/null

  # 5. 验证
  VERIFY=$(curl -k -s -L -b "$COOKIE_FILE" "$BASE_URL/query.action?id=$OPP_ID&m=query")
  if echo "$VERIFY" | grep -q "解除锁定"; then
    echo "解锁失败，请检查"
  else
    echo "解锁成功！"
  fi
else
  echo "商机已处于解锁状态，无需操作"
fi
```

## 踩坑记录

- CloudCC 密码使用前端 MD5 加密，curl 调用前需先计算 hash
- `loginnum` 每次访问登录页动态生成，需先获取再提交
- 解锁 API 为 `m=unlocked`，非标准 CRUD 操作，需附带 `rtnURL` 回跳参数
- 解锁后页面按钮从 `lockData()` 占位变为实际的「编辑」「删除」链接
- 商机对象 ID 为 `002`，合同对象 ID 为 `007`，不同模块对象 ID 不同
