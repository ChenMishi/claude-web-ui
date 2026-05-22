import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';

const TOOL_ICONS = { Bash: '▶', Read: '📄', Write: '✏', Edit: '🔧', Glob: '🔍', Grep: '🔎', AskUserQuestion: '❓' };
const TOOL_VERBS = { Bash: '执行', Read: '读取', Write: '写入', Edit: '编辑', Glob: '搜索', Grep: '查找', AskUserQuestion: '询问' };

export default function ExecutionPanel() {
  const { chatMessages, isStreaming } = useApp();
  const [steps, setSteps] = useState([]);

  // Parse tool calls and results — only from the latest turn (after last user message)
  useEffect(() => {
    // Find last user message index; if none, no steps
    let lastUserIdx = -1;
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) { setSteps([]); return; }

    const newSteps = [];
    for (let i = lastUserIdx + 1; i < chatMessages.length; i++) {
      const msg = chatMessages[i];
      if (msg.toolCall) {
        const { name, input, tool_use_id } = msg.toolCall;
        const desc = input?.description || input?.command || input?.file_path || '';
        const verb = TOOL_VERBS[name] || name;
        const action = desc ? `${verb} ${desc.slice(0, 60)}` : `${verb} ${name}`;
        newSteps.push({ id: tool_use_id, tool: name, action, input, status: 'running' });
      }
      if (msg.toolResult) {
        const existing = newSteps.find(s => s.id === msg.toolResult.tool_use_id);
        if (existing) {
          existing.status = msg.toolResult.is_error ? 'error' : 'done';
          existing.result = msg.toolResult.content || '';
        }
      }
    }
    setSteps(newSteps);
  }, [chatMessages]);

  const runningCount = steps.filter(s => s.status === 'running').length;
  const doneCount = steps.filter(s => s.status === 'done').length;

  return (
    <div className="exec-panel">
      <div className="exec-panel-header">
        <span className="exec-panel-title">
          {runningCount > 0 ? '⏳' : '✅'} 执行步骤{steps.length > 0 ? ` (${doneCount}/${steps.length})` : ''}
        </span>
      </div>
      <div className="exec-panel-steps">
          {steps.length === 0 ? (
            <div className="panel-empty">暂无执行步骤</div>
          ) : (
            steps.map((s, i) => (
              <StepItem key={s.id || i} step={s} index={i} />
            ))
          )}
        </div>
    </div>
  );
}

function StepItem({ step, index }) {
  const [open, setOpen] = useState(false);
  const icon = TOOL_ICONS[step.tool] || '🔨';
  const statusIcon = step.status === 'running' ? '⏳' : step.status === 'error' ? '❌' : '✅';

  return (
    <div className={`exec-step ${step.status}`}>
      <div className="exec-step-header" onClick={() => step.result && setOpen(!open)}>
        <span className="exec-step-status">{statusIcon}</span>
        <span className="exec-step-icon">{icon}</span>
        <span className="exec-step-tool">{step.tool}</span>
        <span className="exec-step-action">{step.action.slice(0, 60)}{step.action.length > 60 ? '…' : ''}</span>
        {step.result && (
          <span className="exec-step-toggle">{open ? '▲' : '▼'}</span>
        )}
      </div>
      {open && step.result && (
        <div className="exec-step-result">
          <pre>{typeof step.result === 'string' ? step.result.slice(0, 2000) : JSON.stringify(step.result, null, 2).slice(0, 2000)}</pre>
        </div>
      )}
    </div>
  );
}
