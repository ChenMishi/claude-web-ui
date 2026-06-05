import { useState, useEffect, useRef, useMemo, memo } from 'react';
import MarkdownRenderer from './MarkdownRenderer';

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

  // rAF typewriter animation for Write/Edit tools
  useEffect(() => {
    if (!streaming || !isCodeTool || !codeContent) {
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
          {isCodeTool && streaming ? (
            <pre className="typewriter-code"><code>{shownCode}{isAnimating && <span className="live-cursor">▍</span>}</code></pre>
          ) : (
            <pre><code>{JSON.stringify(toolCall.input, null, 2)}</code></pre>
          )}
        </div>
      )}
    </div>
  );
}

function ToolResultBlock({ toolResult }) {
  const [expanded, setExpanded] = useState(true);
  const MAX_PREVIEW = 2000;

  const preview = typeof toolResult.content === 'string'
    ? toolResult.content
    : JSON.stringify(toolResult.content ?? '');

  const truncated = preview.length > MAX_PREVIEW;

  return (
    <div className={`tool-result-block ${toolResult.is_error ? 'error' : ''}`}>
      <div className="tool-result-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-result-icon">{toolResult.is_error ? '❌' : '✅'}</span>
        <span className="tool-result-label">结果</span>
        <span className="tool-result-size">({preview.length} 字符)</span>
        <span className="tool-call-toggle">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div className="tool-result-content">
          <pre><code>{truncated ? preview.slice(0, MAX_PREVIEW) + '\n... (截断)' : preview}</code></pre>
        </div>
      )}
    </div>
  );
}
