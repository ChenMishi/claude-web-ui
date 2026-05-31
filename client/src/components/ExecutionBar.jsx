import { useApp } from '../context/AppContext';

const TOOL_SYMBOLS = {
  Bash: '▶', Read: '📄', Write: '✏', Edit: '🔧',
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

  let symbol, action;
  if (phase === 'thinking') {
    symbol = '⏳';
    action = detail ? detail.slice(0, 50) + (detail.length > 50 ? '…' : '') : '思考中';
  } else if (phase === 'running') {
    const idx = detail.indexOf(':');
    const toolName = idx > 0 ? detail.slice(0, idx) : detail;
    const desc = idx > 0 ? detail.slice(idx + 1) : '';
    symbol = TOOL_SYMBOLS[toolName] || '🔨';
    const verb = TOOL_VERBS[toolName] || toolName;
    action = desc ? `${verb} ${desc}` : `${verb} ${toolName}`;
    if (action.length > 40) action = action.slice(0, 40) + '…';
  } else if (phase === 'responding') {
    symbol = '✶';
    action = '生成回复';
  } else {
    symbol = '✅';
    action = '完成';
  }

  const tok = tokens || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  // During execution: ↑↓ input + 📥 cache. After done: show all separately.
  const tokParts = [];
  const cachePart = tok.cacheRead > 0 ? `📥 ${fmtTok(tok.cacheRead)}` : '';
  if (!done) {
    // Running: double-arrow pulse style
    tokParts.push(`↑↓ ${fmtTok(tok.input)}`);
    if (cachePart) tokParts.push(cachePart);
  } else {
    if (tok.input > 0) tokParts.push(`↑ ${fmtTok(tok.input)}`);
    tokParts.push(`↓ ${fmtTok(tok.output)}`);
    if (cachePart) tokParts.push(cachePart);
  }
  const tokStr = tokParts.join(' ');

  return (
    <div className={`exec-bar ${done ? 'done' : ''}`}>
      <span className="exec-bar-symbol">{symbol}</span>
      <span className="exec-bar-action">{action}…</span>
      <span className="exec-bar-meta">
        ({fmtTime(elapsed)}{!done ? ` · ${tokStr} · ${PHASE_LABELS[phase] || phase}` : ''})
      </span>
      {done && tokStr && (
        <span className="exec-bar-summary">{tokStr}</span>
      )}
      {cost != null && (
        <span className="exec-bar-cost">{currency || '$'}{cost.toFixed(4)}</span>
      )}
    </div>
  );
}
