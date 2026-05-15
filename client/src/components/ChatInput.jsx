import { useRef, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { abortSession } from '../api';
import ExecutionBar from './ExecutionBar';

export default function ChatInput({ onSend, onStop, disabled }) {
  const { isStreaming, currentSessionId, execStatus } = useApp();
  const inputRef = useRef(null);

  const handleSend = useCallback(() => {
    const text = inputRef.current?.value?.trim();
    if (!text || disabled) return;
    onSend(text);
    inputRef.current.value = '';
    inputRef.current.style.height = 'auto';
  }, [onSend, disabled]);

  const handleStop = useCallback(() => {
    if (!isStreaming) return;
    // Tell server to abort the SDK session
    if (currentSessionId) {
      abortSession(currentSessionId).catch(() => {});
    }
    // Notify parent to summarize and clean up
    if (onStop) {
      onStop(execStatus);
    }
  }, [isStreaming, currentSessionId, execStatus, onStop]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // If streaming, Enter triggers stop instead of send
      if (isStreaming) {
        handleStop();
      } else {
        handleSend();
      }
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
          placeholder={isStreaming ? 'Claude 正在执行... (Enter 中止)' : '输入消息... (Shift+Enter 换行)'}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
        />
        {isStreaming && (
          <button className="stop-btn" onClick={handleStop}>
            ⏹ 中止
          </button>
        )}
        <button className="send-btn" onClick={handleSend} disabled={disabled || isStreaming}>
          发送
        </button>
      </div>
    </div>
  );
}
