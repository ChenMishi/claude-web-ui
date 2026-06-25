import { useApp } from '../context/AppContext';
import { IconDoubleCheck } from './icons';

function fmtTime(s) {
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtTok(n) {
  if (!n && n !== 0) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const PHASE_LABEL = { thinking: '思考中', running: '执行中', responding: '生成中', done: '已完成' };

const PHASE_STATUS = {
  thinking:   { icon: '💭', cls: 'pulse' },
  running:    { icon: '🔧', cls: 'flipy' },
  responding: { icon: '💬', cls: 'pulse' },
};

const TOOL_STATUS = {
  Bash:  { icon: '⚙️', cls: 'spin',   label: '执行中' },
  Read:  { icon: '📖', cls: 'pulse',  label: '读取中' },
  Grep:  { icon: '🔍', cls: 'pulse',  label: '查找中' },
  Glob:  { icon: '🔍', cls: 'pulse',  label: '查找中' },
  Write: { icon: '✏️', cls: 'bounce', label: '写入中' },
  Edit:  { icon: '✏️', cls: 'bounce', label: '编辑中' },
};

export default function ExecutionBar() {
  const { execStatus } = useApp();
  const { phase, detail, elapsed, tokens, cost, currency } = execStatus;

  if (phase === 'idle') return null;

  const done = phase === 'done';

  // Determine icon + animation class + label
  let icon, animCls, label;
  if (done) {
    icon = <IconDoubleCheck />;
    animCls = 'done-icon';
    label = PHASE_LABEL.done;
  } else if (phase === 'running') {
    const toolName = (detail || '').split(':')[0];
    const tool = TOOL_STATUS[toolName];
    icon = tool ? tool.icon : PHASE_STATUS.running.icon;
    animCls = tool ? tool.cls : PHASE_STATUS.running.cls;
    label = tool ? tool.label : PHASE_LABEL.running;
  } else if (PHASE_STATUS[phase]) {
    icon = PHASE_STATUS[phase].icon;
    animCls = PHASE_STATUS[phase].cls;
    label = PHASE_LABEL[phase] || phase;
  }

  const tok = tokens || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const cacheEl = tok.cacheRead > 0 ? <span key="cache">📥 {fmtTok(tok.cacheRead)}</span> : null;
  const tokEls = [];
  if (!done) {
    tokEls.push(<span key="io">↑↓ {fmtTok(tok.input)}</span>);
    if (cacheEl) tokEls.push(cacheEl);
  } else {
    if (tok.input > 0) tokEls.push(<span key="in">↑ {fmtTok(tok.input)}</span>);
    tokEls.push(<span key="out">↓ {fmtTok(tok.output)}</span>);
    if (cacheEl) tokEls.push(cacheEl);
  }
  const hasTok = tokEls.length > 0;

  return (
    <div className={`exec-bar ${done ? 'done' : ''}`}>
      <span className={`exec-bar-symbol ${animCls}`}>{icon}</span>
      <span className="exec-bar-action">{label}{!done && (
        <span className="exec-bar-dots">
          <span className="dot">.</span>
          <span className="dot">.</span>
          <span className="dot">.</span>
        </span>
      )}</span>
      {!done && (
        <span className="exec-bar-meta">
          ({fmtTime(elapsed)} · {tokEls} · {phase})
        </span>
      )}
      {done && hasTok && (
        <span className="exec-bar-summary">({fmtTime(elapsed)}) {tokEls}</span>
      )}
      {cost != null && (
        <span className="exec-bar-cost">{currency || '$'}{cost.toFixed(4)}</span>
      )}
    </div>
  );
}
