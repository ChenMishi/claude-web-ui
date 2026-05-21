import { useApp } from '../context/AppContext';
import { useEffect, useState } from 'react';
import Sidebar from './Sidebar';
import ChatView from './ChatView';
import FileBrowser from './FileBrowser';
import TerminalView from './TerminalView';
import SettingsPanel from './SettingsPanel';
import VersionPanel from './VersionPanel';
import InitPanel from './InitPanel';

const BASE = '/api';

export default function Layout() {
  const { sidebarOpen, activeView, toggleSidebar, setUpdateAvailable } = useApp();

  // Global periodic version check (runs regardless of active page)
  useEffect(() => {
    const getInterval = () => {
      try { return parseInt(localStorage.getItem('claude-ui:checkInterval') || '0') || 0; }
      catch { return 0; }
    };
    let interval = getInterval();
    if (interval <= 0) return;

    const check = () => {
      fetch(`${BASE}/version/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).then(r => r.json()).then(d => {
        if (d.hasUpdate) {
          setUpdateAvailable(true);
          localStorage.setItem('claude-ui:lastCheck', JSON.stringify(d));
        }
      }).catch(() => {});
    };

    const timer = setInterval(check, interval * 60000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="app-layout">
      {!sidebarOpen && (
        <button className="toggle-sidebar" onClick={toggleSidebar} title="展开侧边栏">
          ☰
        </button>
      )}
      <Sidebar />
      <main className="main-content">
        <div style={{ display: activeView === 'chat' ? 'flex' : 'none', flex: 1, flexDirection: 'column' }}><ChatView /></div>
        <div style={{ display: activeView === 'files' ? 'flex' : 'none', flex: 1, flexDirection: 'column' }}><FileBrowser /></div>
        <div style={{ display: activeView === 'terminal' ? 'flex' : 'none', flex: 1, flexDirection: 'column' }}><TerminalView /></div>
        <div style={{ display: activeView === 'settings' ? 'flex' : 'none', flex: 1, flexDirection: 'column' }}><SettingsPanel /></div>
        <div style={{ display: activeView === 'version' ? 'flex' : 'none', flex: 1, flexDirection: 'column' }}><VersionPanel /></div>
        <div style={{ display: activeView === 'init' ? 'flex' : 'none', flex: 1, flexDirection: 'column' }}><InitPanel /></div>
      </main>
    </div>
  );
}
