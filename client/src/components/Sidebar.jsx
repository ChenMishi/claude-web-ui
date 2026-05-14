import { useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { getProjects, getProjectSessions } from '../api';
import ProjectSelector from './ProjectSelector';
import SessionList from './SessionList';

export default function Sidebar() {
  const {
    sidebarOpen, toggleSidebar,
    projects, setProjects,
    currentProjectId, selectProject, setSessions,
    setView, activeView,
  } = useApp();

  useEffect(() => {
    getProjects().then(projects => {
      setProjects(projects);
      // Auto-select first project if none selected
      if (projects.length > 0 && !currentProjectId) {
        selectProject(projects[0].id);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (currentProjectId) {
      getProjectSessions(currentProjectId).then(setSessions).catch(() => {});
    }
  }, [currentProjectId]);

  const handleNewChat = () => {
    selectProject(currentProjectId);
    setView('chat');
  };

  return (
    <aside className={`sidebar ${sidebarOpen ? '' : 'collapsed'}`}>
      <div className="sidebar-header">
        <h2>Claude Web UI</h2>
      </div>

      <div className="sidebar-body">
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
        <button onClick={toggleSidebar} style={{ marginTop: 8, color: 'var(--text-muted)' }}>
          ◀ 收起
        </button>
      </nav>
    </aside>
  );
}
