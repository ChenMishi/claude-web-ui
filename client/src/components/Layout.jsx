import { useApp } from '../context/AppContext';
import { useEffect, useState } from 'react';
import { checkVersion } from '../api';
import Sidebar from './Sidebar';
import ChatView from './ChatView';
import FileBrowser from './FileBrowser';
import TerminalView from './TerminalView';
import SettingsPanel from './SettingsPanel';
import InitPanel from './InitPanel';
import LogPanel from './LogPanel';
import LoginPage from './LoginPage';

const BASE = '/api';

export default function Layout() {
  const { sidebarOpen, activeView, toggleSidebar, setUpdateAvailable, user, authLoading } = useApp();
  const isAdmin = user?.role === 'admin';

  // Global periodic version check (runs regardless of active page)
  useEffect(() => {
    const getInterval = () => {
      try { return parseInt(localStorage.getItem('claude-ui:checkInterval') || '0') || 0; }
      catch { return 0; }
    };
    let interval = getInterval();
    if (interval <= 0) return;

    const check = () => {
      checkVersion({}).then(d => {
        if (d.hasUpdate) {
          setUpdateAvailable(true);
          localStorage.setItem('claude-ui:lastCheck', JSON.stringify(d));
        }
      }).catch(() => {});
    };

    const timer = setInterval(check, interval * 60000);
    return () => clearInterval(timer);
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
          ☰
        </button>
      )}
      <Sidebar />
      <main className="main-content">
        {activeView === 'chat' && <ChatView />}
        {activeView === 'files' && <FileBrowser />}
        {activeView === 'terminal' && <TerminalView />}
        {isAdmin && activeView === 'settings' && <SettingsPanel />}
        {isAdmin && activeView === 'init' && <InitPanel />}
        {activeView === 'logs' && <LogPanel />}
      </main>
    </div>
  );
}
