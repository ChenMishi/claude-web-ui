import { useRef, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { abortSession } from '../api';
import ExecutionBar from './ExecutionBar';

export default function ChatInput({ onSend, onStop, disabled }) {
  const { isStreaming, currentSessionId, execStatus, model, permissionLevel, setSetting } = useApp();
  const inputRef = useRef(null);

  const handleSend = useCallback(() => {
    const text = inputRef.current?.value?.trim();
    if (!text) return;
    onSend(text);
    inputRef.current.value = '';
    inputRef.current.style.height = 'auto';
  }, [onSend]);

  const handleStop = useCallback(() => {
    if (!isStreaming) return;
    if (currentSessionId) {
      abortSession(currentSessionId).catch(() => {});
    }
    if (onStop) {
      onStop(execStatus);
    }
  }, [isStreaming, currentSessionId, execStatus, onStop]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = inputRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    }
  };

  return (
    <div className="input-area">
      <ExecutionBar />
      <div className="input-wrapper">
        <textarea
          ref={inputRef}
          rows="1"
          placeholder={isStreaming ? '输入消息中途插入... (Enter 发送)' : '输入消息... (Shift+Enter 换行)'}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          disabled={disabled && !isStreaming}
        />
        <div className="input-select-group">
          <span className="input-select-icon" title="模型">🧠</span>
          <select className="input-select input-select-model" value={model} onChange={e => setSetting('model', e.target.value)} title="模型">
            <option value="claude-opus-4-7">Claude Opus 4.7</option>
            <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
            <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
          </select>
        </div>
        <div className="input-select-group">
          <span className="input-select-icon" title="工具权限">🛡</span>
          <select className={`input-select input-select-perm perm-${permissionLevel}`} value={permissionLevel} onChange={e => setSetting('permissionLevel', e.target.value)} title="工具权限">
            <option value="auto">自动执行</option>
            <option value="confirm-dangerous">写入确认</option>
            <option value="confirm-all">全部确认</option>
          </select>
        </div>
        {isStreaming && (
          <button className="stop-btn" onClick={handleStop}>
            ⏹ 中止
          </button>
        )}
        <button className="send-btn" onClick={handleSend} disabled={disabled && !isStreaming}>
          发送
        </button>
      </div>
    </div>
  );
}
