import { useApp } from '../context/AppContext';
import Sidebar from './Sidebar';
import ChatView from './ChatView';
import FileBrowser from './FileBrowser';
import TerminalView from './TerminalView';
import SettingsPanel from './SettingsPanel';

export default function Layout() {
  const { sidebarOpen, activeView, toggleSidebar } = useApp();

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
        {activeView === 'settings' && <SettingsPanel />}
      </main>
    </div>
  );
}
