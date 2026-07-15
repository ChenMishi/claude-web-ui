import { useApp } from '../context/AppContext';
import { useEffect, useState } from 'react';
import { checkVersion } from '../api';
import { IconMenu } from './icons';
import Sidebar from './Sidebar';
import ChatView from './ChatView';
import FileBrowser from './FileBrowser';
import TerminalView from './TerminalView';
import SettingsPanel from './SettingsPanel';
import SkillsPanel from './SkillsPanel';
import LoginPage from './LoginPage';

const BASE = '/api';

export default function Layout() {
  const { sidebarOpen, activeView, toggleSidebar, setUpdateAvailable, user, authLoading } = useApp();
  const isAdmin = user?.role === 'admin';

  // Global periodic version check — fixed 2-hour interval, runs regardless of active page
  useEffect(() => {
    const INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

    const check = () => {
      checkVersion({}).then(d => {
        if (d.hasUpdate) {
          setUpdateAvailable(true);
        }
        localStorage.setItem('claude-ui:lastCheck', JSON.stringify(d));
      }).catch(() => {});
    };

    // Initial check after 10 seconds
    const initialTimer = setTimeout(check, 10000);
    const timer = setInterval(check, INTERVAL_MS);
    return () => { clearTimeout(initialTimer); clearInterval(timer); };
  }, []);

  if (authLoading) {
    return (
      <div className="auth-loading">
        <div className="auth-loading-spinner" />
        <p>加载中...</p>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return (
    <div className="app-layout">
      {!sidebarOpen && (
        <button className="toggle-sidebar" onClick={toggleSidebar} title="展开侧边栏">
          <IconMenu />
        </button>
      )}
      <Sidebar />
      <main className="main-content">
        {activeView === 'chat' && <ChatView />}
        {activeView === 'files' && <FileBrowser />}
        {activeView === 'terminal' && <TerminalView />}
        {activeView === 'skills' && <SkillsPanel />}
        {isAdmin && activeView === 'settings' && <SettingsPanel />}
      </main>
    </div>
  );
}
