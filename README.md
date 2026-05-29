# Claude Web UI

基于 Claude Agent SDK 的 Web 管理界面，提供多用户对话管理、文件管理、终端、技能系统等功能。

## 功能特性

- **多用户支持** — 管理员/普通用户角色，独立数据隔离，可选认证模式
- **Claude Agent 对话** — SSE 流式响应、工具调用展示、会话管理
- **文件管理** — 服务器目录浏览/上传/下载，本地 Windows 目录浏览（File System Access API）
- **Web 终端** — 基于 xterm.js + node-pty 的浏览器终端
- **技能系统** — 分层存储（内置/共享/个人/项目），YAML 解析，工具权限覆盖
- **版本升级** — 在线检测新版本，一键升级 + 进度展示
- **项目链接** — 多工作目录管理，CLAUDE.md 初始化
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

- Node.js >= 18
- Claude Code CLI（用于 Agent SDK 调用）
- Git（用于版本升级功能）

### 安装

```bash
git clone <仓库地址>
cd claude-web-ui
npm install
cd client && npm install && npm run build && cd ..
```

### 启动

```bash
# 生产模式（端口 3000）
npm start

# 开发模式（前端热更新 :5173，后端 :3000）
npm run dev
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `CLAUDE_PROXY` | Claude Agent 代理地址 | `http://127.0.0.1:15721` |
| `AUTH_MODE` | 认证模式：`optional` / `required` / `disabled` | `optional` |
| `ADMIN_PASSWORD` | 管理员密码（首次启动时设置） | — |
| `JWT_SECRET` | JWT 签名密钥（自动生成） | — |

### 认证模式

- **optional**（默认）：不登录可浏览，操作时要求登录
- **required**：必须登录才能访问
- **disabled**：完全关闭认证

首次启动时若未设置管理员密码，可通过 Web 界面初始化。

## 项目结构

```
claude-web-ui/
├── server.js              # 入口
├── server/
│   ├── index.js           # Express 主文件
│   ├── config.js          # 配置
│   ├── routes/            # API 路由
│   │   ├── auth.js        # 认证、用户管理
│   │   ├── chat.js        # Agent 对话（SSE）
│   │   ├── fs.js          # 文件系统操作
│   │   ├── project.js     # 项目管理
│   │   ├── session.js     # 会话管理
│   │   ├── skills.js      # 技能 CRUD
│   │   ├── terminal.js    # WebSocket 终端
│   │   ├── version.js     # 版本检测/升级
│   │   ├── init.js        # 项目初始化
│   │   └── health.js      # 健康检查
│   ├── auth/              # JWT、用户存储
│   ├── skills/            # 技能存储层
│   ├── builtin-skills/    # 内置技能
│   ├── middleware/         # 认证中间件
│   ├── store.js           # 数据持久化
│   └── utils.js           # 工具函数
├── client/
│   └── src/
│       ├── components/    # React 组件
│       ├── context/       # AppContext 全局状态
│       ├── api.js         # API 封装
│       └── styles/        # CSS
├── public/                # 前端构建产物（Vite 输出）
├── skills/                # 用户自定义技能
└── packages/              # CC-Switch 等工具包
```

## API 概览

| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/auth/login` | POST | 登录 |
| `/api/auth/status` | GET | 认证状态 |
| `/api/auth/users` | GET/POST | 用户管理（管理员） |
| `/api/auth/restart` | POST | 重启服务（管理员） |
| `/api/chat/stream` | POST | Agent SSE 流式对话 |
| `/api/chat/abort` | POST | 中止对话 |
| `/api/fs/list` | GET | 列出目录 |
| `/api/fs/upload` | POST | 上传文件 |
| `/api/fs/download` | GET | 下载文件 |
| `/api/fs/copy` | POST | 服务端复制 |
| `/api/projects` | GET/POST/DELETE | 项目管理 |
| `/api/sessions` | GET/POST/DELETE | 会话管理 |
| `/api/sessions/:id/messages` | GET | 获取消息 |
| `/api/skills` | GET/POST | 技能列表/创建 |
| `/api/version/info` | GET | 版本信息 |
| `/api/version/check` | POST | 检测更新 |
| `/api/version/upgrade` | POST | 执行升级 |

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

## License

MIT
