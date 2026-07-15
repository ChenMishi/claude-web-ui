import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../context/AppContext';
import { deleteSession, renameSession, pinSession, getSessionMessages, getProjectSessions, getProjects } from '../api';

export default function SessionList() {
  const {
    sessions, currentSessionId, selectSession, isStreaming,
    currentProjectId, setMessages, setStreaming,
    setSessions, setProjects, busySessions, pendingTaskSessions,
    markTaskSessionRead,
  } = useApp();
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [confirmDel, setConfirmDel] = useState(null); // { id, x, y }
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);

  const pinnedSessions = sessions.filter(s => s.pinned);
  const unpinnedSessions = sessions.filter(s => !s.pinned);
  const hasManyPinned = pinnedSessions.length > 3;

  const handleSelect = (id) => {
    selectSession(id, isStreaming);
    if (pendingTaskSessions?.has(id)) markTaskSessionRead(id);
  };

  const handleDelClick = (e, id) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setConfirmDel({ id, x: rect.left + rect.width / 2, y: rect.top });
  };

  const handleDelete = async () => {
    const id = confirmDel?.id;
    if (!id) return;
    try {
      await deleteSession(id);
      if (currentSessionId === id) selectSession(null);
      getProjectSessions(currentProjectId).then(setSessions).catch(() => {});
      getProjects().then(setProjects).catch(() => {});
    } catch (err) {
      alert(err.message);
    }
    setConfirmDel(null);
  };

  const handleRenameStart = (e, id, title) => {
    e.stopPropagation();
    setEditingId(id);
    setEditTitle(title);
  };

  const handleRenameSubmit = async (e, id) => {
    e.stopPropagation();
    if (editTitle.trim()) {
      try {
        await renameSession(id, editTitle.trim());
        getProjectSessions(currentProjectId).then(setSessions).catch(() => {});
      } catch {}
    }
    setEditingId(null);
  };

  const handlePin = async (e, id, pinned) => {
    e.stopPropagation();
    try {
      await pinSession(id, !pinned);
      getProjectSessions(currentProjectId).then(setSessions).catch(() => {});
    } catch {}
  };

  const formatDate = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const diff = now - d;
    if (diff < 86400000) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };

  const renderSessionItem = (s) => (
    <div
      key={s.id}
      className={`session-item ${s.id === currentSessionId ? 'active' : ''}`}
      onClick={() => handleSelect(s.id)}
    >
      {editingId === s.id ? (
        <input
          value={editTitle}
          onChange={e => setEditTitle(e.target.value)}
          onBlur={e => handleRenameSubmit(e, s.id)}
          onKeyDown={e => { if (e.key === 'Enter') handleRenameSubmit(e, s.id); if (e.key === 'Escape') setEditingId(null); }}
          onClick={e => e.stopPropagation()}
          autoFocus
          style={{
            width: '100%', padding: '4px 8px', background: 'var(--bg-primary)',
            border: '1px solid var(--accent)', borderRadius: 4, color: 'var(--text-primary)',
            fontSize: 13, outline: 'none',
          }}
        />
      ) : (
        <>
          <div className="session-item-title">{s.title}</div>
          <div className="session-item-meta">
            {s.pinned && <span className="session-pin-icon" title="已置顶">📌</span>}
            <span>{formatDate(s.lastModified)}</span>
            {busySessions?.has(s.id) && <span className="session-busy-dot" title="执行中" />}
            {!busySessions?.has(s.id) && pendingTaskSessions?.has(s.id) && <span className="session-task-dot" title="有新的定时任务结果" />}
          </div>
          <div className="session-item-actions">
            <button className="pin" onClick={(e) => handlePin(e, s.id, s.pinned)} title={s.pinned ? '取消置顶' : '置顶'}>
              {s.pinned ? '📌' : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="5 17 12 10 19 17" />
                  <polyline points="5 9 12 2 19 9" />
                </svg>
              )}
            </button>
            <button onClick={(e) => handleRenameStart(e, s.id, s.title)} title="重命名">✏</button>
            <button className="danger" onClick={(e) => handleDelClick(e, s.id)} title="删除">✕</button>
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="session-list">
      {/* ── Pinned sessions ── */}
      {pinnedSessions.length > 0 && (
        <>
          {hasManyPinned && (
            <div className="session-pinned-toggle" onClick={() => setPinnedCollapsed(!pinnedCollapsed)}>
              <span>{pinnedCollapsed ? '▶' : '▼'}</span>
              <span>置顶会话 ({pinnedSessions.length})</span>
            </div>
          )}
          {(!hasManyPinned || !pinnedCollapsed) && pinnedSessions.map(renderSessionItem)}
        </>
      )}

      {/* ── Unpinned sessions ── */}
      {unpinnedSessions.map(renderSessionItem)}

      {sessions.length === 0 && (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 20 }}>
          暂无会话
        </div>
      )}

      {/* Inline confirmation popup — rendered via Portal to avoid backdrop-filter stacking context */}
      {confirmDel && createPortal(
        <div className="confirm-popup-overlay" onClick={() => setConfirmDel(null)}>
          <div
            className="confirm-popup"
            style={{ left: confirmDel.x, top: confirmDel.y - 10 }}
            onClick={e => e.stopPropagation()}
          >
            <div className="confirm-popup-text">确定删除此会话？</div>
            <div className="confirm-popup-actions">
              <button className="confirm-popup-cancel" onClick={() => setConfirmDel(null)}>取消</button>
              <button className="confirm-popup-ok" onClick={handleDelete}>确定</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
