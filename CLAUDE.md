# Claude Web UI 项目开发偏好

## 核心原则
- **通用性优先**：所有新增功能和变更必须能在任何机器、任何用户、任何项目安装路径、任何工作目录下正常工作。禁止硬编码路径（如 `/root/`）、端口（如 `3000`）、用户 ID（如固定 UUID）。必须使用 `os.homedir()`、环境变量、动态配置等方式适配不同环境。

## 安全约束
- 所有开发更改操作只在本地执行，未经允许不得在其他机器上执行任务
- 未经允许不得去其他机器检查

## 工作流程
- **🚨 禁止使用 Agent/Explore 子代理探索代码**：子代理默认模型不可控，可能因权限不足而失败。探索代码时直接用 Bash(grep/find)、Read、Glob 等工具手动操作，更快更可靠。
- **🚨 禁止自动 git 操作**：代码修改后只能留在本地磁盘。**git add、git commit、git push 都必须等你明确说出"提交"、"推送"或"提交推送"后才能执行。**绝对禁止在改完代码后顺手 commit 或 push。违规一次你提醒我，违规三次你自己动手修正。
- **推送 = 一条提交**：当用户说"推送"时，必须先将所有未推送的 commit squash 为**一条**汇总提交，再推送。
  ```bash
  # 1. 找到第一个未推送 commit 的前一个 commit
  git reset --soft origin/master
  # 2. 合并所有改动为一条提交
  git commit -m "用户指定的汇总信息"
  # 3. 推送
  git push
  ```
- **不要自动重启 web UI 服务**，由用户自行手动重启
- 前端修改后需执行 `cd client && npm run build` 构建到 `public/` 目录
- **版本号变更必须使用 `./bump.sh` 脚本**，不要手动修改版本号。脚本会自动同步所有文件（VERSION、package.json、前端组件、health.js）并构建前端

## 用户交互
- **检测到定时/周期/监控意图时必须先询问**：当用户提到"每隔X秒/分钟检查"、"定时检测"、"监控"、"周期性执行"等意图时，不要让用户去主动选择，你必须在创建前主动询问选择哪种模式：
  - **A. 定时任务（持久化）**：通过 `POST /api/scheduled-tasks` 创建，出现在 TimerDropdown 面板，关掉会话也继续跑，支持暂停/恢复/maxRuns自动停止/结果回显到聊天
  - **B. 会话内监控**：在当前会话里循环执行，关会话就停，适合临时观察
  - JWT 密钥位置：`~/.claude-web-ui/.jwt-secret`，Payload：`{ userId, username: "admin", role: "admin" }`
  - **这条规则在服务启动时自动同步到全局 MEMORY.md**，升级后重启即生效，无需手动操作。

## 文件生成规范
- **生成含中文的 CSV 文件时，必须添加 UTF-8 BOM**（`\xEF\xBB\xBF`），否则 Windows Excel 会用 GBK 打开导致中文乱码
  - Write 工具写入后，用 Bash 执行 `python3` 在文件头补 BOM：
    ```python
    with open('文件路径.csv', 'rb') as f: content = f.read()
    with open('文件路径.csv', 'wb') as f: f.write(b'\xef\xbb\xbf' + content)
    ```

## 提交规范
- 使用中文 commit message
- 备注只写关键的更新、升级或 bug 修复，用简短要点概括，不罗列所有细节

## 踩坑记录（关键经验教训）

### 1. 前端弹窗事件冲突
- **问题**: 自定义确认弹窗的按钮点不动、点确定无反应
- **原因**: `document.addEventListener('mousedown')` 在 React onClick 之前触发，弹窗被误关
- **解决**: 确认弹窗放在组件顶层（不嵌套在 `{show && ...}` 内），用 Portal 渲染到 body，配合 `e.stopPropagation()` + `getBoundingClientRect()` 定位。SessionList 的删除确认弹窗是正确范例

### 2. React 状态更新时序
- **问题**: 中止任务后立即发消息变排队；多会话并行的执行状态/呼吸灯残留
- **原因**: `useState` 更新是异步的，`handleSend` 调 `busySessions.has()` 时读到旧值
- **解决**: 关键状态用 `useRef` 做同步镜像，`busyRef.current.delete()` 立即生效。`SET_STREAMING(false)` 加 `activeStreams > 0` 守卫

### 3. 多会话并行的全局状态
- **问题**: 中止一个会话后所有呼吸灯熄灭、执行状态条消失
- **原因**: `finalizeStreaming()`/`execReset()` 是全局的，没判断是否还有其他会话在跑
- **解决**: 加 `allAbortsRef.current.size === 0` 守卫，只有最后一个会话结束才做全局清理

### 4. 函数式 setState 陷阱
- **问题**: `setScheduledTasks(prev => prev.filter(...))` 导致白屏
- **原因**: AppContext reducer `SET_SCHEDULED_TASKS` 直接把函数当值存了，没调它
- **解决**: reducer 里 `typeof payload === 'function' ? payload(state.xxx) : payload`

### 5. CLI 工具跨目录兼容
- **问题**: `require('jsonwebtoken')` 在 Claude 的任意工作目录下不可用，JWT 生成失败
- **原因**: Node 的 `require` 只在项目目录（有 node_modules）下有效，Claude 会话 cwd 是任意的
- **解决**: 跨目录运行的工具脚本用 Python（`pyjwt`）+ 绝对路径或 `~` 展开，不依赖 Node 的 `require`

### 6. MEMORY.md vs CLAUDE.md 的作用域
- **问题**: 定时任务创建规则在新会话/新机器上不生效
- **原因**: CLAUDE.md 只在项目目录下加载；MEMORY.md 是全局用户级但不随 git 分发
- **解决**: server 启动时自动从项目 `MEMORY.md` → `~/.claude/projects/-root/memory/MEMORY.md`，遍历所有 `/home/*/.claude/` 用户。规则文笔需极端强硬：`🚨 STOP: 禁止 XX 工具`、`唯一正确流程`、`绝对禁止`

### 7. CronCreate vs Web UI 定时任务
- **问题**: Claude 偏好用 CronCreate（CLI cron）而非 Web UI API
- **原因**: 两套系统独立：CLI cron 写 `<cwd>/.claude/scheduled_tasks.json`，Web UI 读 `~/.claude-web-ui/scheduled_tasks.json`
- **解决**: MEMORY.md 顶层 `🚨 STOP: 禁止使用 CronCreate 工具`，TimerDropdown 的 GET API 同时桥接 CLI 文件（从项目目录名反推 cwd）

### 8. 压缩对话上下文的正确方式
- **问题**: 直接用 `curl` 调 `POST /api/session/:id/compact` 跳过了总结步骤，直接删了 JSONL 记录
- **正确流程**: 压缩必须是两阶段：
  1. **先总结**：通过聊天输入框发送"请帮我压缩对话上下文"，让 Claude 生成总结回复
  2. **后裁剪**：前端 ChatView 的 `onDone` 检测到 compact 触发后自动调后端 API 裁剪 JSONL
- **🚨 绝对禁止直接用 curl/httpie 调 `/api/session/:id/compact`** — 必须走前端聊天流程
- **禁止用 Bash 工具发 curl 到 compact 端点**，也禁止手动构造 HTTP 请求调该接口

### 9. 会话 binding 的正确方式
- **问题**: 定时任务结果追加到错误会话、呼吸灯绑定到错误会话
- **原因**: 硬编码 sessionId，切会话后 ID 对不上
- **解决**: sessionId 从系统 prompt 路径 `projects/<项目>/<sessionId>.jsonl` 直接提取 UUID，或通过 TimerDropdown 创建表单自动绑定

## 2025-05-27 工作记录

### 文件传输功能完善（FileTransfer + fs API）

**背景**：FileTransfer.jsx 前端组件存在但后端 API 完全缺失，文件传输功能从未实际可用。

**改动文件**：

| 文件 | 操作 | 说明 |
|------|------|------|
| `server/routes/fs.js` | 新建 | 4 个 API 端点：`GET /api/fs/list`（列目录）、`POST /api/fs/upload`（上传）、`GET /api/fs/download`（下载）、`POST /api/fs/copy`（服务端复制） |
| `server/index.js` | 编辑 | 注册 fs 路由 |
| `client/src/components/FileTransfer.jsx` | 重写 | 完整重构，左侧浏览服务器目录，右侧通过 File System Access API 浏览用户本地 Windows 目录 |
| `client/src/styles/index.css` | 编辑 | 三个主题均添加 `--accent-light` 变量，用于选中条目高亮 |

**核心设计**：

- **左侧「服务器目录」**：通过 `/api/fs/list` 浏览 Linux 服务器文件系统，下载模式勾选文件后下载到浏览器
- **右侧「本地电脑」**：使用 `window.showDirectoryPicker()` 浏览用户 Windows 本机目录
  - 首次需点击「📂 选择本地文件夹」授权（浏览器安全限制，无法绕过）
  - 授权后 `FileSystemDirectoryHandle` 存入 IndexedDB
  - 之后每次打开传输窗口**自动恢复**上次目录，无需再次选择
  - 子目录导航、文件勾选、全选等功能与服务器面板一致
- **上传方式**：勾选的文件通过 `handle.getFile()` 获取 File 对象，走现有 `uploadFile()` base64 上传
- **底部备用**：保留传统 `<input type="file">` 选择文件/文件夹，兼容不支持 File System Access API 的浏览器（Firefox）

**已知限制**：
- 浏览器安全策略要求本地目录浏览必须有用户手势触发，首次必须点击授权
- File System Access API 仅 Chromium 内核浏览器支持（Chrome/Edge）

<!-- KARPATHY_GUIDELINES_START -->
## 🤖 Karpathy 编码规范（AI Agent 行为准则）

> 源自 Andrej Karpathy 对 LLM 编码常见问题的观察。由插件 andrej-karpathy-skills 管理。

### 1. 先想再写 (Think Before Coding)

**不要假设。不要隐藏困惑。明确权衡。**

- 在实现前显式陈述假设。如果不确定，直接问。
- 如果存在多种理解方式，全部列出来 — 不要偷偷选一个。
- 如果有更简单的方法，直接说出来。在需要时回绝不合理的需求。
- 如果有不清楚的地方，停止。说出困惑点。询问。

### 2. 简洁优先 (Simplicity First)

**用最少代码解决问题。不写推测性代码。**

- 不写超出需求范围的功能。
- 不为只使用一次的代码创建抽象。
- 不添加需求之外的"灵活性"或"可配置性"。
- 不处理不可能发生的错误场景。
- 如果写了 200 行代码但 50 行就能解决，重写。

**问自己：** "资深工程师会不会说这过度设计了？" 如果是，简化。

### 3. 手术式修改 (Surgical Changes)

**只动必须动的。只清理你自己弄乱的部分。**

- 不要"顺便优化"相邻代码、注释或格式。
- 不要重构没坏的东西。
- 匹配现有代码风格，即使你更喜欢另一种写法。
- 如果注意到不相关的死代码，提出来 — 但不要删。

当你的修改产生孤立代码时:
- 清理你**自己的**修改导致不再使用的导入/变量/函数。
- 不要删除修改前就存在的死代码，除非明确要求。

**检验标准:** 每一行改动都应能直接追溯到用户的需求。

### 4. 目标驱动执行 (Goal-Driven Execution)

**定义成功标准。循环直到验证通过。**

将任务转化为可验证的目标:
- "加验证" → "为无效输入写测试，让测试通过"
- "修复 Bug" → "写一个能复现 Bug 的测试，然后修到通过"
- "重构 X" → "确保重构前后测试全部通过"

多步骤任务，先写简要计划:
1. [步骤] → 验证: [检查项]
2. [步骤] → 验证: [检查项]

强成功标准让你能自主循环。弱标准 ("让它能用") 需要不断澄清。

| 原则 | 防止什么 |
|------|---------|
| 先想再写 | 默认真假设、隐藏困惑、遗漏权衡 |
| 简洁优先 | 过度工程、臃肿抽象、推测性功能 |
| 手术式修改 | 顺手重写、无关清理、意外行为变更 |
| 目标驱动执行 | 模糊完成标准、未验证的修改 |

<!-- KARPATHY_GUIDELINES_END -->

<!-- BUG_TRACKER_START -->
## 🐛 Bug 追踪器（会话级，全消息激活）

> 由插件 bug-tracker 管理。每次收到用户消息都先读取该会话的历史 Bug 记录，修复后自动归档。

### 每次回复前必须执行

用 Bash 读取当前会话的 Bug 记录文件（session UUID 可从系统提示路径提取）：
```bash
cat ~/.claude-web-ui/bug-records/<session-uuid>.md 2>/dev/null || echo "（无历史记录）"
```

如果不确定 session UUID，用 `ls ~/.claude-web-ui/bug-records/` 查看。

### 修复 Bug 后必须记录

修复完成后追加到记录文件，格式：

```markdown
## Bug #<序号>

- **时间**：<YYYY-MM-DD HH:MM>
- **问题**：<简要描述>
- **根因**：<根本原因>
- **修复**：<方案和关键代码变更>
- **教训**：<如何防止同类问题>
- **关联文件**：<涉及的文件路径>
```

同步更新文件顶部的汇总表格。

### 规则

1. **每轮必读** — 每个回复前先读历史 Bug 记录（静默，不告诉用户）
2. **每 Bug 必录** — 修复即记录
3. **复用经验** — 同类 Bug 引用历史记录编号
<!-- BUG_TRACKER_END -->
