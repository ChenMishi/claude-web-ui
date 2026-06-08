# Claude Web UI

基于 Claude Agent SDK 的 Web 管理界面，提供多用户对话管理、文件管理、终端、技能系统等功能。

## 功能特性

- **多用户支持** — 管理员/普通用户角色，独立数据隔离，可选认证模式
- **Claude Agent 对话** — SSE 流式响应、工具调用展示、思考过程、会话管理
- **文件管理** — 服务器目录浏览/上传/下载，本地 Windows 目录浏览（File System Access API）
- **Web 终端** — 基于 xterm.js + node-pty 的浏览器终端
- **技能系统** — 分层存储（内置/共享/个人/项目），YAML 解析，工具权限覆盖，支持 .md 文件导入
- **数据统计** — Token 用量图表、模型分布、会话统计
- **备份恢复** — 定时自动备份、手动恢复、支持 Git 远程推送
- **Token 定价** — 按模型自定义输入/输出/缓存价格（¥）
- **版本升级** — 在线检测新版本，一键升级 + 进度展示
- **项目链接** — 多工作目录管理，CLAUDE.md 初始化
- **内部代理** — 内置 HTTP 反向代理，无需外挂 CC-Switch
- **深色/浅色/暖色** 三套主题

## 技术栈

| 层 | 技术 |
|------|------|
| 前端 | React 19 + Vite 8 |
| 后端 | Express.js |
| Agent | @anthropic-ai/claude-agent-sdk |
| 终端 | node-pty + xterm.js + WebSocket |
| 认证 | JWT + bcrypt |

## 快速开始

### 环境要求

- Linux 服务器（Ubuntu/Debian/CentOS/Alpine/Arch）
- 推荐 Node.js >= 20（脚本会自动安装）
- Claude Code CLI（Agent SDK 通过内置代理连接 API）

### 一键部署

**Step 1 — 克隆仓库**

```bash
git clone https://github.com/ChenMishi/claude-web-ui.git
```

**Step 2 — 进入目录，运行部署**

```bash
cd claude-web-ui

# 基础部署（默认端口 3000，管理员密码自动生成）
./deploy.sh

# 指定端口
./deploy.sh 8080
```

**Step 3 — 等待完成，按提示访问**

部署脚本会自动完成：
1. 安装系统工具（git、curl、lsof）
2. 安装/升级 Node.js 22.x
3. 安装编译工具（make、gcc、python3）
4. 安装服务端和前端依赖
5. 编译原生模块（node-pty、bcrypt）
6. 检测 SDK 二进制兼容性并修复
7. 构建前端
8. 启动服务

完成后终端打印访问地址和管理员账号密码，浏览器打开即可登录。

### 登录后初始化

1. 使用浏览器打开服务地址，以 `admin` 身份登录
2. 进入 **设置 → 🔧 初始化**：
   - 检测/安装 Claude Code CLI
   - 配置 API Provider（API Key、Base URL、Chat URL、默认模型）
   - 配置内部代理监听地址
   - 创建项目 CLAUDE.md 文档
3. 进入 **设置 → 🔄 升级** 可配置 Git 仓库地址用于在线更新

### 管理命令

```bash
./start.sh                   # 启动服务
./stop.sh                    # 停止服务
./upgrade.sh                 # 在线升级到最新版本
./bump.sh                    # 版本号自增（x.y.z → x.y.z+1）
./reset-admin-password.sh    # 重置管理员密码（交互式）
```

### 开发模式

```bash
# 前端热更新（:5173），后端（:3000）
npm run dev
```

### 配置参考

| 环境变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `AUTH_MODE` | 认证模式：`optional` / `required` / `disabled` | `optional` |
| `ADMIN_PASSWORD` | 管理员密码（首次启动自动生成） | — |
| `JWT_SECRET` | JWT 签名密钥（自动生成） | — |
| `GIT_REPO` | Git 仓库地址（deploy.sh 使用） | — |

**认证模式说明**：
- `optional`（默认）：不登录可浏览页面，执行操作时要求登录
- `required`：所有访问必须先登录
- `disabled`：完全关闭认证（不推荐公网使用）

## 项目结构

```
claude-web-ui/
├── server.js                  # 入口
├── pricing-config.json        # Token 定价配置
├── VERSION                    # 当前版本号
├── server/
│   ├── index.js               # Express 主文件
│   ├── config.js              # 配置
│   ├── proxy.js               # 内置 API 代理
│   ├── routes/                # API 路由
│   │   ├── auth.js            # 认证、用户管理
│   │   ├── backup.js          # 备份与恢复
│   │   ├── chat.js            # Agent 对话（SSE）
│   │   ├── fs.js              # 文件系统操作
│   │   ├── health.js          # 健康检查
│   │   ├── init.js            # 初始化 & Provider 配置 & CC 安装升级
│   │   ├── project.js         # 项目管理
│   │   ├── session.js         # 会话管理
│   │   ├── skills.js          # 技能 CRUD
│   │   ├── stats.js           # 数据统计
│   │   ├── terminal.js        # WebSocket 终端
│   │   └── version.js         # 版本检测/升级
│   ├── auth/                  # JWT、用户存储
│   ├── skills/                # 技能存储层
│   ├── builtin-skills/        # 内置技能
│   ├── middleware/             # 认证中间件
│   ├── store.js               # 数据持久化
│   └── utils.js               # 工具函数
├── client/
│   └── src/
│       ├── components/        # React 组件
│       ├── context/           # AppContext 全局状态
│       ├── api.js             # API 封装
│       └── styles/            # CSS
├── public/                    # 前端构建产物（Vite 输出）
└── skills/                    # 用户自定义技能
```

## API 概览

### 认证
| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/auth/login` | POST | 登录 |
| `/api/auth/refresh` | POST | 刷新 Token |
| `/api/auth/status` | GET | 认证状态 |
| `/api/auth/me/password` | PUT | 修改自己的密码 |
| `/api/auth/me/avatar` | PUT | 更新头像 |
| `/api/auth/users` | GET/POST | 用户管理（管理员） |
| `/api/auth/users/:id` | DELETE | 删除用户（管理员） |
| `/api/auth/restart` | POST | 重启服务（管理员） |

### 对话
| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/chat` | POST | 独立对话（SSE 流式） |
| `/api/session/:id/message` | POST | 会话消息（SSE） |
| `/api/session/:id/abort` | POST | 中止对话 |
| `/api/session/:id/stream` | GET | 重连 SSE 流 |
| `/api/session/:id/message/resolve` | POST | 恢复中断的消息 |
| `/api/session/:id/title` | PUT | 修改会话标题 |

### 模型
| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/models` | GET | 获取可用模型列表 |
| `/api/models/switch` | POST | 切换当前模型 |

### 项目 & 会话
| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/projects` | GET/POST/DELETE | 项目管理 |
| `/api/project/:id/tree` | GET | 项目文件树 |
| `/api/project/:id/file` | GET | 读取项目文件 |
| `/api/sessions` | GET/POST/DELETE | 会话管理 |
| `/api/sessions/:id/messages` | GET | 获取历史消息 |

### 文件系统
| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/fs/list` | GET | 列出目录 |
| `/api/fs/dirs` | GET | 获取常用目录 |
| `/api/fs/read` | GET | 读取文件内容 |
| `/api/fs/write` | POST | 写入文件 |
| `/api/fs/mkdir` | POST | 创建目录 |
| `/api/fs/delete` | POST | 删除文件/目录 |
| `/api/fs/upload` | POST | 上传文件 |
| `/api/fs/download` | GET | 下载文件 |
| `/api/fs/copy` | POST | 服务端复制 |

### 技能
| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/skills` | GET | 技能列表 |
| `/api/skills` | POST | 创建技能 |
| `/api/skills/:id` | PUT/DELETE | 更新/删除技能 |
| `/api/skills/:id/toggle` | POST | 启用/禁用技能 |
| `/api/skills/marketplace` | GET | 市场技能列表 |
| `/api/skills/parse-md` | POST | 解析 .md 技能文件 |
| `/api/skills/import-file` | POST | 导入 .md 技能文件 |

### 初始化 & 升级
| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/init/status` | GET | 系统初始化状态 |
| `/api/init/install-claude` | POST | 安装 Claude Code CLI |
| `/api/init/install-sdk` | POST | 安装 SDK 原生模块 |
| `/api/init/check-claude-update` | POST | 检查 Claude Code 更新 |
| `/api/init/upgrade-claude` | POST | 升级 Claude Code |
| `/api/init/provider-config` | GET/POST | Provider 配置 |
| `/api/init/fetch-models` | POST | 从 API 拉取模型列表 |
| `/api/init/test-proxy` | POST | 测试代理连接 |
| `/api/init/pricing` | GET/POST | Token 定价配置 |
| `/api/init/log-error` | POST | 前端错误日志 |
| `/api/init/log-errors` | GET | 查看错误日志 |

### 统计
| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/stats/summary` | GET | 使用概览 |
| `/api/stats/usage` | GET | 用量详情 |

### 备份
| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/backup/config` | GET/POST | 备份配置 |
| `/api/backup/now` | POST | 立即备份 |
| `/api/backup/list` | GET | 备份列表 |
| `/api/backup/restore/:id` | POST | 恢复备份 |
| `/api/backup/delete/:id` | DELETE | 删除备份 |

### 版本 & 健康
| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/version/info` | GET | 版本信息 |
| `/api/version/check` | POST | 检测更新 |
| `/api/version/upgrade` | POST | 执行升级 |
| `/api/version/upgrade/status` | GET | 升级进度 |
| `/api/version/upgrade/log` | GET | 升级日志 |
| `/api/health` | GET | 健康检查 |

## 文件传输

文件传输对话框（📁 文件传输）支持两种模式：

- **上传** — 左侧浏览服务器目标目录，右侧浏览本地 Windows 目录（需 Chrome/Edge，首次点「选择本地文件夹」授权，后续自动恢复）
- **下载** — 左侧勾选服务器文件，下载到浏览器默认目录

## 技能系统

技能按优先级叠加：项目 > 个人 > 共享 > 内置。每个技能可配置：
- 触发关键词、描述、图标、分类
- Claude 模型选择（opus/sonnet/haiku）
- 工具权限模式覆盖
- 自定义 system prompt 片段

支持从 .md 文件导入技能，YAML frontmatter 定义元数据。

## License

MIT
