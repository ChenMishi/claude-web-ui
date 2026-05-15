import { useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { getProjects, getProjectSessions, getSessionMessages, getSessionInfo } from '../api';
import ProjectSelector from './ProjectSelector';
import SessionList from './SessionList';

const THEMES = [
  { key: 'dark', icon: '🌙', label: '深色' },
  { key: 'light', icon: '☀️', label: '白色' },
  { key: 'warm', icon: '🍂', label: '暖色' },
];

export default function Sidebar() {
  const {
    sidebarOpen, toggleSidebar,
    projects, setProjects,
    currentProjectId, selectProject, setSessions,
    currentSessionId, setMessages, chatMessages,
    setView, activeView, theme, setSetting,
  } = useApp();

  // Load projects on mount, restore saved project
  useEffect(() => {
    getProjects().then(projects => {
      setProjects(projects);
      if (projects.length > 0) {
        const saved = projects.find(p => p.id === currentProjectId);
        const targetId = saved ? saved.id : projects[0].id;
        if (targetId !== currentProjectId) {
          selectProject(targetId);
        } else {
          getProjectSessions(targetId).then(setSessions).catch(() => {});
        }
      }
    }).catch(() => {});
  }, []);

  // When project changes, load sessions and auto-select most recent
  useEffect(() => {
    if (currentProjectId) {
      getProjectSessions(currentProjectId).then(sessions => {
        setSessions(sessions);
        // Auto-select most recent session if none is active
        if (!currentSessionId && sessions.length > 0) {
          selectSession(sessions[0].id);
        }
      }).catch(() => {});
    }
  }, [currentProjectId]);

  // When session changes and cache is empty, load from server
  useEffect(() => {
    if (!currentSessionId || !currentProjectId) return;
    if (chatMessages.length > 0) return; // Already have messages from cache
    getSessionMessages(currentSessionId).then(msgs => {
      if (msgs.length === 0) return;
      const chatMsgs = [];
      for (const m of msgs) {
        const content = m.message?.content;
        if (typeof content === 'string' && content.trim()) {
          chatMsgs.push({ role: 'user', content });
          continue;
        }
        if (!Array.isArray(content)) continue;
        const textBlocks = content.filter(c => c.type === 'text');
        if (textBlocks.length > 0) {
          const text = textBlocks.map(c => c.text).join('');
          chatMsgs.push({ role: m.type === 'user' ? 'user' : 'assistant', content: text });
        }
      }
      setMessages(chatMsgs);
    }).catch(() => {});
  }, [currentSessionId, currentProjectId]);

  const handleNewChat = () => {
    selectProject(currentProjectId);
    setView('chat');
  };

  return (
    <aside className={`sidebar ${sidebarOpen ? '' : 'collapsed'} ${activeView === 'chat' ? '' : 'compact'}`}>
      <div className="sidebar-header">
        <h2>Claude Web UI</h2>
        <div className="sidebar-version">v2.0.2</div>
      </div>

      <div className="sidebar-body">
        <div className="sidebar-body-inner">
          <ProjectSelector
            projects={projects}
            currentProjectId={currentProjectId}
            onSelect={selectProject}
            onLink={(cwd) => {
              getProjects().then(setProjects).catch(() => {});
            }}
          />

          <button className="new-chat-btn" onClick={handleNewChat}>
            + 新建对话
          </button>

          <SessionList />
        </div>
      </div>

      <nav className="sidebar-nav">
        <button className={activeView === 'chat' ? 'active' : ''} onClick={() => setView('chat')}>
          💬 聊天
        </button>
        <button className={activeView === 'files' ? 'active' : ''} onClick={() => setView('files')}>
          📁 文件
        </button>
        <button className={activeView === 'terminal' ? 'active' : ''} onClick={() => setView('terminal')}>
          🖥 终端
        </button>
        <button className={activeView === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>
          ⚙ 设置
        </button>

        <div className="sidebar-theme-row">
          <div
          className="theme-slider"
          style={{ '--idx': THEMES.findIndex(t => t.key === theme) }}
        >
          {THEMES.map(t => (
            <button
              key={t.key}
              className={`theme-slider-btn ${theme === t.key ? 'active' : ''}`}
              onClick={() => setSetting('theme', t.key)}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>
        </div>

        <button onClick={toggleSidebar} style={{ marginTop: 8, color: 'var(--text-muted)' }}>
          ◀ 收起
        </button>
      </nav>
    </aside>
  );
}
