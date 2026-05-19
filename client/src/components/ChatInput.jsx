import { useRef, useCallback, useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { abortSession } from '../api';
import ExecutionBar from './ExecutionBar';

const COMMANDS = [
  { cmd: '/help', desc: '查看所有可用命令', action: 'help' },
  { cmd: '/new', desc: '新建一个空白对话', action: 'new' },
  { cmd: '/clear', desc: '清空当前对话消息', action: 'clear' },
  { cmd: '/init', desc: '初始化项目 CLAUDE.md 文档', action: 'init' },
  { cmd: '/compact', desc: '压缩对话上下文以节省 token', action: 'compact' },
  { cmd: '/add-dir', desc: '添加新的工作目录（链接项目）', action: 'add-dir' },
  { cmd: '/resume', desc: '恢复最近的对话会话', action: 'resume' },
  { cmd: '/rename', desc: '重命名当前会话标题', action: 'rename' },
  { cmd: '/status', desc: '查看当前会话运行状态', action: 'status' },
  { cmd: '/cost', desc: '查看当前会话费用统计', action: 'cost' },
  { cmd: '/copy', desc: '复制 Claude 最后一次回复到剪贴板', action: 'copy' },
  { cmd: '/focus', desc: '切换专注模式（隐藏工具过程）', action: 'focus' },
  { cmd: '/export', desc: '导出当前对话为文本', action: 'export' },
  { cmd: '/diff', desc: '查看项目未提交的代码变更', action: 'diff' },
  { cmd: '/context', desc: '查看当前上下文使用情况', action: 'context' },
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
    setView, setMessages, currentProjectId, selectProject, theme, chatMessages } = useApp();
  const inputRef = useRef(null);
  const cmdListRef = useRef(null);
  const [showCommands, setShowCommands] = useState(false);
  const [filteredCmds, setFilteredCmds] = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Auto-scroll selected command into view
  useEffect(() => {
    if (showCommands && cmdListRef.current) {
      const el = cmdListRef.current.querySelector('.slash-cmd-item.selected');
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIdx, showCommands]);

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
    const el = inputRef.current;
    switch (cmd.action) {
      case 'help':
        el.value = '/help'; break;
      case 'new': selectProject(currentProjectId); setView('chat'); break;
      case 'clear': setMessages([]); break;
      case 'init': el.value = '请帮我初始化这个项目，创建 CLAUDE.md 文档'; handleSend(); return;
      case 'compact': el.value = '请帮我压缩对话上下文'; handleSend(); return;
      case 'add-dir':
        try { document.querySelector('.project-actions button')?.click(); } catch {}
        break;
      case 'resume': el.value = '请恢复我们之前的对话上下文'; handleSend(); return;
      case 'rename':
        try { document.querySelector('.session-item.active .session-item-actions button:first-child')?.click(); } catch {}
        break;
      case 'status': el.value = '请查看当前系统的运行状态'; handleSend(); return;
      case 'cost': el.value = '请统计当前对话的总费用和 token 消耗'; handleSend(); return;
      case 'copy': {
        const lastClaudeMsg = [...(chatMessages || [])].reverse().find(m => m.role === 'assistant');
        if (lastClaudeMsg && typeof lastClaudeMsg.content === 'string') {
          try { navigator.clipboard.writeText(lastClaudeMsg.content).then(() => {}); } catch {}
        }
        break;
      }
      case 'focus': el.value = '请简化后续回复，只展示必要信息'; handleSend(); return;
      case 'export': {
        const msgs = el.value || '';
        const text = `Claude Web UI 对话导出\n${new Date().toLocaleString()}\n\n` +
          (chatMessages || []).map(m => `[${m.role === 'user' ? '你' : 'Claude'}]\n${typeof m.content === 'string' ? m.content : ''}\n`).join('\n');
        try {
          navigator.clipboard.writeText(text).then(() => alert('对话已复制到剪贴板'));
        } catch { alert('导出失败：无法访问剪贴板'); }
        break;
      }
      case 'diff': el.value = '请查看 git 状态和未提交的更改'; handleSend(); return;
      case 'context': el.value = '请分析当前会话的上下文使用情况'; handleSend(); return;
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
        <div className="slash-commands" ref={cmdListRef}>
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
