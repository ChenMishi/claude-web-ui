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
  const { sessionExecStatus, currentSessionId } = useApp();
  const status = sessionExecStatus[currentSessionId];
  const phase = status?.phase;
  const detail = status?.detail;
  const [doneVisible, setDoneVisible] = useState(false);
  const doneTimerRef = useRef(null);

  // 完成后 5 秒自动消失，与 ExecutionBar 同步
  useEffect(() => {
    if (phase === 'done') {
      setDoneVisible(true);
      doneTimerRef.current = setTimeout(() => setDoneVisible(false), 5000);
    } else {
      setDoneVisible(false);
      if (doneTimerRef.current) { clearTimeout(doneTimerRef.current); doneTimerRef.current = null; }
    }
    return () => { if (doneTimerRef.current) clearTimeout(doneTimerRef.current); };
  }, [phase]);

  if (!phase || phase === 'idle') return null;
  if (phase === 'done' && !doneVisible) return null;

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
    const idx = (detail || '').indexOf(':');
    const toolName = idx > 0 ? detail.slice(0, idx) : detail;
    const desc = idx > 0 ? detail.slice(idx + 1) : '';
    icon = TOOL_SYMBOLS[toolName] || '#';
    const verb = TOOL_VERBS[toolName] || toolName;
    label = desc ? `${verb} ${desc}` : `${verb} ${toolName}`;
  } else if (phase === 'responding') {
    icon = '⚡';
    label = '生成回复';
  }

  if (!icon || !label) return null;

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
