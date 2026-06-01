import { useRef } from 'react';
import { useApp } from '../context/AppContext';

export default function WelcomeScreen({ onSend }) {
  const { model, systemPrompt, setSetting, currentProjectId, availableModels } = useApp();
  const inputRef = useRef(null);

  const handleSend = () => {
    const text = inputRef.current?.value?.trim();
    if (text) onSend(text);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="welcome">
      <h2>你好！开始对话</h2>
      <p>
        {currentProjectId
          ? '在下方输入消息开始和 Claude 对话。'
          : '请先在侧边栏选择一个项目。'}
      </p>
      <div className="welcome-config">
        <label>Model</label>
        <select value={model} onChange={e => setSetting('model', e.target.value)}>
          {availableModels.map(m => (
            <option key={m.id} value={m.id}>{m.displayName || m.id}</option>
          ))}
        </select>

        <label>System Prompt (可选)</label>
        <input
          type="text"
          value={systemPrompt}
          onChange={e => setSetting('systemPrompt', e.target.value)}
          placeholder="自定义 system prompt..."
        />

        <label>开始对话</label>
        <div className="input-wrapper">
          <input
            ref={inputRef}
            type="text"
            placeholder="输入第一条消息..."
            onKeyDown={handleKeyDown}
            style={{
              flex: 1, padding: '10px 14px', background: 'var(--bg-secondary)',
              border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)',
              fontSize: 14, outline: 'none',
            }}
          />
          <button className="send-btn" onClick={handleSend}>发送</button>
        </div>
      </div>
    </div>
  );
}
