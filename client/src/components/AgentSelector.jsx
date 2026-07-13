import { useState, useEffect, useRef, useCallback } from 'react';
import { listAgents } from '../api';

const DEPT_ORDER = ['engineering','marketing','design','product','security','testing','sales',
  'paid-media','finance','strategy','support','specialized','game-development','academic',
  'gis','spatial-computing','legal','hr','supply-chain','project-management'];

export default function AgentSelector({ activeAgent, onAgentChange }) {
  const [show, setShow] = useState(false);
  const [agents, setAgents] = useState([]);
  const [search, setSearch] = useState('');
  const containerRef = useRef(null);
  const popupRef = useRef(null);
  const clickFlag = useRef(false);

  useEffect(() => {
    listAgents().then(d => setAgents(d.agents || [])).catch(() => {});
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!show) return;
    clickFlag.current = false;
    const h = (e) => {
      if (clickFlag.current) { clickFlag.current = false; return; }
      if (popupRef.current && !popupRef.current.contains(e.target)) setShow(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [show]);

  const grouped = (() => {
    const q = search.toLowerCase().trim();
    const filtered = q ? agents.filter(a =>
      a.name.toLowerCase().includes(q) ||
      (a.description || '').toLowerCase().includes(q) ||
      a.departmentName.includes(q)
    ) : agents;

    const map = {};
    for (const a of filtered) {
      if (!map[a.department]) { map[a.department] = { name: a.departmentName, agents: [] }; }
      map[a.department].agents.push(a);
    }
    // Sort departments by predefined order
    const sorted = [];
    for (const dk of DEPT_ORDER) { if (map[dk]) sorted.push(map[dk]); }
    for (const [dk, v] of Object.entries(map)) { if (!DEPT_ORDER.includes(dk)) sorted.push(v); }
    return sorted;
  })();

  const handleSelect = (agent) => {
    onAgentChange(agent);
    setShow(false);
    setSearch('');
  };

  return (
    <div className="input-select-group agent-selector-group" style={{ position: 'relative' }} ref={containerRef}
      onMouseDownCapture={() => { clickFlag.current = true; }}>
      <span className="input-select-icon" title="AI专家角色">🤖</span>
      <button
        className="input-select input-select-skill"
        onClick={() => { setShow(!show); setSearch(''); }}
        style={{ background: 'transparent', border: 'none', color: show || activeAgent ? 'var(--accent)' : 'var(--text-primary)', cursor: 'pointer', fontSize: 12, padding: '4px 2px', whiteSpace: 'nowrap' }}
      >{activeAgent ? <>{activeAgent.emoji} {activeAgent.name}</> : 'AI专家'}</button>
      {activeAgent && (
        <button
          onClick={() => onAgentChange(null)}
          style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, padding: '0 2px', lineHeight: 1 }}
          title="取消角色"
        >✕</button>
      )}
      {show && (
        <div className="skills-popup agent-popup" ref={popupRef} style={{ minWidth: 420, maxHeight: 480, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div className="skills-popup-title">AI 专家角色 ({agents.length})</div>
          <input
            className="skills-search-input"
            style={{ margin: '8px 16px', width: 'auto' }}
            placeholder="搜索角色..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
          />
          <div style={{ overflow: 'auto', flex: 1, padding: '0 16px 12px' }}>
            {grouped.length === 0 ? (
              <div className="skills-popup-empty">没有匹配的角色</div>
            ) : (
              grouped.map(g => (
                <div key={g.name} style={{ marginBottom: 8 }}>
                  <div className="agent-dept-label">{g.name} ({g.agents.length})</div>
                  <div className="agent-grid">
                    {g.agents.map(a => {
                      const isActive = activeAgent?.id === a.id;
                      return (
                        <button
                          key={a.id}
                          className={`agent-chip ${isActive ? 'active' : ''}`}
                          onClick={(e) => { e.stopPropagation(); handleSelect(a); }}
                          title={a.description}
                        >
                          <span className="agent-chip-emoji">{a.emoji}</span>
                          <span className="agent-chip-name">{a.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
