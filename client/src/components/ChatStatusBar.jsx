import { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';

const TOOL_SYMBOLS = {
  Bash: '▶️', Read: '📖', Write: '✏️', Edit: '⚙️',
  Glob: '🔍', Grep: '🔎', AskUserQuestion: '❓',
};

const TOOL_VERBS = {
  Bash: '执行', Read: '读取', Write: '写入', Edit: '编辑',
  Glob: '搜索', Grep: '查找', AskUserQuestion: '询问',
};

export default function ChatStatusBar() {
  const { execStatus, currentSessionId } = useApp();
  const { phase, detail } = execStatus;
  const [visible, setVisible] = useState(false);
  const executionSessionRef = useRef(null);
  const prevPhaseRef = useRef(phase);

  let icon, label;
  let isDone = false;

  if (phase === 'done') {
    icon = '✅';
    label = '完成';
    isDone = true;
  } else if (phase === 'thinking') {
    icon = '⏱️';
    label = detail || '思考中';
  } else if (phase === 'running') {
    const idx = detail.indexOf(':');
    const toolName = idx > 0 ? detail.slice(0, idx) : detail;
    const desc = idx > 0 ? detail.slice(idx + 1) : '';
    icon = TOOL_SYMBOLS[toolName] || '#';
    const verb = TOOL_VERBS[toolName] || toolName;
    label = desc ? `${verb} ${desc}` : `${verb} ${toolName}`;
  } else if (phase === 'responding') {
    icon = '⚡';
    label = '生成回复';
  }

  useEffect(() => {
    const prevPhase = prevPhaseRef.current;
    prevPhaseRef.current = phase;

    if (phase === 'idle') {
      setVisible(false);
      executionSessionRef.current = null;
      return;
    }

    if (prevPhase === 'idle') {
      executionSessionRef.current = currentSessionId;
    }
    setVisible(true);
  }, [phase]);

  const isExecutionSession = executionSessionRef.current === currentSessionId;

  if (!visible || !icon || !label || !isExecutionSession) return null;

  return (
    <div className={`chat-status-bar ${isDone ? 'is-done' : ''}`}>
      <span className="chat-status-icon">{icon}</span>
      <span className="chat-status-text">{label}</span>
      {!isDone && (
        <span className="chat-status-dots">
          <span className="dot">.</span>
          <span className="dot">.</span>
          <span className="dot">.</span>
        </span>
      )}
    </div>
  );
}
