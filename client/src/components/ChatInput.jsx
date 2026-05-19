import { useRef, useCallback, useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { abortSession } from '../api';
import ExecutionBar from './ExecutionBar';

const COMMANDS = [
  { cmd: '/help', desc: '查看所有可用命令', action: 'help' },
  { cmd: '/new', desc: '新建一个空白对话', action: 'new' },
  { cmd: '/clear', desc: '清空当前对话消息', action: 'clear' },
  { cmd: '/compact', desc: '压缩对话上下文以节省 token', action: 'compact' },
  { cmd: '/files', desc: '切换到文件浏览', action: 'files' },
  { cmd: '/terminal', desc: '切换到终端', action: 'terminal' },
  { cmd: '/settings', desc: '打开设置页面', action: 'settings' },
  { cmd: '/version', desc: '查看版本和更新', action: 'version' },
  { cmd: '/theme dark', desc: '切换为深色主题', action: 'theme-dark' },
  { cmd: '/theme light', desc: '切换为浅色主题', action: 'theme-light' },
  { cmd: '/theme warm', desc: '切换为暖色主题', action: 'theme-warm' },
  { cmd: '/model opus', desc: '切换为 Claude Opus 4.7', action: 'model-opus' },
  { cmd: '/model sonnet', desc: '切换为 Claude Sonnet 4.6', action: 'model-sonnet' },
  { cmd: '/model haiku', desc: '切换为 Claude Haiku 4.5', action: 'model-haiku' },
  { cmd: '/perm auto', desc: '工具权限设为自动执行', action: 'perm-auto' },
  { cmd: '/perm dangerous', desc: '写入/编辑/Bash 需确认', action: 'perm-dangerous' },
  { cmd: '/perm all', desc: '所有工具操作需确认', action: 'perm-all' },
];

export default function ChatInput({ onSend, onStop, disabled }) {
  const { isStreaming, currentSessionId, execStatus, model, permissionLevel, setSetting,
    setView, setMessages, currentProjectId, selectProject, theme } = useApp();
  const inputRef = useRef(null);
  const [showCommands, setShowCommands] = useState(false);
  const [filteredCmds, setFilteredCmds] = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(0);

  const handleSend = useCallback(() => {
    const text = inputRef.current?.value?.trim();
    if (!text) return;
    onSend(text);
    inputRef.current.value = '';
    inputRef.current.style.height = 'auto';
    setShowCommands(false);
  }, [onSend]);

  const handleStop = useCallback(() => {
    if (!isStreaming) return;
    if (currentSessionId) {
      abortSession(currentSessionId).catch(() => {});
    }
    if (onStop) onStop(execStatus);
  }, [isStreaming, currentSessionId, execStatus, onStop]);

  const applyCommand = useCallback((cmd) => {
    switch (cmd.action) {
      case 'help':
        inputRef.current.value = '/help';
        break;
      case 'new': selectProject(currentProjectId); setView('chat'); break;
      case 'clear': setMessages([]); break;
      case 'compact': inputRef.current.value = '请帮我压缩对话上下文'; handleSend(); return;
      case 'files': setView('files'); break;
      case 'terminal': setView('terminal'); break;
      case 'settings': setView('settings'); break;
      case 'version': setView('version'); break;
      case 'theme-dark': setSetting('theme', 'dark'); inputRef.current.value = ''; break;
      case 'theme-light': setSetting('theme', 'light'); inputRef.current.value = ''; break;
      case 'theme-warm': setSetting('theme', 'warm'); inputRef.current.value = ''; break;
      case 'model-opus': setSetting('model', 'claude-opus-4-7'); inputRef.current.value = ''; break;
      case 'model-sonnet': setSetting('model', 'claude-sonnet-4-6'); inputRef.current.value = ''; break;
      case 'model-haiku': setSetting('model', 'claude-haiku-4-5-20251001'); inputRef.current.value = ''; break;
      case 'perm-auto': setSetting('permissionLevel', 'auto'); inputRef.current.value = ''; break;
      case 'perm-dangerous': setSetting('permissionLevel', 'confirm-dangerous'); inputRef.current.value = ''; break;
      case 'perm-all': setSetting('permissionLevel', 'confirm-all'); inputRef.current.value = ''; break;
      default: break;
    }
    setShowCommands(false);
    inputRef.current?.focus();
  }, [selectProject, setView, setMessages, setSetting, currentProjectId, handleSend]);

  const handleKeyDown = (e) => {
    if (showCommands) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx(i => (i + 1) % filteredCmds.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx(i => (i - 1 + filteredCmds.length) % filteredCmds.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (filteredCmds[selectedIdx]) {
          applyCommand(filteredCmds[selectedIdx]);
        }
        return;
      }
      if (e.key === 'Escape') {
        setShowCommands(false);
        return;
      }
    }
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

      const val = el.value;
      const cursorPos = el.selectionStart || 0;
      // Show commands only when "/" is the first character
      if (val.startsWith('/') && val.indexOf('\n') === -1) {
        const search = val.toLowerCase();
        const filtered = COMMANDS.filter(c => c.cmd.toLowerCase().includes(search));
        setFilteredCmds(filtered);
        setShowCommands(filtered.length > 0);
        setSelectedIdx(0);
      } else {
        setShowCommands(false);
      }
    }
  };

  // Close commands on outside click
  useEffect(() => {
    if (!showCommands) return;
    const handler = () => setShowCommands(false);
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showCommands]);

  return (
    <div className="input-area">
      <ExecutionBar />
      {showCommands && (
        <div className="slash-commands">
          {filteredCmds.map((c, i) => (
            <div
              key={c.cmd}
              className={`slash-cmd-item ${i === selectedIdx ? 'selected' : ''}`}
              onClick={() => applyCommand(c)}
              onMouseEnter={() => setSelectedIdx(i)}
            >
              <span className="slash-cmd-name">{c.cmd}</span>
              <span className="slash-cmd-desc">{c.desc}</span>
            </div>
          ))}
        </div>
      )}
      <div className="input-wrapper">
        <textarea
          ref={inputRef}
          rows="1"
          placeholder={isStreaming ? '输入消息中途插入... (Enter 发送)' : '输入消息... (Shift+Enter 换行) 输入 / 查看快捷指令'}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          disabled={disabled && !isStreaming}
        />
        <div className="input-select-group">
          <span className="input-select-icon" title="模型">⚡</span>
          <select className="input-select input-select-model" value={model} onChange={e => setSetting('model', e.target.value)}>
            <option value="claude-opus-4-7">Claude Opus 4.7</option>
            <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
            <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
          </select>
        </div>
        <div className="input-select-group">
          <span className="input-select-icon" title="工具权限">🔒</span>
          <select className={`input-select input-select-perm perm-${permissionLevel}`} value={permissionLevel} onChange={e => setSetting('permissionLevel', e.target.value)}>
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
