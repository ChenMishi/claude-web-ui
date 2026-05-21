import { useState, useEffect } from 'react';

const BASE = '/api';

export default function LogPanel() {
  const [logs, setLogs] = useState({ frontend: [], server: [] });
  const [tab, setTab] = useState('server');

  const load = () => {
    fetch(`${BASE}/init/log-errors`).then(r => r.json()).then(d => setLogs(d)).catch(() => {});
  };

  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, []);

  const lines = logs[tab] || [];
  const tabLabel = tab === 'frontend' ? '前端' : '服务端';

  return (
    <div className="log-panel">
      <h2>📋 系统日志</h2>
      <div className="log-tabs">
        <button className={`log-tab ${tab === 'server' ? 'active' : ''}`} onClick={() => setTab('server')}>
          服务端 ({logs.server?.length || 0})
        </button>
        <button className={`log-tab ${tab === 'frontend' ? 'active' : ''}`} onClick={() => setTab('frontend')}>
          前端 ({logs.frontend?.length || 0})
        </button>
        <button className="log-tab log-refresh" onClick={load}>刷新</button>
      </div>
      <div className="log-content">
        {lines.length === 0 ? (
          <div className="log-empty">暂无{tabLabel}日志</div>
        ) : (
          lines.map((l, i) => (
            <div key={i} className={`log-line ${l.includes('ERROR') || l.includes('FATAL') ? 'error' : ''}`}>
              {l}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
