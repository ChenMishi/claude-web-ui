import { useState, useEffect, useCallback, useRef } from 'react';
import { authHeaders } from '../api';

const BASE = '/api';

export default function LogPanel() {
  const [logs, setLogs] = useState({ server: [], frontend: [], init: [], proxy: [], access: [], crash: [], syslog: [] });
  const [tab, setTab] = useState('server');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const scrollRef = useRef(null);

  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    fetch(`${BASE}/init/log-errors`, { headers: authHeaders() })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => { setLogs(d); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, []);

  const handleRefresh = () => {
    setRefreshing(true);
    load();
    setTimeout(() => setRefreshing(false), 600);
  };

  useEffect(() => { load(); }, [load]);

  const lines = logs[tab] || [];

  // Auto-scroll to bottom when logs or tab change
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines, tab]);

  const tabs = [
    { key: 'server', label: '服务端' },
    { key: 'frontend', label: '前端' },
    { key: 'proxy', label: '代理' },
    { key: 'access', label: '访问' },
    { key: 'crash', label: '崩溃' },
    { key: 'init', label: '初始化' },
    { key: 'syslog', label: '系统' },
  ];

  return (
    <div className="log-panel">
      <div className="log-tabs">
          {tabs.map(t => (
            <button key={t.key} className={`log-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label} ({logs[t.key]?.length || 0})
            </button>
          ))}
          <button className={`log-tab log-refresh ${refreshing ? 'refreshed' : ''}`} onClick={handleRefresh}>
            {refreshing ? '✓ 已刷新' : '刷新'}
          </button>
        </div>
      <div className="log-content">
        {loading && lines.length === 0 ? (
          <div className="log-empty">加载中...</div>
        ) : error ? (
          <div className="log-empty" style={{ color: 'var(--danger)' }}>加载失败: {error}</div>
        ) : (
          <div className="log-scroll" ref={scrollRef}>
          {lines.length === 0 ? (
            <div className="log-empty">暂无日志</div>
          ) : (
            lines.map((l, i) => (
              <div key={i} className={`log-line ${/\b(error|fatal|fail|exception|err)\b/i.test(l) ? 'error' : ''}`}>
                {l}
              </div>
            ))
          )}
          </div>
        )}
      </div>
    </div>
  );
}
