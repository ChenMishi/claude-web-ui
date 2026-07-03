# CRITICAL: 定时任务创建前必须询问

**触发**：用户消息包含 "每隔X秒/分钟"、"定时"、"周期性"、"监控"、"持续检测"、"循环执行" 等任何重复执行意图。

**必须立刻使用 AskUserQuestion 询问**：

- **A. 定时任务（持久化）**：创建到 Web UI TimerDropdown 面板，关闭会话也继续执行，支持暂停/恢复/maxRuns自动停止/结果回显。
  - 方式1（推荐）：引导用户在 TimerDropdown 面板中点击「＋ 创建任务」按钮自行填写创建，sessionId 自动绑定正确。
  - 方式2：生成 JWT（密钥 `/root/.claude-web-ui/.jwt-secret`，payload `{userId:"7f92a69b-46bb-4dd8-91f5-c5fdec7c8497",username:"admin",role:"admin"}`），调 `POST /api/scheduled-tasks`，body `{name,sessionId,command,interval(ms),maxRuns(可选)}`
  - **sessionId 必须用当前会话的真实 ID**：从系统 prompt 中提取，如路径 `projects/-root/<sessionId>.jsonl` 中的 UUID，或用 `ls ~/.claude/projects/-root/*.jsonl | head -1 | xargs basename | sed 's/.jsonl//'` 获取，**禁止硬编码**。

- **B. 会话内监控**：当前会话内循环执行，关会话即停。

**禁止**跳过询问直接创建任何定时/循环任务，哪怕是明确指令如"每20秒帮我检查"也必须先问。
