---
name: crm-test
displayName: crm-test
description: ''
icon: 🚀
category: 其他
model: null
allowedTools: []
deniedTools: []
permissionMode: acceptEdits
version: 1.0.0
author: admin
---

# CRM合同清单导出 Skill

## 概述
从CloudCC CRM系统中查询指定合同的以下四个相关列表，并导出为多Sheet的Excel文件：
1. **合同产品清单** — 合同主产品明细
2. **合同物料清单** — 合同主物料明细
3. **《合同变更》中的变更产品清单** — 变更后的产品明细
4. **《合同变更》中的变更物料清单** — 变更后的物料明细

## 前置条件
- 目标CRM系统地址（如 `https://crm.cloudwalk.cn:9443`）
- CRM账号和密码
- `curl`、`python3`、`openpyxl` 可用
- 已知合同HID或合同名称

---

## 完整步骤

### 步骤1：获取登录页面并提取 loginnum

```bash
curl -k -s -L -c /tmp/crm_cookies.txt "https://<CRM_HOST>/" 2>&1 | \
  grep -oP 'id="loginnum"[^>]*value="[^"]*"'
```

**说明：**
- `-k`：忽略SSL证书验证
- `-c /tmp/crm_cookies.txt`：保存cookie到文件
- `loginnum` 是服务端生成的登录令牌，每次登录必需

**输出示例：**
```
id="loginnum" name="loginnum" type="hidden" value="0582eb6bdf008130979b40d19e4c487d"
```

---

### 步骤2：MD5加密密码并登录

```bash
MD5_PWD=$(echo -n "<密码>" | md5sum | awk '{print $1}')

curl -k -s -L -c /tmp/crm_cookies.txt -b /tmp/crm_cookies.txt \
  -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "loginnum=<LOGINNUM>&tblOpUser.username=<账号>&tblOpUser.pwd=$MD5_PWD&tblOpUser.md5pw=true" \
  "https://<CRM_HOST>/Login_userLogin.action" 2>&1 | head -5
```

**说明：**
- CRM使用前端MD5加密密码，需要先对密码做MD5
- 参数 `tblOpUser.md5pw=true` 告知服务端密码已是MD5
- 登录成功后cookie会自动更新

---

### 步骤3：搜索合同获取ID和详情

```bash
# 搜索合同
curl -k -s -L -b /tmp/crm_cookies.txt \
  -H "X-Requested-With: XMLHttpRequest" \
  "https://<CRM_HOST>/query.action?obj=007&m=listAjaxRecentData&viewId=0&page=1&pageSize=25&searchKeyWord=<HID>" \
  2>&1 | python3 -m json.tool
```

**说明：**
- `obj=007`：销售合同对象
- `m=listAjaxRecentData`：搜索最近数据
- `searchKeyWord`：合同HID

**从返回结果中提取关键字段：**
- `id`：合同记录ID（如 `0072023BDA38A20Q8Jqy`）
- `hthid`：合同HID（如 `H1013D-2023110055`）
- `name`：合同名称
- `zhuangtai`：审批状态

---

### 步骤4：获取合同详情页（确认相关列表ID）

```bash
curl -k -s -L -b /tmp/crm_cookies.txt \
  "https://<CRM_HOST>/query.action?m=query&id=<合同ID>" \
  2>&1 > /tmp/crm_contract.html
```

**从页面中提取关键信息：**

```bash
# 查找所有四个相关列表的relateid
grep -n "合同产品清单\|合同物料清单\|《合同变更》中的变更产品清单\|《合同变更》中的变更物料清单" /tmp/crm_contract.html
```

**典型的 loadRelatedlist 调用格式：**
```javascript
// 合同产品清单
loadRelatedlist('relatedlist_aee2019A4131357dGTi2', 'add2011000049469jBL5', '<合同ID>', 'aee2019A4131357dGTi2', '...', btnURLList_xxx, false,false,true);
// 合同物料清单
loadRelatedlist('relatedlist_aee201925B11D83EHNv3', 'add2011000049469jBL5', '<合同ID>', 'aee201925B11D83EHNv3', '...', btnURLList_xxx, false,false,true);
// 《合同变更》中的变更产品清单
loadRelatedlist('relatedlist_aee20212F038CC51Wlni', 'add2011000049469jBL5', '<合同ID>', 'aee20212F038CC51Wlni', '...', btnURLList_xxx, false,false,true);
// 《合同变更》中的变更物料清单
loadRelatedlist('relatedlist_aee2021D7592C3BZdKBX', 'add2011000049469jBL5', '<合同ID>', 'aee2021D7592C3BZdKBX', '...', btnURLList_xxx, false,false,true);
```

**四个相关列表的固定参数：**（layoutId 和 recordId 均相同）

| 序号 | 列表名称 | layoutId | relateid |
|------|---------|----------|----------|
| 1 | 合同产品清单 | `add2011000049469jBL5` | `aee2019A4131357dGTi2` |
| 2 | 合同物料清单 | `add2011000049469jBL5` | `aee201925B11D83EHNv3` |
| 3 | 变更产品清单 | `add2011000049469jBL5` | `aee20212F038CC51Wlni` |
| 4 | 变更物料清单 | `add2011000049469jBL5` | `aee2021D7592C3BZdKBX` |

> **注意**：`relateid` 是CRM系统的固定配置值，不同CRM环境可能不同，务必从合同详情页HTML中解析 `loadRelatedlist()` 调用确认。以上值为 `crm.cloudwalk.cn` 环境实测值。

---

### 步骤5：通过API获取四个相关列表数据

**API端点：** `/query!getRelatedlistByAjax.action`

```bash
# 获取合同产品清单
curl -k -s -L -b /tmp/crm_cookies.txt \
  -X POST -H "Content-Type: application/x-www-form-urlencoded" \
  "https://<CRM_HOST>/query!getRelatedlistByAjax.action?t=$(date +%s)" \
  -d "layoutId=add2011000049469jBL5&recordId=<合同ID>&relatedlistId=aee2019A4131357dGTi2" \
  > /tmp/crm_contract_product.json

# 获取合同物料清单
curl -k -s -L -b /tmp/crm_cookies.txt \
  -X POST -H "Content-Type: application/x-www-form-urlencoded" \
  "https://<CRM_HOST>/query!getRelatedlistByAjax.action?t=$(date +%s)" \
  -d "layoutId=add2011000049469jBL5&recordId=<合同ID>&relatedlistId=aee201925B11D83EHNv3" \
  > /tmp/crm_contract_material.json

# 获取变更产品清单
curl -k -s -L -b /tmp/crm_cookies.txt \
  -X POST -H "Content-Type: application/x-www-form-urlencoded" \
  "https://<CRM_HOST>/query!getRelatedlistByAjax.action?t=$(date +%s)" \
  -d "layoutId=add2011000049469jBL5&recordId=<合同ID>&relatedlistId=aee20212F038CC51Wlni" \
  > /tmp/crm_change_product.json

# 获取变更物料清单
curl -k -s -L -b /tmp/crm_cookies.txt \
  -X POST -H "Content-Type: application/x-www-form-urlencoded" \
  "https://<CRM_HOST>/query!getRelatedlistByAjax.action?t=$(date +%s)" \
  -d "layoutId=add2011000049469jBL5&recordId=<合同ID>&relatedlistId=aee2021D7592C3BZdKBX" \
  > /tmp/crm_change_material.json
```

**说明：**
- **必须使用 POST**，GET请求会返回NullPointerException
- `Content-Type` 必须是 `application/x-www-form-urlencoded`
- `t` 参数用于防止缓存
- 不需要传 `perPage` 参数（会返回全部数据）

**返回JSON结构：**
```json
{
  "id": "aee20212F038CC51Wlni",
  "objid": "2021E8B9ECBB434f90ME",
  "objLabel": "《合同变更》中的变更产品清单",
  "totalCount": 8,
  "data": [
    {
      "name": "202406133398",
      "cpmcccname": "公有云（云从AI开放平台）",
      "cpbh": "PRJ1000000116",
      ...
    }
  ]
}
```

---

### 步骤6：生成Excel文件

使用 `openpyxl` 创建包含4个Sheet的Excel文件。

**Sheet定义：**

| Sheet序号 | Sheet名称 | 数据文件 | relateid |
|-----------|----------|---------|-----------|
| 1 | 合同产品清单 | `/tmp/crm_contract_product.json` | `aee2019A4131357dGTi2` |
| 2 | 合同物料清单 | `/tmp/crm_contract_material.json` | `aee201925B11D83EHNv3` |
| 3 | 变更产品清单 | `/tmp/crm_change_product.json` | `aee20212F038CC51Wlni` |
| 4 | 变更物料清单 | `/tmp/crm_change_material.json` | `aee2021D7592C3BZdKBX` |

**合同产品清单字段映射：**
```python
contract_product_headers = [
    "产品行号", "产品名称", "产品编号", "产品型号", "产品形态",
    "单位", "数量", "退货数量", "单价", "不含税单价", "倒挤后数量",
    "产品总价", "不含税总价", "外开票金额", "折扣率",
    "研发费用成本", "外购成本", "成本毛利率",
    "市场参考价", "自研/外采",
    "产品经理工号", "产品经理",
    "产品申请部门", "一级产品分类", "二级产品分类",
    "销售人员业绩金比例", "行业总监业绩金比例", "企业总经理业绩金比例"
]

contract_product_keys = [
    "name", "cpmcccname", "cpbh", "cpxh", "cpxt",
    "dw", "sl", "thsl", "dj", "bhsdj", "djh",
    "cpzj", "bhszj", "wkp", "zkl",
    "yfcb", "wgcb", "cmll",
    "scz", "iscwproduct",
    "cpjlgh", "cpjl",
    "cpsqbm", "firstCategory", "secondCategory",
    "xsryj", "hyzjj", "qyzjj"
]
```

**合同物料清单字段映射：**
```python
contract_material_headers = [
    "物料行号", "所属产品", "物料名称", "物料编码", "型号", "形态",
    "标配选配", "收付通标识", "计量单位", "数量", "退货数量",
    "单价(含税)", "不含税单价", "倒挤后数量",
    "物料总价(含税)", "不含税总价", "折扣率",
    "研发费用成本单价", "外购成本单价", "研发费用成本总计", "外购成本总计",
    "成本毛利率", "市场指导价", "市场指导价单价", "实际销售价",
    "企业总经理业绩金比例", "行业总监业绩金比例", "销售人员业绩金比例",
    "税率"
]

contract_material_keys = [
    "name", "glcpmcccname", "wlmcccname", "wlbm", "xh1", "xt",
    "bpxp", "sftp", "jldw", "sl", "thsl",
    "dj", "bhsdj", "djh",
    "wlzj2", "bhszj", "zkl",
    "yfcbdj", "wgcbdj", "yfcbzj", "wgcbzj",
    "cmll", "sczdj", "sczdjdj", "sjxsj",
    "qyzjjdj", "hyezjjdj", "xsryj",
    "sl2"
]
```

**变更产品清单字段映射：**
```python
change_product_headers = [
    "产品变更编号", "所属合同", "合同变更单号", "产品名称", "产品编号", "产品型号",
    "形态", "单位", "数量", "单价", "不含税单价", "倒挤后数量(不含税)",
    "产品总价", "不含税总价", "外开票金额", "折扣率",
    "研发费用成本1", "外购成本1", "成本毛利率", "毛利率",
    "考核单价", "考核总价",
    "销售人员业绩金比例", "行业总监业绩金比例", "企业总经理业绩金比例"
]

change_product_keys = [
    "name", "hidnameccname", "hidchangeNoccname", "cpmcccname", "cpbh", "cpxh",
    "xt", "dw", "sl", "dj", "bhsdj", "djh",
    "cpzj", "bhszj", "wkp", "zkl",
    "yfcb1", "wgcb1", "cmll", "mlj",
    "priceKaohe", "totalPriceKaohe",
    "xsryj", "hyzjj", "qyzjj"
]
```

**变更物料清单字段映射：**
```python
change_material_headers = [
    "物料变更编号", "所属合同", "合同变更单号", "所属产品", "物料名称", "物料编码", "型号",
    "形态", "标配选配", "计量单位", "数量", "单价", "不含税单价", "倒挤后含税数量",
    "物料总价", "不含税总价", "折扣率",
    "研发费用成本", "外购成本", "研发费用成本总计", "外购成本总计",
    "成本毛利率", "市场指导价", "市场指导价单价",
    "企业总经理业绩金比例", "行业总监业绩金比例", "税率"
]

change_material_keys = [
    "name", "yhtmcccname", "htbgdhccname", "sscpccname", "wlmcccname", "wlbm", "xh1",
    "xt", "bpxp", "jldw", "sl", "dj", "bhsdj", "djh",
    "wlzj", "bhszj", "zkl",
    "yfcb", "wgcb", "yfcbzj", "wgcbzj",
    "cmll", "sczdj", "sczdjdj",
    "qyzjjdj", "hyzjj", "sl2"
]
```

**完整生成脚本：**
```python
import json, openpyxl
from openpyxl.styles import Font, Alignment, Border, Side, PatternFill
from openpyxl.utils import get_column_letter

# 加载四个数据文件
files = {
    "合同产品清单": json.load(open('/tmp/crm_contract_product.json')),
    "合同物料清单": json.load(open('/tmp/crm_contract_material.json')),
    "变更产品清单": json.load(open('/tmp/crm_change_product.json')),
    "变更物料清单": json.load(open('/tmp/crm_change_material.json')),
}

# 样式定义
header_font = Font(name='微软雅黑', bold=True, size=11, color='FFFFFF')
header_fill = PatternFill(start_color='4472C4', end_color='4472C4', fill_type='solid')
header_alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
cell_font = Font(name='微软雅黑', size=10)
cell_alignment = Alignment(horizontal='center', vertical='center')
thin_border = Border(
    left=Side(style='thin'), right=Side(style='thin'),
    top=Side(style='thin'), bottom=Side(style='thin')
)

def write_sheet(ws, headers, keys, data_items):
    for col_idx, header in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col_idx, value=header)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = header_alignment
        cell.border = thin_border
    for row_idx, item in enumerate(data_items, 2):
        for col_idx, key in enumerate(keys, 1):
            cell = ws.cell(row=row_idx, column=col_idx, value=item.get(key, ""))
            cell.font = cell_font
            cell.alignment = cell_alignment
            cell.border = thin_border
    for col_idx in range(1, len(headers) + 1):
        max_length = max(
            len(str(headers[col_idx - 1])),
            max((len(str(ws.cell(row=r, column=col_idx).value or "")) for r in range(2, len(data_items)+2)), default=0)
        )
        ws.column_dimensions[get_column_letter(col_idx)].width = min(max_length + 4, 30)
    ws.freeze_panes = 'A2'
    ws.row_dimensions[1].height = 30

# 四个Sheet的配置
SHEET_CONFIG = [
    ("合同产品清单", [
        "产品行号", "产品名称", "产品编号", "产品型号", "产品形态",
        "单位", "数量", "退货数量", "单价", "不含税单价", "倒挤后数量",
        "产品总价", "不含税总价", "外开票金额", "折扣率",
        "研发费用成本", "外购成本", "成本毛利率",
        "市场参考价", "自研/外采",
        "产品经理工号", "产品经理",
        "产品申请部门", "一级产品分类", "二级产品分类",
        "销售人员业绩金比例", "行业总监业绩金比例", "企业总经理业绩金比例"
    ], [
        "name", "cpmcccname", "cpbh", "cpxh", "cpxt",
        "dw", "sl", "thsl", "dj", "bhsdj", "djh",
        "cpzj", "bhszj", "wkp", "zkl",
        "yfcb", "wgcb", "cmll",
        "scz", "iscwproduct",
        "cpjlgh", "cpjl",
        "cpsqbm", "firstCategory", "secondCategory",
        "xsryj", "hyzjj", "qyzjj"
    ]),
    ("合同物料清单", [
        "物料行号", "所属产品", "物料名称", "物料编码", "型号", "形态",
        "标配选配", "收付通标识", "计量单位", "数量", "退货数量",
        "单价(含税)", "不含税单价", "倒挤后数量",
        "物料总价(含税)", "不含税总价", "折扣率",
        "研发费用成本单价", "外购成本单价", "研发费用成本总计", "外购成本总计",
        "成本毛利率", "市场指导价", "市场指导价单价", "实际销售价",
        "企业总经理业绩金比例", "行业总监业绩金比例", "销售人员业绩金比例",
        "税率"
    ], [
        "name", "glcpmcccname", "wlmcccname", "wlbm", "xh1", "xt",
        "bpxp", "sftp", "jldw", "sl", "thsl",
        "dj", "bhsdj", "djh",
        "wlzj2", "bhszj", "zkl",
        "yfcbdj", "wgcbdj", "yfcbzj", "wgcbzj",
        "cmll", "sczdj", "sczdjdj", "sjxsj",
        "qyzjjdj", "hyezjjdj", "xsryj",
        "sl2"
    ]),
    ("变更产品清单", [
        "产品变更编号", "所属合同", "合同变更单号", "产品名称", "产品编号", "产品型号",
        "形态", "单位", "数量", "单价", "不含税单价", "倒挤后数量(不含税)",
        "产品总价", "不含税总价", "外开票金额", "折扣率",
        "研发费用成本1", "外购成本1", "成本毛利率", "毛利率",
        "考核单价", "考核总价",
        "销售人员业绩金比例", "行业总监业绩金比例", "企业总经理业绩金比例"
    ], [
        "name", "hidnameccname", "hidchangeNoccname", "cpmcccname", "cpbh", "cpxh",
        "xt", "dw", "sl", "dj", "bhsdj", "djh",
        "cpzj", "bhszj", "wkp", "zkl",
        "yfcb1", "wgcb1", "cmll", "mlj",
        "priceKaohe", "totalPriceKaohe",
        "xsryj", "hyzjj", "qyzjj"
    ]),
    ("变更物料清单", [
        "物料变更编号", "所属合同", "合同变更单号", "所属产品", "物料名称", "物料编码", "型号",
        "形态", "标配选配", "计量单位", "数量", "单价", "不含税单价", "倒挤后含税数量",
        "物料总价", "不含税总价", "折扣率",
        "研发费用成本", "外购成本", "研发费用成本总计", "外购成本总计",
        "成本毛利率", "市场指导价", "市场指导价单价",
        "企业总经理业绩金比例", "行业总监业绩金比例", "税率"
    ], [
        "name", "yhtmcccname", "htbgdhccname", "sscpccname", "wlmcccname", "wlbm", "xh1",
        "xt", "bpxp", "jldw", "sl", "dj", "bhsdj", "djh",
        "wlzj", "bhszj", "zkl",
        "yfcb", "wgcb", "yfcbzj", "wgcbzj",
        "cmll", "sczdj", "sczdjdj",
        "qyzjjdj", "hyzjj", "sl2"
    ]),
]

wb = openpyxl.Workbook()

for idx, (title, headers, keys) in enumerate(SHEET_CONFIG):
    if idx == 0:
        ws = wb.active
        ws.title = title
    else:
        ws = wb.create_sheet(title)
    write_sheet(ws, headers, keys, files[title]['data'])

wb.save('./<HID>_合同清单.xlsx')
print("Excel生成完毕！")
for title in files:
    print(f"  {title}: {files[title]['totalCount']} 条")
```

---

## 关键踩坑记录

1. **登录密码必须MD5加密**：CRM前端使用 `jQuery.md5()` 加密密码后提交，服务端通过 `tblOpUser.md5pw=true` 参数判断。

2. **相关列表数据必须用POST**：`/query!getRelatedlistByAjax.action` 用GET请求会返回NullPointerException，必须POST且设置 `Content-Type: application/x-www-form-urlencoded`。

3. **CC人名/名称后缀**：JSON中类似 `cpmc`（ID）对应的显示名是 `cpmcccname`（中文名），导出时使用带 `ccname` 后缀的字段获取可读名称。

4. **Cookie保持**：所有请求必须携带同一个cookie文件（`-b /tmp/crm_cookies.txt`），否则会话失效。

5. **relateid和layoutId的获取**：必须先从合同详情页HTML中解析 `loadRelatedlist()` 调用参数，而不是凭空猜测。

---

## 快速使用命令

```bash
# 1. 设置变量
CRM_HOST="crm.cloudwalk.cn:9443"
USERNAME="your_account"
PASSWORD="your_password"
HID="<由用户提供>"

# 2. 登录
curl -k -s -L -c /tmp/crm_cookies.txt "https://$CRM_HOST/" | grep -oP 'id="loginnum"[^>]*value="[^"]*"'
# 提取 loginnum 值
LOGINNUM="xxx"
MD5_PWD=$(echo -n "$PASSWORD" | md5sum | awk '{print $1}')
curl -k -s -L -c /tmp/crm_cookies.txt -b /tmp/crm_cookies.txt -X POST \
  -d "loginnum=$LOGINNUM&tblOpUser.username=$USERNAME&tblOpUser.pwd=$MD5_PWD&tblOpUser.md5pw=true" \
  "https://$CRM_HOST/Login_userLogin.action" > /dev/null

# 3. 搜索合同
curl -k -s -L -b /tmp/crm_cookies.txt -H "X-Requested-With: XMLHttpRequest" \
  "https://$CRM_HOST/query.action?obj=007&m=listAjaxRecentData&viewId=0&page=1&pageSize=25&searchKeyWord=$HID"
# 从返回JSON中提取 "id" 字段值 → CONTRACT_ID

# 4.（可选）获取详情页确认relateid
curl -k -s -L -b /tmp/crm_cookies.txt \
  "https://$CRM_HOST/query.action?m=query&id=$CONTRACT_ID" > /tmp/contract.html
grep "合同产品清单\|合同物料清单\|变更产品清单\|变更物料清单" /tmp/contract.html | grep "relatedListjson"

# 5. 获取四个列表数据
CONTRACT_ID="<步骤3提取的合同ID>"
for item in \
  "aee2019A4131357dGTi2:/tmp/crm_contract_product.json" \
  "aee201925B11D83EHNv3:/tmp/crm_contract_material.json" \
  "aee20212F038CC51Wlni:/tmp/crm_change_product.json" \
  "aee2021D7592C3BZdKBX:/tmp/crm_change_material.json"; do
  RID="${item%%:*}"
  FILE="${item##*:}"
  curl -k -s -L -b /tmp/crm_cookies.txt -X POST \
    -H "Content-Type: application/x-www-form-urlencoded" \
    "https://$CRM_HOST/query!getRelatedlistByAjax.action?t=$(date +%s)" \
    -d "layoutId=add2011000049469jBL5&recordId=$CONTRACT_ID&relatedlistId=$RID" \
    > "$FILE"
  echo "OK: $FILE ($(python3 -c "import json;print(json.load(open('$FILE'))['totalCount'])") 条)"
done

# 6. 生成Excel（运行步骤6的完整Python脚本）
python3 export_all_sheets.py
```
