import { useState, useEffect } from 'react';
import { authHeaders } from '../api';

const BASE = '/api';

export default function LogPanel() {
  const [logs, setLogs] = useState({ frontend: [], server: [], init: [], proxy: [], syslog: [] });
  const [tab, setTab] = useState('server');

  const load = () => {
    fetch(`${BASE}/init/log-errors`, { headers: authHeaders() })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => setLogs(d))
      .catch(err => console.error('Log load error:', err));
  };

  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, []);

  const lines = logs[tab] || [];
  const tabs = [
    { key: 'server', label: '服务端' },
    { key: 'frontend', label: '前端' },
    { key: 'init', label: '初始化' },
    { key: 'proxy', label: '代理' },
    { key: 'syslog', label: '系统' },
  ];

  return (
    <div className="log-panel">
      <h2>📋 系统日志</h2>
      <div className="log-tabs">
        {tabs.map(t => (
          <button key={t.key} className={`log-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label} ({logs[t.key]?.length || 0})
          </button>
        ))}
        <button className="log-tab log-refresh" onClick={load}>刷新</button>
      </div>
      <div className="log-content">
        <div className="log-scroll">
        {lines.length === 0 ? (
          <div className="log-empty">暂无日志</div>
        ) : (
          lines.map((l, i) => (
            <div key={i} className={`log-line ${l.includes('ERROR') || l.includes('FATAL') ? 'error' : ''}`}>
              {l}
            </div>
          ))
        )}
        </div>
      </div>
    </div>
  );
}
