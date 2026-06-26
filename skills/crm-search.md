---
name: crm-search
displayName: CRM合同信息获取
description: ''
icon: 🔍
category: 其他
model: null
allowedTools: []
deniedTools: []
permissionMode: bypassPermissions
version: 1.0.0
author: admin
---

# CRM 合同分析 PDF 报告生成 Skill

## 概述

从 CloudWalk CloudCC CRM 系统中提取合同的全部内容（基本信息、产品清单、物料清单及所有关联列表），生成格式化的中文 PDF 分析报告。

## 前置条件

```bash
# 安装 wkhtmltopdf（唯一可靠的 CJK PDF 渲染方案）
apt-get install -y wkhtmltopdf
```

## 执行流程

### 1. 登录 CRM 获取 Session

```bash
# 获取登录页面，提取 loginnum 和表单字段
curl -k -s -L -c /tmp/crm_cookies.txt "https://crm.cloudwalk.cn:9443/"

# MD5 加密密码（CloudCC 前端 JS 使用 MD5 哈希密码）
MD5_PWD=$(echo -n "密码" | md5sum | awk '{print $1}')

# 提交登录表单
curl -k -s -L -c /tmp/crm_cookies.txt -b /tmp/crm_cookies.txt \
  -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "loginnum=<从页面提取>&tblOpUser.username=<用户名>&tblOpUser.pwd=$MD5_PWD&tblOpUser.md5pw=true" \
  "https://crm.cloudwalk.cn:9443/Login_userLogin.action"
```

### 2. 搜索合同

```bash
# 销售合同对象 ID 为 007，使用 listAjaxRecentData API 搜索
curl -k -s -L -b /tmp/crm_cookies.txt \
  -H "X-Requested-With: XMLHttpRequest" \
  "https://crm.cloudwalk.cn:9443/query.action?obj=007&m=listAjaxRecentData&viewId=0&page=1&pageSize=25&searchKeyWord=<合同HID>&isAllTag=true"
```

返回 JSON 包含 `hthid`（合同HID）、`id`（记录ID）、`name`、`htje2`（金额）等字段。

### 3. 获取合同全部内容详情

请求合同详情页，读取合同的完整 HTML 内容（包含所有字段、关联列表等信息），并拉取所有关联列表数据（产品清单、物料清单等）。

```bash
# 3a. 获取合同详情页（完整 HTML）
curl -k -s -L -b /tmp/crm_cookies.txt \
  "https://crm.cloudwalk.cn:9443/query.action?id=<合同记录ID>&m=query" > /tmp/contract.html
```

从页面中提取所有关联列表的 `relatedlistId` 和对应名称：
```bash
grep -oP "relatedListjson\.push\(\{relateid:'[^']+',lablename:'[^']+'\}\)" /tmp/contract.html
```

输出示例：
- `relateid:'aee2019A4131357dGTi2',lablename:'合同产品清单'`
- `relateid:'aee201925B11D83EHNv3',lablename:'合同物料清单'`
- 以及其他所有关联列表...

同时提取 `layoutId`：
```bash
grep -oP "loadRelatedlist\('[^']+',\s*'([^']+)'" /tmp/contract.html
```

```bash
# 3b. 遍历所有关联列表，逐一拉取完整数据
# 对每个关联列表调用 getRelatedlistByAjax API

# 产品清单
curl -k -s -L -b /tmp/crm_cookies.txt \
  -H "X-Requested-With: XMLHttpRequest" \
  -H "Referer: https://crm.cloudwalk.cn:9443/query.action?id=<合同ID>&m=query" \
  -X POST -H "Content-Type: application/x-www-form-urlencoded" \
  -d "layoutId=<layoutId>&recordId=<合同记录ID>&relatedlistId=<产品清单relatedlistId>" \
  "https://crm.cloudwalk.cn:9443/query!getRelatedlistByAjax.action"

# 物料清单（同理，替换 relatedlistId）

# 其他关联列表同理，逐个拉取
```

合同详情页 HTML 中包含合同的全部字段信息，关联列表 API 返回各列表的完整数据，两者合并即为合同的全部内容。

### 4. 生成 PDF 报告

**关键：必须使用 wkhtmltopdf，不要使用 fpdf/fpdf2。** 原因见下方「踩坑记录」。

```bash
# 1. 用 Python 解析 JSON 数据，生成 HTML 报告
# 2. 用 wkhtmltopdf 转换 HTML → PDF

wkhtmltopdf -O Landscape -s A4 -T 8 -B 8 -L 10 -R 10 \
  --encoding UTF-8 /tmp/report.html /root/合同分析报告.pdf
```

HTML 模板要点：
- 使用 Noto Sans CJK SC 等系统字体
- 用 `<div class="page" style="page-break-after: always;">` 控制分页
- 表格使用 `border-collapse: collapse` + 斑马纹
- CSS `@media print { -webkit-print-color-adjust: exact; }` 保留背景色

## 踩坑记录

### 字体问题是 PDF 生成的核心难点

| 方案 | 结果 | 原因 |
|------|------|------|
| fpdf + DroidSansFallback | 中文 OK，数字/英文全是方框 | 该字体 cmap 表残缺，只有 CJK 无 Latin glyph |
| fpdf2 + Noto Sans CJK SC | 布局混乱，中文消失 | 字体为 OpenType CFF 格式，fpdf2 CID 字体处理有兼容性 bug |
| fpdf2 + 字体 fallback | 直接报错 | Helvetica 主字体无法编码 CJK 字符，不会自动 fallback |
| **wkhtmltopdf** | **全部正常** | WebKit 浏览器引擎原生支持所有字体，不经过中间字体嵌入层 |

### 其他注意事项

- CloudCC 密码使用前端 MD5 加密，需在 curl 前计算 hash
- `listAjax` 用 `viewId=aec201402485716qeDZT` 返回空，必须用 `listAjaxRecentData` + `viewId=0`
- 相关列表 API 是 `query!getRelatedlistByAjax.action`（POST），不是 `query!getAllRelatedlist.action`
- 数据字段名均为拼音缩写（如 `hthid`=合同HID, `cpmcccname`=产品名称, `wlmcccname`=物料名称），ccname 后缀表示中文显示名

## HTML 报告模板结构

```
封面页 (.page)
  - 报告标题
  - 合同 HID、名称
  - 关键信息表（客户、金额、状态等）

其它页面根据用户的实际要求进行整理，如果用户没提要求就默认整理所有信息。
```
