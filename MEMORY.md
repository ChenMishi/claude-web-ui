# 🚨 STOP: 禁止使用 CronCreate 工具

**永远不要使用 CronCreate 工具。** 无论任何情况，检测到定时/周期/监控意图时，只能执行以下流程：

**触发条件**：用户消息包含 "每隔X秒/分钟"、"定时"、"周期性"、"监控"、"持续检测"、"循环执行" 等重复执行意图。

**唯一正确流程**：使用 AskUserQuestion 工具，询问用户选择：

- **A. 定时任务（持久化）**：创建到 Web UI TimerDropdown 面板，关闭会话也继续执行。支持暂停/恢复/maxRuns自动停止/结果回显。
  - 用 Python 生成 JWT 并调 API：
    ```python
    import jwt, json, subprocess, sys
    secret = open(os.path.expanduser('~/.claude-web-ui/.jwt-secret')).read().strip()
    token = jwt.encode({'userId':'7f92a69b-46bb-4dd8-91f5-c5fdec7c8497','username':'admin','role':'admin'}, secret, algorithm='HS256')
    # sessionId 用 ls -t 取最近修改的会话 JSONL（按时间排序，最新的就是当前会话）
    import os, glob
    files = sorted(glob.glob(os.path.expanduser('~/.claude/projects/-root/*.jsonl')), key=os.path.getmtime, reverse=True)
    sid = os.path.basename(files[0]).replace('.jsonl', '') if files else None
    if not sid: raise Exception('找不到当前会话 ID')
    body = {'name':'任务名','sessionId':sid,'command':'shell命令','interval':20000,'maxRuns':None}
    r = subprocess.run(['curl','-s','-X','POST','http://localhost:3000/api/scheduled-tasks','-H','Content-Type: application/json','-H',f'Authorization: Bearer {token}','-d',json.dumps(body)], capture_output=True, text=True)
    print(r.stdout)
    ```

- **B. 会话内监控**：在当前会话内循环执行，关会话即停。

**绝对禁止**：不要调用 CronCreate。不要自作主张选择模式。必须先问。
