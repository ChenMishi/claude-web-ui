import { useApp } from '../context/AppContext';

const TOOL_SYMBOLS = {
  Bash: '▶', Read: '📄', Write: '✏', Edit: '🔧',
  Glob: '🔍', Grep: '🔎', AskUserQuestion: '❓',
};

const TOOL_VERBS = {
  Bash: '执行', Read: '读取', Write: '写入', Edit: '编辑',
  Glob: '搜索', Grep: '查找', AskUserQuestion: '询问',
};

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
  const { phase, detail, elapsed, tokens, cost } = execStatus;

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
  // Active direction (turns green): thinking/responding → output active, running → input active
  const outActive = !done && (phase === 'thinking' || phase === 'responding');
  const inActive = !done && (phase === 'running');

  return (
    <div className={`exec-bar ${done ? 'done' : ''}`}>
      <span className="exec-bar-symbol">{symbol}</span>
      <span className="exec-bar-action">{action}</span>

      {/* Inline token display */}
      <span className="exec-bar-tokens">
        <span className={`exec-tok ${inActive ? 'active' : ''}`}>↑ {fmtTok(tok.input)}</span>
        <span className="exec-tok-sep">·</span>
        <span className={`exec-tok ${outActive ? 'active' : ''}`}>↓ {fmtTok(tok.output)}</span>
      </span>

      <span className="exec-bar-elapsed">{fmtTime(elapsed)}</span>

      {done && cost != null && (
        <span className="exec-bar-cost">${cost.toFixed(4)}</span>
      )}
    </div>
  );
}
