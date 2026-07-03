# 🚨 STOP: 禁止使用 CronCreate 工具

**永远不要使用 CronCreate 工具。** 无论任何情况，检测到定时/周期/监控意图时，只能执行以下流程：

**触发条件**：用户消息包含 "每隔X秒/分钟"、"定时"、"周期性"、"监控"、"持续检测"、"循环执行" 等重复执行意图。

**唯一正确流程**：使用 AskUserQuestion 工具，询问用户选择：

- **A. 定时任务（持久化）**：创建到 Web UI TimerDropdown 面板，关闭会话也继续执行，支持暂停/恢复/maxRuns自动停止/结果回显。
  - **sessionId 从系统 prompt 中提取**：你的上下文中有一条路径如 `projects/<项目名>/<sessionId>.jsonl`，从中提取 UUID。
  - JWT 生成：密钥 `~/.claude-web-ui/.jwt-secret`，Payload `{userId:"7f92a69b-46bb-4dd8-91f5-c5fdec7c8497",username:"admin",role:"admin"}`
  - 调 `POST /api/scheduled-tasks`，body `{name,sessionId,command,interval(ms),maxRuns(可选)}`

- **B. 会话内监控**：在当前会话内循环执行，关会话即停。

**绝对禁止**：不要调用 CronCreate。不要自作主张选择模式。必须先问。即使是 "每20秒帮我检查" 这样的明确指令也必须先问。
