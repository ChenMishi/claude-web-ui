import { useState, useEffect, useRef } from 'react';
import MarkdownRenderer from './MarkdownRenderer';

function formatTime(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default function ChatMessage({ message }) {
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

  return (
    <div className={`message ${role}`}>
      <div className="message-header">
        <span className="role-label">{labels[role] || role}</span>
        {timestamp && <span className="message-time">{formatTime(timestamp)}</span>}
      </div>
      <div className="message-content">
        <MarkdownRenderer content={safeContent} streaming={streaming} />
      </div>
    </div>
  );
}

function ThinkingBlock({ content, streaming }) {
  const [expanded, setExpanded] = useState(true);
  const [revealedLen, setRevealedLen] = useState(0);
  const animRef = useRef(null);
  const safeContent = typeof content === 'string' ? content : '';

  // Typewriter animation for thinking when streaming
  useEffect(() => {
    if (!streaming || !safeContent) return;

    const totalLen = safeContent.length;
    // Adaptive speed: more chars per tick for longer content
    const targetTicks = totalLen > 3000 ? 300 : totalLen > 1000 ? 200 : totalLen > 300 ? 120 : 60;
    const interval = Math.max(16, Math.min(50, (targetTicks * 16) / Math.max(1, totalLen / 50)));
    const charsPerTick = Math.max(1, Math.ceil(totalLen / targetTicks));

    animRef.current = setInterval(() => {
      setRevealedLen(prev => {
        const next = prev + charsPerTick;
        if (next >= totalLen) {
          clearInterval(animRef.current);
          animRef.current = null;
          return totalLen;
        }
        return next;
      });
    }, interval);

    return () => {
      if (animRef.current) {
        clearInterval(animRef.current);
        animRef.current = null;
      }
    };
  }, [streaming, safeContent]);

  // Reset when content changes (new thinking burst)
  useEffect(() => {
    setRevealedLen(0);
  }, [content]);

  const isAnimating = streaming && revealedLen < safeContent.length;
  const shownContent = streaming ? safeContent.slice(0, revealedLen) : safeContent;

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
          {streaming ? (
            <div className="thinking-typewriter">
              <MarkdownRenderer content={shownContent} />
              {isAnimating && <span className="live-cursor">▍</span>}
            </div>
          ) : (
            <MarkdownRenderer content={safeContent} />
          )}
        </div>
      )}
    </div>
  );
}

function ToolCallBlock({ toolCall, streaming }) {
  const [expanded, setExpanded] = useState(true);
  const [revealedLen, setRevealedLen] = useState(0);
  const animRef = useRef(null);

  const isWrite = toolCall.name === 'Write';
  const isEdit = toolCall.name === 'Edit';
  const isCodeTool = isWrite || isEdit;
  const codeContent = isCodeTool
    ? (toolCall.input?.content || toolCall.input?.new_string || '')
    : '';
  const filePath = isCodeTool ? (toolCall.input?.file_path || '') : '';

  // Typewriter animation for Write/Edit tools when streaming
  useEffect(() => {
    if (!streaming || !isCodeTool || !codeContent) return;

    const totalLen = codeContent.length;
    // Adaptive speed: more chars per tick for longer content
    // ~60 ticks per second, aim to finish within ~3-8 seconds depending on size
    const targetTicks = totalLen > 5000 ? 400 : totalLen > 2000 ? 300 : totalLen > 500 ? 200 : 100;
    const interval = Math.max(16, Math.min(50, (targetTicks * 16) / Math.max(1, totalLen / 50)));
    const charsPerTick = Math.max(1, Math.ceil(totalLen / targetTicks));

    animRef.current = setInterval(() => {
      setRevealedLen(prev => {
        const next = prev + charsPerTick;
        if (next >= totalLen) {
          clearInterval(animRef.current);
          animRef.current = null;
          return totalLen;
        }
        return next;
      });
    }, interval);

    return () => {
      if (animRef.current) {
        clearInterval(animRef.current);
        animRef.current = null;
      }
    };
  }, [streaming, isCodeTool, codeContent]);

  // Reset revealedLen when a new tool call comes in
  useEffect(() => {
    setRevealedLen(0);
  }, [toolCall.tool_use_id]);

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
