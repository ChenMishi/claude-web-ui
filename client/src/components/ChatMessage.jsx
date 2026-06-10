import { useState, useEffect, useRef, useMemo, memo } from 'react';
import MarkdownRenderer from './MarkdownRenderer';
import { PrismLight as Prism } from 'react-syntax-highlighter';

// ── Language detection from file extension ──
function detectLang(filePath) {
  const ext = (filePath || '').split('.').pop().toLowerCase();
  const map = {
    js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go',
    java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
    css: 'css', scss: 'css', less: 'css',
    html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    md: 'markdown', sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
    dockerfile: 'docker', nginx: 'nginx', graphql: 'graphql', gql: 'graphql',
    makefile: 'makefile', cmake: 'cmake',
  };
  return map[ext] || 'text';
}

// ── Prism language lazy-registration ──
const langCache = new Set();
function ensureLang(lang) {
  const key = (lang || 'text').toLowerCase();
  if (langCache.has(key)) return;
  langCache.add(key);
  try {
    switch (key) {
      case 'javascript': Prism.registerLanguage('javascript', require('react-syntax-highlighter/dist/esm/languages/prism/javascript').default); break;
      case 'typescript': Prism.registerLanguage('typescript', require('react-syntax-highlighter/dist/esm/languages/prism/typescript').default); break;
      case 'jsx': Prism.registerLanguage('jsx', require('react-syntax-highlighter/dist/esm/languages/prism/jsx').default); break;
      case 'tsx': Prism.registerLanguage('tsx', require('react-syntax-highlighter/dist/esm/languages/prism/tsx').default); break;
      case 'json': Prism.registerLanguage('json', require('react-syntax-highlighter/dist/esm/languages/prism/json').default); break;
      case 'python': Prism.registerLanguage('python', require('react-syntax-highlighter/dist/esm/languages/prism/python').default); break;
      case 'bash': Prism.registerLanguage('bash', require('react-syntax-highlighter/dist/esm/languages/prism/bash').default); break;
      case 'css': Prism.registerLanguage('css', require('react-syntax-highlighter/dist/esm/languages/prism/css').default); break;
      case 'markup': Prism.registerLanguage('markup', require('react-syntax-highlighter/dist/esm/languages/prism/markup').default); break;
      case 'sql': Prism.registerLanguage('sql', require('react-syntax-highlighter/dist/esm/languages/prism/sql').default); break;
      case 'yaml': Prism.registerLanguage('yaml', require('react-syntax-highlighter/dist/esm/languages/prism/yaml').default); break;
      case 'go': Prism.registerLanguage('go', require('react-syntax-highlighter/dist/esm/languages/prism/go').default); break;
      case 'rust': Prism.registerLanguage('rust', require('react-syntax-highlighter/dist/esm/languages/prism/rust').default); break;
      case 'java': Prism.registerLanguage('java', require('react-syntax-highlighter/dist/esm/languages/prism/java').default); break;
      case 'ruby': Prism.registerLanguage('ruby', require('react-syntax-highlighter/dist/esm/languages/prism/ruby').default); break;
      case 'c': Prism.registerLanguage('c', require('react-syntax-highlighter/dist/esm/languages/prism/c').default); break;
      case 'cpp': Prism.registerLanguage('cpp', require('react-syntax-highlighter/dist/esm/languages/prism/cpp').default); break;
      case 'markdown': Prism.registerLanguage('markdown', require('react-syntax-highlighter/dist/esm/languages/prism/markdown').default); break;
      case 'diff': Prism.registerLanguage('diff', require('react-syntax-highlighter/dist/esm/languages/prism/diff').default); break;
      case 'docker': Prism.registerLanguage('docker', require('react-syntax-highlighter/dist/esm/languages/prism/docker').default); break;
      case 'nginx': Prism.registerLanguage('nginx', require('react-syntax-highlighter/dist/esm/languages/prism/nginx').default); break;
      case 'makefile': Prism.registerLanguage('makefile', require('react-syntax-highlighter/dist/esm/languages/prism/makefile').default); break;
      case 'graphql': Prism.registerLanguage('graphql', require('react-syntax-highlighter/dist/esm/languages/prism/graphql').default); break;
      default: break;
    }
  } catch {}
}

function highlightCode(code, lang) {
  ensureLang(lang);
  const key = (lang || 'text').toLowerCase();
  try {
    if (!Prism.languages[key]) return escapeHtml(code);
    return Prism.highlight(code, Prism.languages[key], key);
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Line-by-line diff (LCS-based) ──
function computeDiff(oldStr, newStr) {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const m = oldLines.length;
  const n = newLines.length;

  // Cap at 800 lines to avoid O(mn) perf issues
  if (m > 800 || n > 800) {
    return [{ type: 'too-large', oldLen: m, newLen: n }];
  }

  // LCS table
  const dp = new Uint16Array((m + 1) * (n + 1));
  const idx = (i, j) => i * (n + 1) + j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[idx(i, j)] = dp[idx(i - 1, j - 1)] + 1;
      } else {
        dp[idx(i, j)] = Math.max(dp[idx(i - 1, j)], dp[idx(i, j - 1)]);
      }
    }
  }

  // Backtrack to build diff
  const result = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: 'same', line: oldLines[i - 1], oldNum: i, newNum: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[idx(i, j - 1)] >= dp[idx(i - 1, j)])) {
      result.unshift({ type: 'add', line: newLines[j - 1], newNum: j });
      j--;
    } else {
      result.unshift({ type: 'del', line: oldLines[i - 1], oldNum: i });
      i--;
    }
  }

  return result;
}

function formatTime(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default memo(function ChatMessage({ message }) {
  const { role, content, error, toolCall, toolResult, timestamp, streaming } = message;

  if (role === 'system') {
    const isAbort = typeof content === 'string' && content.startsWith('⏹');
    return (
      <div className={`system-msg ${isAbort ? 'abort' : 'error'}`}>
        <MarkdownRenderer content={content} />
      </div>
    );
  }

  // Thinking block display
  if (role === 'thinking') {
    return <ThinkingBlock content={content} streaming={streaming} />;
  }

  // Tool call display
  if (role === 'tool' && toolCall) {
    return <ToolCallBlock toolCall={toolCall} streaming={streaming} />;
  }

  // Tool result display
  if (role === 'tool' && toolResult) {
    return <ToolResultBlock toolResult={toolResult} />;
  }

  const labels = { user: '你', assistant: 'Claude' };
  const safeContent = typeof content === 'string' ? content : '';

  // 用 useMemo 缓存 MarkdownRenderer 输出 — 已完成的消息不应在父组件重渲染时重复解析
  const messageBody = useMemo(() => (
    <div className="message-content">
      <MarkdownRenderer content={safeContent} streaming={streaming} />
    </div>
  ), [safeContent, streaming]);

  return (
    <div className={`message ${role}`}>
      <div className="message-header">
        <span className="role-label">{labels[role] || role}</span>
        {timestamp && <span className="message-time">{formatTime(timestamp)}</span>}
      </div>
      {messageBody}
    </div>
  );
});

function ThinkingBlock({ content, streaming }) {
  const [expanded, setExpanded] = useState(true);
  const safeContent = typeof content === 'string' ? content : '';

  return (
    <div className="thinking-block">
      <div className="thinking-header" onClick={() => setExpanded(!expanded)}>
        <span className="thinking-icon">💭</span>
        <span className="thinking-label">思考</span>
        <span className="thinking-preview">{safeContent.slice(0, 60)}{safeContent.length > 60 ? '...' : ''}</span>
        <span className="thinking-toggle">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div className="thinking-content">
          <MarkdownRenderer content={safeContent} />
          {streaming && <span className="live-cursor">▍</span>}
        </div>
      )}
    </div>
  );
}

function ToolCallBlock({ toolCall, streaming }) {
  const [expanded, setExpanded] = useState(true);
  const [revealedLen, setRevealedLen] = useState(0);
  const rafRef = useRef(null);

  const isWrite = toolCall.name === 'Write';
  const isEdit = toolCall.name === 'Edit';
  const isCodeTool = isWrite || isEdit;
  const codeContent = isCodeTool
    ? (toolCall.input?.content || toolCall.input?.new_string || '')
    : '';
  const filePath = isCodeTool ? (toolCall.input?.file_path || '') : '';
  const lang = isCodeTool ? detectLang(filePath) : 'text';

  // rAF typewriter animation for Write tools only
  useEffect(() => {
    if (!streaming || !isWrite || !codeContent) {
      if (!streaming) setRevealedLen(0);
      return;
    }

    setRevealedLen(0);
    let frame = 0;
    const totalLen = codeContent.length;

    const tick = () => {
      frame++;
      if (frame % 4 !== 0) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      setRevealedLen(prev => {
        if (prev >= totalLen) return totalLen;
        const chunk = Math.max(1, Math.ceil((totalLen - prev) / 25));
        const next = prev + chunk;
        if (next >= totalLen) return totalLen;
        rafRef.current = requestAnimationFrame(tick);
        return next;
      });
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafRef.current);
  }, [streaming, isCodeTool, codeContent]);

  const isAnimating = streaming && isCodeTool && revealedLen < codeContent.length;
  const shownCode = isCodeTool && streaming ? codeContent.slice(0, revealedLen) : '';

  // Diff view for Edit after streaming completes
  const diffResult = isEdit && !streaming
    ? computeDiff(toolCall.input?.old_string || '', toolCall.input?.new_string || '')
    : null;

  const getToolLabel = (name) => {
    const map = {
      Bash: '💻', Read: '📖', Write: '✏️', Edit: '🔧',
      Glob: '🔍', Grep: '🔎', AskUserQuestion: '❓',
      Task: '📋', TodoRead: '📝', TodoWrite: '📝',
    };
    return map[name] || '🔨';
  };

  // Preview text: file_path for code tools, or first 120 chars of input
  const inputPreview = isCodeTool && filePath
    ? filePath
    : ((typeof toolCall.input === 'string'
        ? toolCall.input.slice(0, 120)
        : JSON.stringify(toolCall.input ?? {}).slice(0, 120)) || '');

  const renderCodeContent = () => {
    // Case 1: Write streaming — typewriter with syntax highlighting
    if (isWrite && streaming) {
      return (
        <pre className="typewriter-code">
          <code
            className={`language-${lang}`}
            dangerouslySetInnerHTML={{
              __html: highlightCode(shownCode, lang) + (isAnimating ? '<span class="live-cursor">▍</span>' : '')
            }}
          />
        </pre>
      );
    }

    // Case 2: Edit streaming — full new_string with syntax highlighting, no typewriter
    if (isEdit && streaming) {
      return (
        <pre><code
          className={`language-${lang}`}
          dangerouslySetInnerHTML={{ __html: highlightCode(codeContent, lang) }}
        /></pre>
      );
    }

    // Case 2: Edit complete — show diff view
    if (isEdit && diffResult) {
      if (diffResult[0]?.type === 'too-large') {
        // File too large, fall back to syntax-highlighted new_string
        return (
          <pre><code
            className={`language-${lang}`}
            dangerouslySetInnerHTML={{ __html: highlightCode(toolCall.input?.new_string || '', lang) }}
          /></pre>
        );
      }
      return <DiffView diff={diffResult} lang={lang} />;
    }

    // Case 3: Write complete — show syntax-highlighted code
    if (isWrite && !streaming) {
      return (
        <pre><code
          className={`language-${lang}`}
          dangerouslySetInnerHTML={{ __html: highlightCode(codeContent, lang) }}
        /></pre>
      );
    }

    // Case 4: Other tools — JSON dump
    return (
      <pre><code>{JSON.stringify(toolCall.input, null, 2)}</code></pre>
    );
  };

  return (
    <div className="tool-call-block">
      <div className="tool-call-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-call-icon">{getToolLabel(toolCall.name)}</span>
        <span className="tool-call-name">{toolCall.name}</span>
        <span className="tool-call-preview">{inputPreview}{inputPreview.length >= 120 ? '...' : ''}</span>
        <span className="tool-call-toggle">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div className="tool-call-detail">
          {renderCodeContent()}
        </div>
      )}
    </div>
  );
}

// ── Diff View Component ──
function DiffView({ diff, lang }) {
  // Compact: collapse runs of >3 unchanged lines
  const compacted = [];
  let sameRun = [];
  const flushSame = () => {
    if (sameRun.length === 0) return;
    if (sameRun.length <= 3) {
      compacted.push(...sameRun);
    } else {
      compacted.push(sameRun[0]);
      compacted.push(sameRun[1]);
      compacted.push({ type: 'skip', count: sameRun.length - 2, startOld: sameRun[2].oldNum, startNew: sameRun[2].newNum });
      compacted.push(sameRun[sameRun.length - 1]);
    }
    sameRun = [];
  };

  for (const d of diff) {
    if (d.type === 'same') {
      sameRun.push(d);
    } else {
      flushSame();
      compacted.push(d);
    }
  }
  flushSame();

  // Detect language for the code block
  const codeLang = (lang || 'text').toLowerCase();

  const renderLine = (d, i) => {
    if (d.type === 'skip') {
      return (
        <div key={i} className="diff-line diff-skip">
          <span className="diff-num diff-num-old"></span>
          <span className="diff-num diff-num-new"></span>
          <span className="diff-sign">···</span>
          <span className="diff-text">↑ {d.count} unchanged lines ↑</span>
        </div>
      );
    }

    const sign = d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' ';
    const oldNum = d.oldNum != null ? String(d.oldNum) : '';
    const newNum = d.newNum != null ? String(d.newNum) : '';

    return (
      <div key={i} className={`diff-line diff-${d.type}`}>
        <span className="diff-num diff-num-old">{oldNum}</span>
        <span className="diff-num diff-num-new">{newNum}</span>
        <span className="diff-sign">{sign}</span>
        <span
          className="diff-text"
          dangerouslySetInnerHTML={{
            __html: highlightCode(d.line, codeLang)
          }}
        />
      </div>
    );
  };

  return <div className="diff-view">{compacted.map(renderLine)}</div>;
}

// ── Tool-specific status verb mapping ──
function getStatusVerb(toolName) {
  const map = {
    Bash: '执行',
    Read: '读取',
    Write: '写入',
    Edit: '修改',
    Grep: '获取',
    Glob: '检索',
    TaskCreate: '执行',
    TaskUpdate: '执行',
    Task: '执行',
  };
  return map[toolName] || '执行';
}

function ToolResultBlock({ toolResult }) {
  const [expanded, setExpanded] = useState(true);
  const toolName = toolResult.toolName || '';
  const isCompact = /^(Write|Edit|TaskCreate|TaskUpdate|Task)$/.test(toolName);

  const content = typeof toolResult.content === 'string'
    ? toolResult.content
    : JSON.stringify(toolResult.content ?? '');

  const lines = content.split('\n');
  const isError = toolResult.is_error;
  const showContent = !isCompact && lines.length <= 10;  // ≤10 行才展示内容
  const verb = getStatusVerb(toolName);

  // ── Compact inline for Write/Edit/Task ──
  if (isCompact) {
    return (
      <div className={`result-inline ${isError ? 'error' : 'ok'}`}>
        <span className="result-inline-icon">{isError ? '❌' : '✅'}</span>
        <span className="result-inline-text">{isError ? `${verb}失败` : `${verb}成功`}</span>
      </div>
    );
  }

  // ── Normal card for Bash/Read/Grep/etc ──
  const label = toolName ? `${toolName} 结果` : '结果';

  return (
    <div className={`tool-result-block ${isError ? 'error' : ''}`}>
      <div className="tool-result-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-result-icon">{isError ? '❌' : '✅'}</span>
        <span className="tool-result-label">{label}</span>
        <span className="tool-result-size">({lines.length} 行)</span>
        <span className="tool-call-toggle">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div className="tool-result-content">
          {showContent ? (
            <pre><code>{content}</code></pre>
          ) : (
            <div className={`result-status-line ${isError ? 'error' : 'ok'}`}>
              {isError ? `❌ ${verb}失败` : `✅ ${verb}成功`} ({lines.length} 行)
            </div>
          )}
        </div>
      )}
    </div>
  );
}
