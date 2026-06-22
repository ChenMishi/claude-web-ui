import { useApp } from '../context/AppContext';
// (icons reverted to emoji for execution bar)

const TOOL_SYMBOLS = {
  Bash: '▶️', Read: '📖', Write: '✏️', Edit: '⚙️',
  Glob: '🔍', Grep: '🔎', AskUserQuestion: '❓',
};

const TOOL_VERBS = {
  Bash: '执行', Read: '读取', Write: '写入', Edit: '编辑',
  Glob: '搜索', Grep: '查找', AskUserQuestion: '询问',
};

const PHASE_LABELS = { thinking: 'thinking', running: 'running', responding: 'responding' };

function fmtTime(s) {
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtTok(n) {
  if (!n && n !== 0) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export default function ExecutionBar() {
  const { execStatus } = useApp();
  const { phase, detail, elapsed, tokens, cost, currency } = execStatus;

  if (phase === 'idle') return null;

  const done = phase === 'done';

  let SymbolIcon, action;
  if (phase === 'thinking') {
    SymbolIcon = '⏱️';
    action = detail ? detail.slice(0, 50) + (detail.length > 50 ? '…' : '') : '思考中';
  } else if (phase === 'running') {
    const idx = detail.indexOf(':');
    const toolName = idx > 0 ? detail.slice(0, idx) : detail;
    const desc = idx > 0 ? detail.slice(idx + 1) : '';
    SymbolIcon = TOOL_SYMBOLS[toolName] || '#';
    const verb = TOOL_VERBS[toolName] || toolName;
    action = desc ? `${verb} ${desc}` : `${verb} ${toolName}`;
    if (action.length > 40) action = action.slice(0, 40) + '…';
  } else if (phase === 'responding') {
    SymbolIcon = '⚡';
    action = '生成回复';
  } else {
    SymbolIcon = '✅';
    action = '完成';
  }

  const tok = tokens || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  // During execution: ↑↓ input + cache icon. After done: show all separately.
  const cacheEl = tok.cacheRead > 0 ? <span key="cache">📥 {fmtTok(tok.cacheRead)}</span> : null;
  const tokEls = [];
  if (!done) {
    // Running: double-arrow pulse style
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
      <span className="exec-bar-symbol">{SymbolIcon}</span>
      <span className="exec-bar-action">{action}…</span>
      <span className="exec-bar-meta">
        ({fmtTime(elapsed)}{!done ? <span> · {tokEls} · {PHASE_LABELS[phase] || phase}</span> : ''})
      </span>
      {done && hasTok && (
        <span className="exec-bar-summary">{tokEls}</span>
      )}
      {cost != null && (
        <span className="exec-bar-cost">{currency || '$'}{cost.toFixed(4)}</span>
      )}
    </div>
  );
}
