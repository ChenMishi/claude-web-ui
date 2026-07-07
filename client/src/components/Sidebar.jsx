import { useEffect, useState, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { getProjects, getProjectSessions, getSessionMessages, getSessionInfo, getInitStatus } from '../api';
import ProjectSelector from './ProjectSelector';
import SessionList from './SessionList';
import ProfileModal from './ProfileModal';
import { IconChat, IconFolder, IconTerminal, IconGrid, IconSettings, IconLogout, IconRestart, IconClock, IconChevronRight, IconChevronLeft, IconChevronUp, IconChevronDown } from './icons';

const THEMES = [
  { key: 'dark', icon: '🌙', label: '深色' },
  { key: 'light', icon: '☀️', label: '白色' },
  { key: 'warm', icon: '🌿', label: '浅色' },
];

export default function Sidebar() {
  const {
    sidebarOpen, toggleSidebar,
    projects, setProjects,
    currentProjectId, selectProject, selectSession, setSessions,
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
  const [sidebarMinimal, setSidebarMinimal] = useState(false);
  const [sidebarUpCollapsed, setSidebarUpCollapsed] = useState(false);
  const userMenuRef = useRef(null);

  // Track streaming state in ref to avoid stale closure in effect
  const streamingRef = useRef(false);
  streamingRef.current = isStreaming;

  // Track whether initial load has already happened to prevent effect chains
  const initialLoadRef = useRef(false);
  const projectLoadedRef = useRef(false);
  const lastLoadedSessionRef = useRef(null);

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

  // Consolidated initialization: load projects → sessions → messages in ONE sequence
  // This replaces three separate useEffect hooks that were triggering each other in a chain,
  // causing duplicate API calls and browser connection pool exhaustion.
  useEffect(() => {
    if (initialLoadRef.current) return;
    initialLoadRef.current = true;

    let cancelled = false;

    async function init() {
      try {
        const projects = await getProjects();
        if (cancelled) return;
        setProjects(projects);
        if (projects.length === 0) return;

        // Determine target project
        let targetProjectId;
        if (user && user.role !== 'admin' && user.homeDir) {
          const homeProject = projects.find(p => p.cwd === user.homeDir);
          targetProjectId = homeProject ? homeProject.id : projects[0].id;
        } else {
          const saved = projects.find(p => p.id === currentProjectId);
          targetProjectId = saved ? saved.id : projects[0].id;
        }

        // If project needs to change, update it first
        if (targetProjectId !== currentProjectId) {
          selectProject(targetProjectId);
          // selectProject clears currentSessionId and chatMessages, so we don't need
          // to load messages here — the next render will trigger another init if needed.
          // But since initialLoadRef is already true, we load directly.
        }

        // Load sessions
        const sessions = await getProjectSessions(targetProjectId);
        if (cancelled) return;
        setSessions(sessions);
        projectLoadedRef.current = true;  // 标记初始项目加载完成，后续切换项目由 effect 接管

        // Determine target session
        const targetSessionId = currentSessionId || (sessions.length > 0 ? sessions[0].id : null);
        if (!targetSessionId) return;

        // Select session if needed
        if (!currentSessionId) {
          selectSession(targetSessionId);
        }

        // Load messages (only if different from last loaded to avoid duplicates)
        if (lastLoadedSessionRef.current === targetSessionId) return;
        lastLoadedSessionRef.current = targetSessionId;

        const msgs = await getSessionMessages(targetSessionId);
        if (cancelled || msgs.length === 0) return;

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
        if (!cancelled) setMessages(chatMsgs);
      } catch (err) {
        if (!cancelled) console.error('[init] Failed:', err.message);
      }
    }

    init();

    return () => { cancelled = true; };
  }, []);

  // When user manually switches sessions, load messages from server
  useEffect(() => {
    if (!currentSessionId || !currentProjectId) return;
    if (streamingRef.current) return;
    // Skip initial load — already handled by the consolidated init effect
    if (!initialLoadRef.current) return;
    if (lastLoadedSessionRef.current === currentSessionId) return;
    lastLoadedSessionRef.current = currentSessionId;

    let cancelled = false;

    getSessionMessages(currentSessionId).then(msgs => {
      if (cancelled || msgs.length === 0) return;
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
      if (!cancelled) setMessages(chatMsgs);
    }).catch((err) => {
      if (!cancelled) {
        console.error('[loadMessages] FAILED:', err.message);
        setMessages([{ role: 'system', content: `加载失败: ${err.message}` }]);
      }
    });

    return () => { cancelled = true; };
  }, [currentSessionId]);

  // 切换项目时自动加载新项目下的会话列表
  useEffect(() => {
    if (!currentProjectId) return;
    if (!projectLoadedRef.current) return;  // 跳过初始加载中
    if (streamingRef.current) return;

    let cancelled = false;

    getProjectSessions(currentProjectId).then(sessions => {
      if (cancelled) return;
      setSessions(sessions);
      // 自动选中第一个会话（如果当前没有选中）
      if (sessions.length > 0) {
        selectSession(sessions[0].id);
      }
    }).catch(() => {});

    return () => { cancelled = true; };
  }, [currentProjectId]);

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
    <aside className={`sidebar ${sidebarOpen ? '' : 'collapsed'} ${sidebarMinimal ? 'minimal' : ''} ${sidebarUpCollapsed ? 'up-collapsed' : ''} ${activeView === 'chat' ? '' : 'compact'}`}>
      <div className="sidebar-header">
        <h2>{sidebarMinimal ? 'AI' : 'AI IntelliWork Hub'}</h2>
        {!sidebarMinimal && <div className="sidebar-version">v2.3.1</div>}
      </div>

      {!sidebarMinimal && (
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
      )}

      <nav className="sidebar-nav">
        <button className={activeView === 'chat' ? 'active' : ''} onClick={() => setView('chat')} title="聊天">
          <IconChat/> {!sidebarMinimal && '聊天'}
        </button>
        <div className={`sidebar-nav-collapsible${sidebarUpCollapsed ? ' collapsed' : ''}`}>
        <button className={activeView === 'files' ? 'active' : ''} onClick={() => setView('files')} title="文件">
          <IconFolder/> {!sidebarMinimal && '文件'}
        </button>
        <button className={activeView === 'terminal' ? 'active' : ''} onClick={() => setView('terminal')} title="终端">
          <IconTerminal/> {!sidebarMinimal && '终端'}
        </button>
        <button className={activeView === 'skills' ? 'active' : ''} onClick={() => setView('skills')} title="技能">
          <IconGrid/> {!sidebarMinimal && '技能'}
        </button>
        {isAdmin && (
          <button className={activeView === 'settings' ? 'active' : ''} onClick={() => setView('settings')} title="设置">
            <IconSettings/> {!sidebarMinimal && '设置'}
            {!sidebarMinimal && (needInit || updateAvailable) && (
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

        {!sidebarMinimal && (
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
        )}
        </div>

        <div className="sidebar-toggle-row">
          <button onClick={() => setSidebarMinimal(!sidebarMinimal)} className="sidebar-minimal-toggle" title={sidebarMinimal ? '展开导航栏' : '折叠为图标'}>
            {sidebarMinimal ? <IconChevronRight/> : <><IconChevronLeft/> 向左折叠导航栏</>}
          </button>
          {!sidebarMinimal && (
          <button onClick={() => setSidebarUpCollapsed(!sidebarUpCollapsed)} className="sidebar-up-toggle-btn" title={sidebarUpCollapsed ? '展开导航' : '向下折叠'}>
            {sidebarUpCollapsed ? <><IconChevronUp/> 向上展开导航栏</> : <><IconChevronDown/> 向下折叠导航栏</>}
          </button>
          )}
        </div>
      </nav>

      {user && (
        <div className="sidebar-user-collapsible">
        <div className="sidebar-user-wrap" ref={userMenuRef}>
          <div className="sidebar-user-bar" onClick={() => setMenuOpen(!menuOpen)}>
            {user.avatar ? (
              <img src={user.avatar} alt="" className="sidebar-user-avatar" />
            ) : (
              <div className="sidebar-user-avatar-placeholder">
                {user.username.slice(0, 2).toUpperCase()}
              </div>
            )}
            {!sidebarMinimal && (
            <div className="sidebar-user-text">
              <span className="sidebar-user-name">{user.username}</span>
              <span className="sidebar-user-role">{user.role === 'admin' ? '管理员' : '用户'}</span>
            </div>
            )}
            {!sidebarMinimal && <span className="sidebar-user-arrow">{menuOpen ? <IconChevronDown/> : <IconChevronUp/>}</span>}
          </div>

          {menuOpen && (
            <div className="sidebar-user-menu">
              <button onClick={() => { setProfileOpen(true); setMenuOpen(false); }}>
                <IconSettings size={14}/> 个人设置
              </button>
              {isAdmin && (
                <button
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setConfirmRestart({ x: rect.left + rect.width / 2, y: rect.top });
                  }}
                  disabled={restartStatus === 'restarting'}
                >
                  {restartStatus === 'restarting' ? <><IconClock/> 重启中...</> : <><IconRestart/> 重启服务</>}
                </button>
              )}
              <button onClick={logout}>
                <IconLogout/> 退出登录
              </button>
            </div>
          )}
        </div>
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
