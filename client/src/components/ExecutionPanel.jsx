import { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';

const TOOL_ICONS = { Bash: '▶', Read: '📄', Write: '✏', Edit: '🔧', Glob: '🔍', Grep: '🔎', AskUserQuestion: '❓' };
const TOOL_VERBS = { Bash: '执行', Read: '读取', Write: '写入', Edit: '编辑', Glob: '搜索', Grep: '查找', AskUserQuestion: '询问' };

export default function ExecutionPanel() {
  const { chatMessages, isStreaming } = useApp();
  const [steps, setSteps] = useState([]);
  const stepsRef = useRef(null);

  useEffect(() => {
    if (stepsRef.current) {
      stepsRef.current.scrollTop = stepsRef.current.scrollHeight;
    }
  }, [steps]);

  useEffect(() => {
    let lastUserIdx = -1;
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) { setSteps([]); return; }

    const newSteps = [];
    for (let i = lastUserIdx + 1; i < chatMessages.length; i++) {
      const msg = chatMessages[i];

      // ── Thinking ──
      if (msg.role === 'thinking' && msg.content) {
        const text = msg.content;
        const summary = text.length > 40 ? text.slice(0, 40) + '…' : text;
        newSteps.push({ id: `think-${i}`, type: 'thinking', summary, detail: text, status: 'done' });
      }

      // ── Assistant text ──
      if (msg.role === 'assistant' && msg.content) {
        const text = msg.content;
        const summary = text.length > 60 ? text.slice(0, 60) + '…' : text;
        // Merge with previous assistant step if streaming (update in place)
        const last = newSteps[newSteps.length - 1];
        if (last && last.type === 'assistant' && msg.streaming) {
          last.summary = summary;
          last.detail = text;
          last.status = isStreaming ? 'running' : 'done';
        } else {
          newSteps.push({ id: `asst-${i}`, type: 'assistant', summary, detail: text, status: msg.streaming ? 'running' : 'done' });
        }
      }

      // ── Tool call ──
      if (msg.toolCall) {
        const { name, input, tool_use_id } = msg.toolCall;
        const desc = input?.description || input?.command || input?.file_path || '';
        const verb = TOOL_VERBS[name] || name;
        const action = desc ? `${verb} ${desc.slice(0, 60)}` : `${verb} ${name}`;
        newSteps.push({ id: tool_use_id, type: 'toolCall', tool: name, action, input, status: 'running' });
      }

      // ── Tool result ──
      if (msg.toolResult) {
        const existing = newSteps.find(s => s.id === msg.toolResult.tool_use_id);
        if (existing) {
          existing.status = msg.toolResult.is_error ? 'error' : 'done';
          existing.result = msg.toolResult.content || '';
        }
      }
    }
    setSteps(newSteps);
  }, [chatMessages, isStreaming]);

  const total = steps.length;
  const doneCount = steps.filter(s => s.status === 'done').length;
  const runningCount = steps.filter(s => s.status === 'running').length;

  return (
    <div className="exec-panel">
      <div className="exec-panel-header">
        <span className="exec-panel-title">
          {runningCount > 0 ? '⏳' : '✅'} 执行步骤{total > 0 ? ` (${doneCount}/${total})` : ''}
        </span>
      </div>
      <div className="exec-panel-steps" ref={stepsRef}>
        {steps.length === 0 ? (
          <div className="panel-empty">暂无执行步骤</div>
        ) : (
          steps.map((s, i) => (
            <StepItem key={s.id || i} step={s} />
          ))
        )}
      </div>
    </div>
  );
}

function StepItem({ step }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!(step.detail || step.result);

  if (step.type === 'thinking') {
    return (
      <div className="exec-step exec-step-think done" onClick={() => step.detail && setOpen(!open)}>
        <div className="exec-step-header">
          <span className="exec-step-status">💭</span>
          <span className="exec-step-action think">{step.summary}</span>
          {step.detail && <span className="exec-step-toggle">{open ? '▲' : '▼'}</span>}
        </div>
        {open && step.detail && (
          <div className="exec-step-result"><pre>{step.detail.slice(0, 2000)}</pre></div>
        )}
      </div>
    );
  }

  if (step.type === 'assistant') {
    const statusIcon = step.status === 'running' ? '⏳' : '💬';
    return (
      <div className={`exec-step exec-step-asst ${step.status}`} onClick={() => step.detail && setOpen(!open)}>
        <div className="exec-step-header">
          <span className="exec-step-status">{statusIcon}</span>
          <span className="exec-step-action asst">{step.summary}</span>
          {step.detail && <span className="exec-step-toggle">{open ? '▲' : '▼'}</span>}
        </div>
        {open && step.detail && (
          <div className="exec-step-result"><pre>{step.detail.slice(0, 2000)}</pre></div>
        )}
      </div>
    );
  }

  // toolCall
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
