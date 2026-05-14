import { useRef, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import ExecutionBar from './ExecutionBar';

export default function ChatInput({ onSend, disabled }) {
  const { isStreaming } = useApp();
  const inputRef = useRef(null);

  const handleSend = useCallback(() => {
    const text = inputRef.current?.value?.trim();
    if (!text || disabled) return;
    onSend(text);
    inputRef.current.value = '';
    inputRef.current.style.height = 'auto';
  }, [onSend, disabled]);

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
          placeholder={isStreaming ? 'Claude 正在思考...' : '输入消息... (Shift+Enter 换行)'}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          disabled={disabled}
        />
        <button className="send-btn" onClick={handleSend} disabled={disabled}>
          发送
        </button>
      </div>
    </div>
  );
}
