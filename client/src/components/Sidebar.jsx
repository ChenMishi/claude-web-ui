import { useEffect, useState, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { getProjects, getProjectSessions, getSessionMessages, getSessionInfo, getInitStatus } from '../api';
import ProjectSelector from './ProjectSelector';
import SessionList from './SessionList';
import ProfileModal from './ProfileModal';

const THEMES = [
  { key: 'dark', icon: '🌙', label: '深色' },
  { key: 'light', icon: '☀️', label: '白色' },
  { key: 'warm', icon: '🌿', label: '浅色' },
];

export default function Sidebar() {
  const {
    sidebarOpen, toggleSidebar,
    projects, setProjects,
    currentProjectId, selectProject, setSessions,
    currentSessionId, setMessages, chatMessages,
    setView, activeView, theme, setSetting,
    updateAvailable, user, logout, isStreaming,
    restartStatus, restartError, triggerRestart, dismissRestart,
    needInit, setNeedInit,
  } = useApp();
  const isAdmin = user?.role === 'admin';
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(null); // { x, y } or null
  const userMenuRef = useRef(null);

  // Track streaming state in ref to avoid stale closure in effect
  const streamingRef = useRef(false);
  streamingRef.current = isStreaming;

  // Close user menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // Load projects on mount, restore saved project
  useEffect(() => {
    getProjects().then(projects => {
      setProjects(projects);
      if (projects.length > 0) {
        // Non-admin users: auto-select their homeDir project
        let targetId;
        if (user && user.role !== 'admin' && user.homeDir) {
          const homeProject = projects.find(p => p.cwd === user.homeDir);
          targetId = homeProject ? homeProject.id : projects[0].id;
        } else {
          const saved = projects.find(p => p.id === currentProjectId);
          targetId = saved ? saved.id : projects[0].id;
        }
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

  // When session changes, load from server (skip while streaming to avoid overwriting live SSE messages)
  useEffect(() => {
    if (!currentSessionId || !currentProjectId || streamingRef.current) return;
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

  // Check init status on mount for admin users — show hint if not yet configured
  useEffect(() => {
    if (!isAdmin) return;
    getInitStatus().then(d => {
      setNeedInit(!d.providerConfigured);
    }).catch(() => {});
  }, [isAdmin]);

  const handleRestart = () => {
    setConfirmRestart(null);
    setMenuOpen(false);
    triggerRestart();
  };

  return (
    <aside className={`sidebar ${sidebarOpen ? '' : 'collapsed'} ${activeView === 'chat' ? '' : 'compact'}`}>
      <div className="sidebar-header">
        <h2>AI IntelliWork Hub</h2>
        <div className="sidebar-version">v2.1.2</div>
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
          💻 终端
        </button>
        <button className={activeView === 'skills' ? 'active' : ''} onClick={() => setView('skills')}>
          🧩 技能
        </button>
        {isAdmin && (
          <button className={activeView === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>
            🔧 设置
            {(needInit || updateAvailable) && (
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
                {needInit && (
                  <>
                    <span className="nav-init-badge" />
                    <span className="nav-init-tag">点击初始化</span>
                  </>
                )}
                {updateAvailable && (
                  <>
                    <span className="nav-badge" style={{ marginLeft: needInit ? 4 : 0 }} />
                    <span className="nav-update-tag">新版本!</span>
                  </>
                )}
              </span>
            )}
          </button>
        )}

        <div className="sidebar-theme-row">
          <div className="theme-slider" style={{ '--idx': THEMES.findIndex(t => t.key === theme) }}>
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

        <button onClick={toggleSidebar} style={{ marginTop: 4, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, padding: '6px 0', width: '100%', textAlign: 'center' }}>
          ◀ 收起
        </button>
      </nav>

      {user && (
        <div className="sidebar-user-wrap" ref={userMenuRef}>
          <div className="sidebar-user-bar" onClick={() => setMenuOpen(!menuOpen)}>
            {user.avatar ? (
              <img src={user.avatar} alt="" className="sidebar-user-avatar" />
            ) : (
              <div className="sidebar-user-avatar-placeholder">
                {user.username.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div className="sidebar-user-text">
              <span className="sidebar-user-name">{user.username}</span>
              <span className="sidebar-user-role">{user.role === 'admin' ? '管理员' : '用户'}</span>
            </div>
            <span className="sidebar-user-arrow">{menuOpen ? '▼' : '▲'}</span>
          </div>

          {menuOpen && (
            <div className="sidebar-user-menu">
              <button onClick={() => { setProfileOpen(true); setMenuOpen(false); }}>
                ⚙ 个人设置
              </button>
              {isAdmin && (
                <button
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setConfirmRestart({ x: rect.left + rect.width / 2, y: rect.top });
                  }}
                  disabled={restartStatus === 'restarting'}
                >
                  {restartStatus === 'restarting' ? '⏳ 重启中...' : '🔄 重启服务'}
                </button>
              )}
              <button onClick={logout}>
                🚪 退出登录
              </button>
            </div>
          )}
        </div>
      )}

      {profileOpen && <ProfileModal onClose={() => setProfileOpen(false)} />}

      {confirmRestart && (
        <div className="confirm-popup-overlay" onClick={() => setConfirmRestart(null)}>
          <div
            className="confirm-popup"
            style={{ left: confirmRestart.x, top: confirmRestart.y - 10 }}
            onClick={e => e.stopPropagation()}
          >
            <div className="confirm-popup-text">确认重启服务？<br /><small style={{color:'var(--text-muted)',fontSize:11}}>正在进行的会话会中断</small></div>
            <div className="confirm-popup-actions">
              <button className="confirm-popup-cancel" onClick={() => setConfirmRestart(null)}>取消</button>
              <button className="confirm-popup-ok" onClick={handleRestart}>确定重启</button>
            </div>
          </div>
        </div>
      )}

      {restartStatus && (
        <div className="restart-overlay">
          <div className="restart-toast">
            {restartStatus === 'error' ? (
              <>
                <p style={{color:'var(--danger)'}}>重启失败</p>
                <p style={{fontSize:13,color:'var(--text-muted)'}}>{restartError}</p>
                <button className="restart-reload-btn" onClick={dismissRestart}>关闭</button>
              </>
            ) : (
              <>
                {(restartStatus === 'restarting') && <div className="restart-spinner" />}
                {restartStatus === 'restarting' && (
                  <p>服务重启中，请稍候...</p>
                )}
                {restartStatus === 'done' && (
                  <p>服务已重启，即将刷新页面...</p>
                )}
                {restartStatus === 'timeout' && (
                  <>
                    <p>重启超时，请手动检查服务状态</p>
                    <button className="restart-reload-btn" onClick={() => window.location.reload()}>刷新页面</button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
