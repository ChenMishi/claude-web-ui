import { useState, useEffect, useRef, useMemo, memo, Fragment } from 'react';
import { createPortal } from 'react-dom';
import MarkdownRenderer from './MarkdownRenderer';
import { PrismLight as Prism } from 'react-syntax-highlighter';
import { downloadFile, authHeaders } from '../api';
import { getFileIcon } from '../utils/fileIcons';
// (icons reverted to emoji for chat display area)

// ── 图片缩略图组件 ──
function ImageThumbnail({ attachment, onOpen }) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let revoked = false;
    const load = async () => {
      try {
        const resp = await fetch(`/api/fs/download?path=${encodeURIComponent(attachment.path)}`, {
          headers: authHeaders(),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        if (!revoked) setUrl(URL.createObjectURL(blob));
      } catch {
        if (!revoked) setError(true);
      }
    };
    load();
    return () => { revoked = true; if (url) URL.revokeObjectURL(url); };
  }, [attachment.path]);

  if (error) {
    return (
      <div className="msg-thumb-item msg-thumb-error">
        {getFileIcon((attachment.fileName || attachment.originalName || '').toLowerCase())}
        <span className="msg-attach-name">{attachment.fileName || attachment.originalName}</span>
      </div>
    );
  }
  if (!url) {
    return <div className="msg-thumb-item msg-thumb-loading" />;
  }
  return (
    <div className="msg-thumb-item" onClick={() => onOpen(url, attachment.originalName || attachment.fileName)}>
      <img src={url} className="msg-thumb-img" alt={attachment.originalName || attachment.fileName} loading="lazy" />
    </div>
  );
}

// ── 图片灯箱 ──
function ImageLightbox({ src, alt, onClose }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCloseRef.current(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return createPortal(
    <div className="msg-lightbox-overlay" onClick={onClose}>
      <div className="msg-lightbox-inner" onClick={e => e.stopPropagation()}>
        <button className="msg-lightbox-close" onClick={onClose}>✕</button>
        <img src={src} alt={alt} className="msg-lightbox-img" />
        {alt && <div className="msg-lightbox-caption">{alt}</div>}
      </div>
    </div>,
    document.body
  );
}

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
  const attachments = message.attachments;
  const [lightbox, setLightbox] = useState(null);

  // ⚠️ All hooks MUST be called before any conditional return (React hook rules)
  const safeContent = typeof content === 'string' ? content : '';
  const messageBody = useMemo(() => (
    <div className="message-content">
      <MarkdownRenderer content={safeContent} streaming={streaming} />
    </div>
  ), [safeContent, streaming]);

  // Artifact summary — files created during the session
  if (role === 'artifacts') {
    const files = message.files || [];
    if (files.length === 0) return null;
    const isSingle = files.length === 1;
    return (
      <div className="msg-artifacts">
        <div className="msg-artifacts-head">
          {isSingle ? <>📦 产物已生成</> : <>📦 本次会话产物 ({files.length} 个文件)</>}
        </div>
        <div className="msg-artifacts-list">
          {files.map((f, i) => (
            <div className="msg-artifacts-item" key={i}>
              <span className="msg-artifacts-icon">{getFileIcon(f.name)}</span>
              <span className="msg-artifacts-name" title={f.path}>{f.name}</span>
              {f.sizeText && <span className="msg-artifacts-size">{f.sizeText}</span>}
              <button type="button" className="msg-artifacts-dl" title="下载" onClick={(e) => { e.stopPropagation(); downloadFile(f.path); }}>⬇️ 下载</button>
            </div>
          ))}
        </div>
      </div>
    );
  }

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

  return (
    <div className={`message ${role}`}>
      <div className="message-header">
        <span className="role-label">{labels[role] || role}</span>
        {timestamp && <span className="message-time">{formatTime(timestamp)}</span>}
      </div>
      {attachments && attachments.length > 0 && role === 'user' && (() => {
        const allImages = attachments.every(a => a.mimeType?.startsWith('image/'));
        if (allImages) {
          return (
            <div className="msg-attachments msg-attachments-images">
              {attachments.map((a, i) => (
                <ImageThumbnail key={i} attachment={a} onOpen={(url, name) => setLightbox({ src: url, alt: name })} />
              ))}
            </div>
          );
        }
        return (
          <div className="msg-attachments">
            {attachments.map((a, i) => {
              const name = (a.fileName || a.originalName || '').toLowerCase();
              return (
                <div key={i} className="msg-attach-item">
                  {getFileIcon(name)}
                  <span className="msg-attach-name">{a.fileName || a.originalName}</span>
                  {a.size && <span className="msg-attach-size">{a.size < 1024 ? `${a.size}B` : a.size < 1048576 ? `${(a.size / 1024).toFixed(1)}KB` : `${(a.size / 1048576).toFixed(1)}MB`}</span>}
                </div>
              );
            })}
          </div>
        );
      })()}
      {messageBody}
      {lightbox && <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
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
  // Uses targetLenRef to avoid restarting the rAF loop on every SSE chunk
  const targetLenRef = useRef(codeContent.length);
  targetLenRef.current = codeContent.length;

  useEffect(() => {
    if (!streaming || !isWrite || !codeContent) {
      if (!streaming) setRevealedLen(0);
      return;
    }

    setRevealedLen(0);
    let frame = 0;
    let active = true;

    const tick = () => {
      if (!active) return;
      frame++;
      if (frame % 4 !== 0) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      setRevealedLen(prev => {
        const totalLen = targetLenRef.current;  // always reads latest
        if (prev >= totalLen) return totalLen;
        const chunk = Math.max(1, Math.ceil((totalLen - prev) / 25));
        const next = Math.min(prev + chunk, totalLen);
        if (next < totalLen) {
          rafRef.current = requestAnimationFrame(tick);
        }
        return next;
      });
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => { active = false; cancelAnimationFrame(rafRef.current); };
  }, [streaming, isCodeTool]);  // Only restart on streaming start/stop, NOT on content changes

  const isAnimating = streaming && isCodeTool && revealedLen < codeContent.length;
  const shownCode = isCodeTool && streaming ? codeContent.slice(0, revealedLen) : '';

  // Diff view for Edit after streaming completes
  const diffResult = isEdit && !streaming
    ? computeDiff(toolCall.input?.old_string || '', toolCall.input?.new_string || '')
    : null;

  const getToolLabel = (name) => {
    const map = {
      Bash: '▶️', Read: '📖', Write: '✏️', Edit: '⚙️',
      Glob: '🔍', Grep: '🔎', AskUserQuestion: '❓',
      Task: '📋', TodoRead: '📝', TodoWrite: '📝',
    };
    return map[name] || '#';
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

  // Result footer (Write/Edit/Task done status bar inside code block)
  const result = toolCall.result;
  const renderResultFooter = () => {
    if (!result) return null;
    const verb = getStatusVerb(result.toolName || toolCall.name);
    const fp = result.filePath;
    const epaths = result.extractedPaths || [];
    return (
      <div className={`code-result-footer ${result.is_error ? 'error' : 'ok'}`}>
        <span className="code-result-icon">{result.is_error ? '❌' : '✅'}</span>
        <span className="code-result-text">{result.is_error ? `${verb}失败` : `${verb}成功`}</span>
        {!result.is_error && fp && (
          <>
            <span className="result-inline-sep">·</span>
            <span className="result-inline-path" title={fp}>{fp.split('/').pop() || fp}</span>
            <button type="button" className="result-inline-dl" title="下载文件" onClick={(e) => { e.stopPropagation(); downloadFile(fp); }}>⬇️</button>
          </>
        )}
        {!result.is_error && epaths.map((p, i) => (
          <Fragment key={i}>
            <span className="result-inline-sep">·</span>
            <span className="result-inline-path" title={p}>{p.split('/').pop() || p}</span>
            <button type="button" className="result-inline-dl" title="下载文件" onClick={(e) => { e.stopPropagation(); downloadFile(p); }}>⬇️</button>
          </Fragment>
        ))}
      </div>
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
      {renderResultFooter()}
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
  const isCompact = /^(Write|Edit|TaskCreate|TaskUpdate|Task)$/.test(toolName)
    || (toolName === 'Bash' && toolResult.extractedPaths?.length > 0);

  const content = typeof toolResult.content === 'string'
    ? toolResult.content
    : JSON.stringify(toolResult.content ?? '');

  const lines = content.split('\n');
  const isError = toolResult.is_error;
  const showContent = !isCompact && lines.length <= 10;  // ≤10 行才展示内容
  const verb = getStatusVerb(toolName);

  // ── Reveal animation for card-mode content ──
  const [revealedLen, setRevealedLen] = useState(0);
  const rafRef = useRef(null);
  const contentRef = useRef(content);
  contentRef.current = content;

  useEffect(() => {
    if (!showContent || !content) {
      setRevealedLen(0);
      return;
    }

    setRevealedLen(0);
    let active = true;

    const tick = () => {
      if (!active) return;
      const cur = contentRef.current;
      const isMultiLine = cur.indexOf('\n') !== -1;

      if (isMultiLine) {
        // Line-by-line waterfall
        setRevealedLen(prev => {
          if (prev >= cur.length) return cur.length;
          const nextNL = cur.indexOf('\n', prev);
          if (nextNL === -1) return cur.length;
          const next = nextNL + 1;
          if (next < cur.length) rafRef.current = requestAnimationFrame(tick);
          return next;
        });
      } else {
        // Single-line typewriter
        setRevealedLen(prev => {
          if (prev >= cur.length) return cur.length;
          const chunk = Math.max(1, Math.ceil((cur.length - prev) / 10));
          const next = Math.min(prev + chunk, cur.length);
          if (next < cur.length) rafRef.current = requestAnimationFrame(tick);
          return next;
        });
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => { active = false; cancelAnimationFrame(rafRef.current); };
  }, [showContent, content]);

  const animating = showContent && revealedLen < content.length;
  const displayContent = showContent ? content.slice(0, revealedLen) : '';

  // ── Status line typewriter (single-line, >10 lines) ──
  const [statusRevealed, setStatusRevealed] = useState(0);
  const statusRafRef = useRef(null);
  const statusText = `${isError ? '❌' : '✅'} ${isError ? `${verb}失败` : `${verb}成功`} (${lines.length} 行)`;
  const statusTextRef = useRef(statusText);
  statusTextRef.current = statusText;

  useEffect(() => {
    if (showContent || isCompact || !statusText) {
      setStatusRevealed(0);
      return;
    }

    setStatusRevealed(0);
    let active = true;
    let frame = 0;

    const tick = () => {
      if (!active) return;
      frame++;
      if (frame % 3 !== 0) {
        statusRafRef.current = requestAnimationFrame(tick);
        return;
      }
      setStatusRevealed(prev => {
        const cur = statusTextRef.current;
        if (prev >= cur.length) return cur.length;
        const next = prev + 1;
        if (next < cur.length) statusRafRef.current = requestAnimationFrame(tick);
        return next;
      });
    };

    statusRafRef.current = requestAnimationFrame(tick);
    return () => { active = false; cancelAnimationFrame(statusRafRef.current); };
  }, [showContent, isCompact, statusText]);

  // ── Compact inline for Write/Edit/Task/Bash(有产物) ──
  if (isCompact) {
    const fp = toolResult.filePath;
    const epaths = toolResult.extractedPaths || [];
    return (
      <div className={`result-inline ${isError ? 'error' : 'ok'}`}>
        <span className="result-inline-icon">{isError ? '❌' : '✅'}</span>
        <span className="result-inline-text">{isError ? `${verb}失败` : `${verb}成功`}</span>
        {!isError && fp && (
          <>
            <span className="result-inline-sep">·</span>
            <span className="result-inline-path" title={fp}>{fp.split('/').pop() || fp}</span>
            <button type="button" className="result-inline-dl" title="下载文件" onClick={(e) => { e.stopPropagation(); downloadFile(fp); }}>⬇️</button>
          </>
        )}
        {!isError && epaths.map((p, i) => (
          <Fragment key={i}>
            <span className="result-inline-sep">·</span>
            <span className="result-inline-path" title={p}>{p.split('/').pop() || p}</span>
            <button type="button" className="result-inline-dl" title="下载文件" onClick={(e) => { e.stopPropagation(); downloadFile(p); }}>⬇️</button>
          </Fragment>
        ))}
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
            <pre><code>{displayContent}{animating && <span className="live-cursor">▍</span>}</code></pre>
          ) : (
            <div className={`result-status-line ${isError ? 'error' : 'ok'}`}>
              {statusText.slice(0, statusRevealed)}
              {statusRevealed < statusText.length && <span className="live-cursor">▍</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
