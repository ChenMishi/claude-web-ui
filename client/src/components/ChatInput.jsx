import { useRef, useCallback, useState, useEffect, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { abortSession, listSkills, uploadChatAttachment } from '../api';
import { getFileIcon } from '../utils/fileIcons';
import ExecutionBar from './ExecutionBar';

import TimerDropdown from './TimerDropdown';
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
  { cmd: '/theme warm', desc: '切换为浅色主题', action: 'theme-warm' },
  { cmd: '/model opus', desc: '切换为 Claude Opus 4.7', action: 'model-opus' },
  { cmd: '/model sonnet', desc: '切换为 Claude Sonnet 4.6', action: 'model-sonnet' },
  { cmd: '/model haiku', desc: '切换为 Claude Haiku 4.5', action: 'model-haiku' },
  { cmd: '/perm auto', desc: '工具权限设为自动执行', action: 'perm-auto' },
  { cmd: '/perm dangerous', desc: '写入/编辑/Bash 需确认', action: 'perm-dangerous' },
  { cmd: '/perm all', desc: '所有工具操作需确认', action: 'perm-all' },
];

function formatSizeLocal(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function InputSelectsCard({ activeSkill, onSkillChange }) {
  const { isStreaming, currentSessionId, execStatus, model, permissionLevel, setSetting,
    setView, currentProjectId, projects,
    availableModels, currentModel, switchCurrentModel, displayMode, modelGroups } = useApp();
  const skillsRef = useRef(null);
  const skillsContainerRef = useRef(null);
  const modelDropdownRef = useRef(null);
  const permDropdownRef = useRef(null);
  const displayDropdownRef = useRef(null);
  const [showSkills, setShowSkills] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showPermDropdown, setShowPermDropdown] = useState(false);
  const [showDisplayDropdown, setShowDisplayDropdown] = useState(false);
  const [skills, setSkills] = useState([]);

  useEffect(() => {
    const project = projects.find(p => p.id === currentProjectId);
    listSkills(project?.cwd || null)
      .then(d => setSkills(d.skills || []))
      .catch(() => {});
  }, [currentProjectId, projects]);

  useEffect(() => {
    if (!showSkills && !showModelDropdown && !showPermDropdown && !showDisplayDropdown) return;
    const handler = (e) => {
      if (showSkills && skillsContainerRef.current && !skillsContainerRef.current.contains(e.target)) {
        setShowSkills(false);
      }
      if (showModelDropdown && modelDropdownRef.current && !modelDropdownRef.current.contains(e.target)) {
        setShowModelDropdown(false);
      }
      if (showPermDropdown && permDropdownRef.current && !permDropdownRef.current.contains(e.target)) {
        setShowPermDropdown(false);
      }
      if (showDisplayDropdown && displayDropdownRef.current && !displayDropdownRef.current.contains(e.target)) {
        setShowDisplayDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSkills, showModelDropdown, showPermDropdown, showDisplayDropdown]);

  return (
    <div className="input-selects-card">
      <div className="input-selects-column">
        <div className="input-selects-row">
          <div className="input-select-group" ref={modelDropdownRef}>
            <span className="input-select-icon" title="模型">⚡</span>
            <button
              className="input-select input-select-model"
              onClick={() => setShowModelDropdown(!showModelDropdown)}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12, padding: '4px 2px', textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', width: 110 }}><span className="input-select-model-text">{currentModel || model}</span></button>
            {showModelDropdown && (
              <div className="input-dropdown-panel">
                {Object.keys(modelGroups).length > 0 ? (
                  Object.entries(modelGroups).map(([id, g]) => [
                    <div key={`h-${id}`} className="input-dropdown-group-header">----{g.name}----</div>,
                    ...(g.models || []).map(m => (
                      <div
                        key={m}
                        className={`input-dropdown-item ${(currentModel || model) === m ? 'active' : ''}`}
                        onClick={() => { switchCurrentModel(m); setShowModelDropdown(false); }}
                      >
                        <span className="input-dropdown-item-text">{m}</span>
                        {(currentModel || model) === m && <span className="check">✓</span>}
                      </div>
                    ))
                  ]).flat()
                ) : (
                  (availableModels.length > 0 ? availableModels : ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']).map(m => (
                    <div
                      key={m}
                      className={`input-dropdown-item ${(currentModel || model) === m ? 'active' : ''}`}
                      onClick={() => { switchCurrentModel(m); setShowModelDropdown(false); }}
                    >
                      {m}
                      {(currentModel || model) === m && <span className="check">✓</span>}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
          <div className={`input-select-group perm-${permissionLevel}`} ref={permDropdownRef}>
            <span className="input-select-icon" title="工具权限">🔒</span>
            <button
              className="input-select input-select-perm"
              onClick={() => setShowPermDropdown(!showPermDropdown)}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12, padding: '4px 2px', textAlign: 'left', whiteSpace: 'nowrap' }}
            >{{ auto: '自动执行', 'confirm-dangerous': '写入确认', 'confirm-all': '全部确认' }[permissionLevel]}</button>
            {showPermDropdown && (
              <div className="input-dropdown-panel">
                {[
                  { value: 'auto', label: '自动执行' },
                  { value: 'confirm-dangerous', label: '写入确认' },
                  { value: 'confirm-all', label: '全部确认' },
                ].map(p => (
                  <div
                    key={p.value}
                    className={`input-dropdown-item ${permissionLevel === p.value ? 'active' : ''}`}
                    onClick={() => { setSetting('permissionLevel', p.value); setShowPermDropdown(false); }}
                  >
                    {p.label}
                    {permissionLevel === p.value && <span className="check">✓</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="input-selects-row">
          <div className="input-select-group" ref={displayDropdownRef}>
            <span className="input-select-icon" title="展示模式">📋</span>
            <button
              className="input-select input-select-display"
              onClick={() => setShowDisplayDropdown(!showDisplayDropdown)}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12, padding: '4px 2px', textAlign: 'left', whiteSpace: 'nowrap' }}
            >{{ full: '完整交互', compact: '精简交互', minimal: '极简交互' }[displayMode]}</button>
            {showDisplayDropdown && (
              <div className="input-dropdown-panel">
                {[
                  { value: 'full', label: '完整交互' },
                  { value: 'compact', label: '精简交互' },
                  { value: 'minimal', label: '极简交互' },
                ].map(d => (
                  <div
                    key={d.value}
                    className={`input-dropdown-item ${displayMode === d.value ? 'active' : ''}`}
                    onClick={() => { setSetting('displayMode', d.value); setShowDisplayDropdown(false); }}
                  >
                    {d.label}
                    {displayMode === d.value && <span className="check">✓</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="input-select-group" style={{ position: 'relative' }} ref={skillsContainerRef}>
          <span className="input-select-icon" title="技能">🧩</span>
          <button
            className="input-select input-select-skill"
            onClick={() => setShowSkills(!showSkills)}
            style={{ background: 'transparent', border: 'none', color: showSkills || activeSkill ? 'var(--accent)' : 'var(--text-primary)', cursor: 'pointer', fontSize: 12, padding: '4px 2px', whiteSpace: 'nowrap' }}
          >{activeSkill ? <>{typeof activeSkill.icon === 'string' ? <span>{activeSkill.icon} </span> : activeSkill.icon}{activeSkill.displayName}</> : '技能'}</button>
          {activeSkill && (
            <button
              onClick={() => { onSkillChange(null); }}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, padding: '0 2px', lineHeight: 1 }}
              title="取消激活"
            >✕</button>
          )}
          {showSkills && (
            <div className="skills-popup" ref={skillsRef}>
              <div className="skills-popup-title">选择技能（激活后改变 Claude 行为模式）</div>
              <div className="skills-popup-grid">
                {skills.length === 0 ? (
                  <div className="skills-popup-empty">暂无技能，前往设置页「技能管理」创建或安装</div>
                ) : (
                  skills.map(s => {
                    const isActive = activeSkill?.name === s.name;
                    return (
                      <button
                        key={s.name}
                        className={`skills-chip ${isActive ? 'active' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isActive) {
                            onSkillChange(null);
                          } else {
                            onSkillChange({ name: s.name, displayName: s.displayName, icon: s.icon || '🧩' });
                          }
                          setShowSkills(false);
                        }}
                      >
                        <span className="skills-chip-icon">{s.icon || '🧩'}</span>
                        <span className="skills-chip-label">{s.displayName || s.name}</span>
                      </button>
                    );
                  })
                )}
              </div>
              <div className="skills-popup-footer">
                <a href="#" onClick={e => { e.preventDefault(); setView('skills'); setShowSkills(false); }}>管理技能 →</a>
              </div>
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}

export default function ChatInput({ onSend, onStop, activeSkill, onSkillChange, queuedMessages, onRemoveQueued, onPrioritize }) {
  const { isStreaming, currentSessionId, execStatus, setSetting,
    setView, setMessages, currentProjectId, selectProject, theme, chatMessages,
    availableModels, model, permissionLevel, projects, currentModel, switchCurrentModel, displayMode, modelGroups } = useApp();
  const inputRef = useRef(null);
  const cmdListRef = useRef(null);
  const skillChipRef = useRef(null);
  const [showCommands, setShowCommands] = useState(false);
  const [filteredCmds, setFilteredCmds] = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Dropdown refs and state (inline-selects)
  const skillsRef = useRef(null);
  const skillsContainerRef = useRef(null);
  const modelDropdownRef = useRef(null);
  const permDropdownRef = useRef(null);
  const displayDropdownRef = useRef(null);
  const [showSkills, setShowSkills] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showPermDropdown, setShowPermDropdown] = useState(false);
  const [showDisplayDropdown, setShowDisplayDropdown] = useState(false);
  const [skills, setSkills] = useState([]);

  useEffect(() => {
    const project = projects.find(p => p.id === currentProjectId);
    listSkills(project?.cwd || null)
      .then(d => setSkills(d.skills || []))
      .catch(() => {});
  }, [currentProjectId, projects]);

  useEffect(() => {
    if (!showSkills && !showModelDropdown && !showPermDropdown && !showDisplayDropdown) return;
    const handler = (e) => {
      if (showSkills && skillsContainerRef.current && !skillsContainerRef.current.contains(e.target)) {
        setShowSkills(false);
      }
      if (showModelDropdown && modelDropdownRef.current && !modelDropdownRef.current.contains(e.target)) {
        setShowModelDropdown(false);
      }
      if (showPermDropdown && permDropdownRef.current && !permDropdownRef.current.contains(e.target)) {
        setShowPermDropdown(false);
      }
      if (showDisplayDropdown && displayDropdownRef.current && !displayDropdownRef.current.contains(e.target)) {
        setShowDisplayDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSkills, showModelDropdown, showPermDropdown, showDisplayDropdown]);

  // 技能切换时：仅当旧前缀在 textarea 中才替换为新前缀
  const prevSkillRef = useRef(null);
  useEffect(() => {
    const prev = prevSkillRef.current;
    prevSkillRef.current = activeSkill?.name || null;
    const el = inputRef.current;
    if (!el) return;

    if (activeSkill && prev && prev !== activeSkill.name && el.value.startsWith('/' + prev)) {
      // old skill prefix present in textarea → replace with new
      let val = el.value.slice(prev.length + 1).replace(/^ /, '');
      el.value = '/' + activeSkill.name + ' ' + val;
    }
  }, [activeSkill]);

  // 测量 skill chip 宽度，设置 textarea padding-left 为 chip 留空间
  useEffect(() => {
    const el = inputRef.current;
    const chip = skillChipRef.current;
    if (el && chip) {
      el.style.paddingLeft = (44 + chip.offsetWidth + 10) + 'px';
    } else if (el) {
      el.style.paddingLeft = '';
    }
  }, [activeSkill]);

  // Toggle scroll animation on model text only when it overflows
  useEffect(() => {
    document.querySelectorAll('.input-select-model-text').forEach(el => {
      if (el.scrollWidth > el.clientWidth) {
        el.classList.add('overflowing');
      } else {
        el.classList.remove('overflowing');
      }
    });
  }, [currentModel, model]);

  // Attachment state
  const [attachments, setAttachments] = useState([]); // { id, file, uploading, metadata }
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const attachIdRef = useRef(0);

  // ── Attachment handlers ──
  const addAttachments = useCallback((files) => {
    const newAttachments = [];
    for (const file of files) {
      const id = ++attachIdRef.current;
      const attachment = { id, file, uploading: true, progress: 0, metadata: null };
      newAttachments.push(attachment);
      // Auto-upload each file with progress
      uploadChatAttachment(file, (ev) => {
        if (ev.lengthComputable) {
          setAttachments(prev => prev.map(a => a.id === id ? { ...a, progress: Math.round((ev.loaded / ev.total) * 100) } : a));
        }
      })
        .then(data => {
          setAttachments(prev => prev.map(a => a.id === id ? { ...a, uploading: false, metadata: data } : a));
        })
        .catch(err => {
          setAttachments(prev => prev.map(a => a.id === id ? { ...a, uploading: false, error: err.message } : a));
        });
    }
    setAttachments(prev => [...prev, ...newAttachments]);
  }, []);

  const removeAttachment = useCallback((id) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments([]);
  }, []);

  // Paste handler
  const handlePaste = useCallback((e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addAttachments(files);
    }
  }, [addAttachments]);

  // Drag and drop handlers
  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length > 0) {
      addAttachments(files);
    }
  }, [addAttachments]);

  // File picker
  const handleFilePick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e) => {
    const files = Array.from(e.target?.files || []);
    if (files.length > 0) {
      addAttachments(files);
    }
    // Reset input so same file can be selected again
    if (e.target) e.target.value = '';
  }, [addAttachments]);

  // Auto-scroll selected command into view
  useEffect(() => {
    if (showCommands && cmdListRef.current) {
      const el = cmdListRef.current.querySelector('.slash-cmd-item.selected');
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIdx, showCommands]);

  const handleSend = useCallback(() => {
    const text = inputRef.current?.value?.trim();
    const hasAttachments = attachments.some(a => a.metadata && !a.uploading);
    const stillUploading = attachments.some(a => a.uploading);
    if (!text && !hasAttachments) return;
    if (stillUploading) return; // wait for uploads
    const uploadedAttachments = attachments
      .filter(a => a.metadata)
      .map(a => a.metadata);
    // Send with skill prefix (chip replaces visible prefix in input)
    const sendText = activeSkill ? '/' + activeSkill.name + ' ' + text : text;
    onSend(sendText, uploadedAttachments.length > 0 ? uploadedAttachments : undefined);
    inputRef.current.value = '';
    inputRef.current.style.height = 'auto';
    setShowCommands(false);
    clearAttachments();
  }, [onSend, activeSkill, attachments, clearAttachments]);

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
        const text = `AI IntelliWork Hub 对话导出\n${new Date().toLocaleString()}\n\n` +
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
      case 'version': setView('settings'); break;
      case 'theme-dark': setSetting('theme', 'dark'); inputRef.current.value = ''; break;
      case 'theme-light': setSetting('theme', 'light'); inputRef.current.value = ''; break;
      case 'theme-warm': setSetting('theme', 'warm'); inputRef.current.value = ''; break;
      case 'model-opus': setSetting('model', 'claude-opus-4-7'); inputRef.current.value = ''; break;
      case 'model-sonnet': setSetting('model', 'claude-sonnet-4-6'); inputRef.current.value = ''; break;
      case 'model-haiku': setSetting('model', 'claude-haiku-4-5-20251001'); inputRef.current.value = ''; break;
      case 'perm-auto': setSetting('permissionLevel', 'auto'); inputRef.current.value = ''; break;
      case 'perm-dangerous': setSetting('permissionLevel', 'confirm-dangerous'); inputRef.current.value = ''; break;
      case 'perm-all': setSetting('permissionLevel', 'confirm-all'); inputRef.current.value = ''; break;
      case 'skill':
        if (cmd.skill) {
          onSkillChange({ name: cmd.skill.name, displayName: cmd.skill.displayName, icon: cmd.skill.icon || '🧩' });
        }
        inputRef.current.value = '';
        break;
      default: break;
    }
    setShowCommands(false);
    inputRef.current?.focus();
  }, [selectProject, setView, setMessages, setSetting, currentProjectId, handleSend, onSkillChange]);

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
        // Merge system commands and skills
        const skillCmds = skills.map(s => ({
          cmd: '/' + s.name,
          desc: s.description || s.displayName,
          action: 'skill',
          skill: s,
        }));
        const all = [...COMMANDS, ...skillCmds];
        const filtered = all.filter(c => c.cmd.toLowerCase().includes(search));
        setFilteredCmds(filtered);
        setShowCommands(filtered.length > 0);
        setSelectedIdx(0);
      } else {
        setShowCommands(false);
      }
    }
  };

  // Close command popup on outside click
  useEffect(() => {
    if (!showCommands) return;
    const handler = () => { setShowCommands(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showCommands]);

  return (
    <div className="input-area" onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      <ExecutionBar />
      {/* Drag overlay */}
      {dragOver && (
        <div className="attach-drop-overlay">
          <span>📎 释放文件以上传</span>
        </div>
      )}
      {queuedMessages && queuedMessages.length > 0 && (
        <div className="queued-messages">
          {queuedMessages.map((item, idx) => (
            <div key={idx} className="queued-item">
              <span className="queued-icon">⏱️</span>
              <span className="queued-text">{item.text}</span>
              <button
                className="queued-prioritize"
                onClick={() => onPrioritize && onPrioritize(idx)}
                title="优先插入，中断当前任务"
              >⚡ 插队</button>
              <button
                className="queued-remove"
                onClick={() => onRemoveQueued && onRemoveQueued(idx)}
                title="取消排队"
              >✕</button>
            </div>
          ))}
        </div>
      )}
      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="attach-previews">
          {attachments.map(a => (
            <div key={a.id} className={`attach-preview ${a.uploading ? 'uploading' : a.error ? 'error' : ''}`}>
              {a.uploading ? (
                <span className="attach-preview-progress">{a.progress}%</span>
              ) : a.error ? (
                <span className="attach-preview-icon" title={a.error}>❌</span>
              ) : (
                <span className="attach-preview-icon">
                  {getFileIcon(a.file.name)}
                </span>
              )}
              <span className="attach-preview-name" title={a.file.name}>{a.file.name}</span>
              {a.metadata && <span className="attach-preview-size">{formatSizeLocal(a.metadata.size)}</span>}
              {a.error && <span className="attach-preview-error">{a.error}</span>}
              <button className="attach-preview-remove" onClick={() => removeAttachment(a.id)} title="移除">✕</button>
            </div>
          ))}
        </div>
      )}
      {showCommands && (
        <div className="slash-commands" ref={cmdListRef}>
          <div className="slash-commands-scroll">
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
        </div>
      )}
      <div className="input-row-inner">
        <button className="attach-btn" onClick={handleFilePick} title="添加附件 (Ctrl+V 粘贴图片)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileChange}
          accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.json,.xml,.html,.md,.py,.js,.ts,.css,.zip,.tar,.gz,.tgz,.7z,.rar"
        />
        <div className="skill-input-wrap">
          {activeSkill && (
            <span className="skill-chip-input" title="点击 × 移除技能" ref={skillChipRef}>
              <span className="skill-chip-icon">{activeSkill.icon || '🧩'}</span>
              <span className="skill-chip-name">{activeSkill.displayName || activeSkill.name}</span>
              <button
                className="skill-chip-remove"
                onClick={() => onSkillChange(null)}
                title="移除技能"
              >×</button>
            </span>
          )}
          <textarea
            ref={inputRef}
            rows="1"
            placeholder={isStreaming ? '输入消息可排队或插入...(Enter 发送)' : '输入消息... (Shift+Enter 换行) 输入 / 查看快捷指令'}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            onPaste={handlePaste}
            disabled={false}
          />
        </div>
        {/* Selectors row below textarea */}
        {isStreaming && (
          <button className="stop-btn" onClick={handleStop}>
            ⏹ 中止
          </button>
        )}
        <button className="send-btn" onClick={handleSend} disabled={false}>
          发送
        </button>
      </div>
      {/* Selectors row below textarea */}
      <div className="input-selects-grid">
        <div className="input-selects-row">
          <div className="input-select-group" ref={modelDropdownRef}>
            <span className="input-select-icon" title="模型">⚡</span>
            <button
              className="input-select input-select-model"
              onClick={() => setShowModelDropdown(!showModelDropdown)}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12, padding: '4px 2px', textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', width: 110 }}><span className="input-select-model-text">{currentModel || model}</span></button>
            {showModelDropdown && (
              <div className="input-dropdown-panel">
                {Object.keys(modelGroups).length > 0 ? (
                  Object.entries(modelGroups).map(([id, g]) => [
                    <div key={`h-${id}`} className="input-dropdown-group-header">----{g.name}----</div>,
                    ...(g.models || []).map(m => (
                      <div
                        key={m}
                        className={`input-dropdown-item ${(currentModel || model) === m ? 'active' : ''}`}
                        onClick={() => { switchCurrentModel(m); setShowModelDropdown(false); }}
                      >
                        <span className="input-dropdown-item-text">{m}</span>
                        {(currentModel || model) === m && <span className="check">✓</span>}
                      </div>
                    ))
                  ]).flat()
                ) : (
                  (availableModels.length > 0 ? availableModels : ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']).map(m => (
                    <div
                      key={m}
                      className={`input-dropdown-item ${(currentModel || model) === m ? 'active' : ''}`}
                      onClick={() => { switchCurrentModel(m); setShowModelDropdown(false); }}
                    >
                      {m}
                      {(currentModel || model) === m && <span className="check">✓</span>}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
          <div className={`input-select-group perm-${permissionLevel}`} ref={permDropdownRef}>
            <span className="input-select-icon" title="工具权限">🔒</span>
            <button
              className="input-select input-select-perm"
              onClick={() => setShowPermDropdown(!showPermDropdown)}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12, padding: '4px 2px', textAlign: 'left', whiteSpace: 'nowrap' }}
            >{{ auto: '自动执行', 'confirm-dangerous': '写入确认', 'confirm-all': '全部确认' }[permissionLevel]}</button>
            {showPermDropdown && (
              <div className="input-dropdown-panel">
                {[
                  { value: 'auto', label: '自动执行' },
                  { value: 'confirm-dangerous', label: '写入确认' },
                  { value: 'confirm-all', label: '全部确认' },
                ].map(p => (
                  <div
                    key={p.value}
                    className={`input-dropdown-item ${permissionLevel === p.value ? 'active' : ''}`}
                    onClick={() => { setSetting('permissionLevel', p.value); setShowPermDropdown(false); }}
                  >
                    {p.label}
                    {permissionLevel === p.value && <span className="check">✓</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="input-select-group" ref={displayDropdownRef}>
            <span className="input-select-icon" title="展示模式">📋</span>
            <button
              className="input-select input-select-display"
              onClick={() => setShowDisplayDropdown(!showDisplayDropdown)}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12, padding: '4px 2px', textAlign: 'left', whiteSpace: 'nowrap' }}
            >{{ full: '完整交互', compact: '精简交互', minimal: '极简交互' }[displayMode]}</button>
            {showDisplayDropdown && (
              <div className="input-dropdown-panel">
                {[
                  { value: 'full', label: '完整交互' },
                  { value: 'compact', label: '精简交互' },
                  { value: 'minimal', label: '极简交互' },
                ].map(d => (
                  <div
                    key={d.value}
                    className={`input-dropdown-item ${displayMode === d.value ? 'active' : ''}`}
                    onClick={() => { setSetting('displayMode', d.value); setShowDisplayDropdown(false); }}
                  >
                    {d.label}
                    {displayMode === d.value && <span className="check">✓</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="input-select-group" style={{ position: 'relative' }} ref={skillsContainerRef}>
          <span className="input-select-icon" title="技能">🧩</span>
          <button
            className="input-select input-select-skill"
            onClick={() => setShowSkills(!showSkills)}
            style={{ background: 'transparent', border: 'none', color: showSkills || activeSkill ? 'var(--accent)' : 'var(--text-primary)', cursor: 'pointer', fontSize: 12, padding: '4px 2px', whiteSpace: 'nowrap' }}
          >{activeSkill ? <>{typeof activeSkill.icon === 'string' ? <span>{activeSkill.icon} </span> : activeSkill.icon}{activeSkill.displayName}</> : '技能'}</button>
          {activeSkill && (
            <button
              onClick={() => { onSkillChange(null); }}
              style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, padding: '0 2px', lineHeight: 1 }}
              title="取消激活"
            >✕</button>
          )}
          {showSkills && (
            <div className="skills-popup" ref={skillsRef}>
              <div className="skills-popup-title">选择技能（激活后改变 Claude 行为模式）</div>
              <div className="skills-popup-grid">
                {skills.length === 0 ? (
                  <div className="skills-popup-empty">暂无技能，前往设置页「技能管理」创建或安装</div>
                ) : (
                  skills.map(s => {
                    const isActive = activeSkill?.name === s.name;
                    return (
                      <button
                        key={s.name}
                        className={`skills-chip ${isActive ? 'active' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isActive) {
                            onSkillChange(null);
                          } else {
                            onSkillChange({ name: s.name, displayName: s.displayName, icon: s.icon || '🧩' });
                          }
                          setShowSkills(false);
                        }}
                      >
                        <span className="skills-chip-icon">{s.icon || '🧩'}</span>
                        <span className="skills-chip-label">{s.displayName || s.name}</span>
                      </button>
                    );
                  })
                )}
              </div>
              <div className="skills-popup-footer">
                <a href="#" onClick={e => { e.preventDefault(); setView('skills'); setShowSkills(false); }}>管理技能 →</a>
              </div>
            </div>
          )}
          </div>
          <TimerDropdown />
        </div>
      </div>
    </div>
  );
}
