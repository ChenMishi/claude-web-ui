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
    updateAvailable,
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
          // Saved project matches — load sessions and auto-select latest if none saved
          getProjectSessions(targetId).then(sessions => {
            setSessions(sessions);
            if (!currentSessionId && sessions.length > 0) {
              selectSession(sessions[0].id);
            }
          }).catch(() => {});
        }
      }
    }).catch(() => {});
  }, []);

  // When project changes, load sessions and reload latest messages
  useEffect(() => {
    if (currentProjectId) {
      getProjectSessions(currentProjectId).then(sessions => {
        setSessions(sessions);
        // Always load messages for the most recent (or current) session from server
        const targetId = currentSessionId || (sessions.length > 0 ? sessions[0].id : null);
        if (!targetId) return;
        if (!currentSessionId && sessions.length > 0) {
          selectSession(targetId);
        }
        getSessionMessages(targetId).then(msgs => {
          if (msgs.length === 0) return;
          const chatMsgs = [];
          for (const m of msgs) {
            const content = m.message?.content;
            const ts = m.timestamp ? new Date(m.timestamp).getTime() : null;
            if (typeof content === 'string' && content.trim()) {
              chatMsgs.push({ role: 'user', content, ...(ts && { timestamp: ts }) });
              continue;
            }
            if (!Array.isArray(content)) continue;
            const textBlocks = content.filter(c => c.type === 'text');
            if (textBlocks.length > 0) {
              const text = textBlocks.map(c => c.text).join('');
              chatMsgs.push({ role: m.type === 'user' ? 'user' : 'assistant', content: text, ...(ts && { timestamp: ts }) });
            }
          }
          setMessages(chatMsgs);
        }).catch(() => {});
      }).catch(() => {});
    }
  }, [currentProjectId]);

  // When session changes, load from server (always, to ensure fresh data)
  useEffect(() => {
    if (!currentSessionId || !currentProjectId) return;
    console.log('[loadMessages] loading from server:', currentSessionId);
    console.log('[loadMessages] fetching for session:', currentSessionId);
    getSessionMessages(currentSessionId).then(msgs => {
      console.log('[loadMessages] got', msgs.length, 'raw records from server');
      if (msgs.length === 0) {
        console.warn('[loadMessages] server returned 0 records!');
        return;
      }
      const chatMsgs = [];
      for (const m of msgs) {
        const content = m.message?.content;
        const ts = m.timestamp ? new Date(m.timestamp).getTime() : null;
        if (typeof content === 'string' && content.trim()) {
          chatMsgs.push({ role: 'user', content, ...(ts && { timestamp: ts }) });
          continue;
        }
        if (!Array.isArray(content)) { console.log('[loadMessages] skipping non-array content:', typeof content); continue; }
        const textBlocks = content.filter(c => c.type === 'text');
        if (textBlocks.length > 0) {
          const text = textBlocks.map(c => c.text).join('');
          chatMsgs.push({ role: m.type === 'user' ? 'user' : 'assistant', content: text, ...(ts && { timestamp: ts }) });
        }
      }
      console.log('[loadMessages] converted to', chatMsgs.length, 'text messages');
      if (chatMsgs.length > 0) {
        console.log('[loadMessages] first:', chatMsgs[0].content.slice(0, 50));
        console.log('[loadMessages] last:', chatMsgs[chatMsgs.length - 1].content.slice(0, 50));
      }
      setMessages(chatMsgs);
    }).catch((err) => {
      console.error('[loadMessages] FAILED:', err.message);
      setMessages([{ role: 'system', content: `加载失败: ${err.message}` }]);
    });
  }, [currentSessionId, currentProjectId]);

  const handleNewChat = () => {
    selectProject(currentProjectId);
    setView('chat');
  };

  return (
    <aside className={`sidebar ${sidebarOpen ? '' : 'collapsed'} ${activeView === 'chat' ? '' : 'compact'}`}>
      <div className="sidebar-header">
        <h2>Claude Web UI</h2>
        <div className="sidebar-version">v1.1.0</div>
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
        <button className={activeView === 'version' ? 'active' : ''} onClick={() => setView('version')}>
          🏷 版本
          {updateAvailable && (
            <>
              <span className="nav-badge" />
              <span className="nav-update-tag">新版本可升级!</span>
            </>
          )}
        </button>
        <button className={activeView === 'init' ? 'active' : ''} onClick={() => setView('init')}>
          🔧 初始化
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
