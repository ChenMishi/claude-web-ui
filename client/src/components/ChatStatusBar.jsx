import { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { IconDoubleCheck } from './icons';

// Tool name → { icon, label, animClass }
const TOOL_STATUS = {
  Read:      { icon: '📖', label: '读取中', cls: 'spin-slow' },
  Grep:      { icon: '📖', label: '读取中', cls: 'spin-slow' },
  Glob:      { icon: '📖', label: '读取中', cls: 'spin-slow' },
  Write:     { icon: '✏️', label: '编辑中', cls: 'bounce' },
  Edit:      { icon: '✏️', label: '编辑中', cls: 'bounce' },
  Bash:      { icon: '⚙️', label: '执行中', cls: 'spin' },
  WebSearch: { icon: '🔍', label: '搜索中', cls: 'pulse' },
  WebFetch:  { icon: '🔍', label: '搜索中', cls: 'pulse' },
  TaskCreate:{ icon: '📋', label: '任务中', cls: '' },
  TaskUpdate:{ icon: '📋', label: '任务中', cls: '' },
  Task:      { icon: '📋', label: '任务中', cls: '' },
  Agent:     { icon: '🤖', label: '调度中', cls: 'pulse' },
};

const PHASE_STATUS = {
  thinking:   { icon: '💭', label: '思考中', cls: 'pulse' },
  running:    { icon: '🔧', label: '处理中', cls: 'spin' },   // fallback
  responding: { icon: '💬', label: '回复中', cls: 'pulse' },
  done:       { icon: <IconDoubleCheck />, label: '已完成', cls: 'done-icon' },
};

export default function ChatStatusBar() {
  const { execStatus, currentSessionId } = useApp();
  const { phase, detail } = execStatus;
  const [visible, setVisible] = useState(false);
  const executionSessionRef = useRef(null);  // 哪个会话正在执行（null = 无执行）
  const prevPhaseRef = useRef(phase);

  // Derive display state from phase + tool name
  let icon, label, animClass;
  let isDone = false;

  if (phase === 'done') {
    icon = PHASE_STATUS.done.icon;
    label = PHASE_STATUS.done.label;
    animClass = PHASE_STATUS.done.cls;
    isDone = true;
  } else if (phase === 'thinking' || phase === 'responding') {
    icon = PHASE_STATUS[phase].icon;
    label = PHASE_STATUS[phase].label;
    animClass = PHASE_STATUS[phase].cls;
  } else if (phase === 'running') {
    const toolName = (detail || '').split(':')[0];
    const tool = TOOL_STATUS[toolName];
    if (tool) {
      icon = tool.icon;
      label = tool.label;
      animClass = tool.cls;
    } else {
      icon = PHASE_STATUS.running.icon;
      label = PHASE_STATUS.running.label;
      animClass = PHASE_STATUS.running.cls;
    }
  }

  // Show/hide: idle → hide, non-idle → show
  // 仅在从 idle 首次进入执行时绑定到当前会话，后续 phase 变化不重新绑定
  useEffect(() => {
    const prevPhase = prevPhaseRef.current;
    prevPhaseRef.current = phase;

    if (phase === 'idle') {
      setVisible(false);
      executionSessionRef.current = null;
      return;
    }

    // 仅在从 idle 首次进入执行状态时绑定到当前会话
    if (prevPhase === 'idle') {
      executionSessionRef.current = currentSessionId;
    }
    setVisible(true);
  }, [phase]);

  // 只在正在执行的会话显示
  const isExecutionSession = executionSessionRef.current === currentSessionId;

  if (!visible || !icon || !label || !isExecutionSession) return null;

  return (
    <div className={`chat-status-bar ${isDone ? 'is-done' : ''}`}>
      <span className={`chat-status-icon ${animClass}`}>{icon}</span>
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
