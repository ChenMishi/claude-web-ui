# Claude Web UI 项目开发偏好

## 核心原则
- **通用性优先**：所有新增功能和变更必须能在任何机器、任何用户、任何项目安装路径、任何工作目录下正常工作。禁止硬编码路径（如 `/root/`）、端口（如 `3000`）、用户 ID（如固定 UUID）。必须使用 `os.homedir()`、环境变量、动态配置等方式适配不同环境。

## 安全约束
- 所有开发更改操作只在本地执行，未经允许不得在其他机器上执行任务
- 未经允许不得去其他机器检查

## 工作流程
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

### 8. 会话 binding 的正确方式
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
