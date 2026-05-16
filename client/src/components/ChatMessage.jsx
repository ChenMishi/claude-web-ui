import { useState } from 'react';
import MarkdownRenderer from './MarkdownRenderer';

function formatTime(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default function ChatMessage({ message }) {
  const { role, content, error, toolCall, toolResult, timestamp } = message;

  if (role === 'system') {
    const isAbort = typeof content === 'string' && content.startsWith('⏹');
    return (
      <div className={`system-msg ${isAbort ? 'abort' : 'error'}`}>
        <MarkdownRenderer content={content} />
      </div>
    );
  }

  // Tool call display
  if (role === 'tool' && toolCall) {
    return <ToolCallBlock toolCall={toolCall} />;
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
        <MarkdownRenderer content={safeContent} />
      </div>
    </div>
  );
}

function ToolCallBlock({ toolCall }) {
  const [expanded, setExpanded] = useState(true);

  const getToolLabel = (name) => {
    const map = {
      Bash: '💻', Read: '📖', Write: '✏️', Edit: '🔧',
      Glob: '🔍', Grep: '🔎', AskUserQuestion: '❓',
      Task: '📋', TodoRead: '📝', TodoWrite: '📝',
    };
    return map[name] || '🔨';
  };

  const inputPreview = (typeof toolCall.input === 'string'
    ? toolCall.input.slice(0, 120)
    : JSON.stringify(toolCall.input ?? {}).slice(0, 120)) || '';

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
          <pre><code>{JSON.stringify(toolCall.input, null, 2)}</code></pre>
        </div>
      )}
    </div>
  );
}

function ToolResultBlock({ toolResult }) {
  const [expanded, setExpanded] = useState(true);
  const MAX_PREVIEW = 500;

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
