import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../context/AppContext';
import { deleteSession, renameSession, getSessionMessages, getProjectSessions, getProjects } from '../api';

export default function SessionList() {
  const {
    sessions, currentSessionId, selectSession, isStreaming,
    currentProjectId, setMessages, setStreaming,
    setSessions, setProjects, busySessions,
  } = useApp();
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [confirmDel, setConfirmDel] = useState(null); // { id, x, y }

  const handleSelect = (id) => {
    selectSession(id, isStreaming);
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

  const formatDate = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const diff = now - d;
    if (diff < 86400000) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };

  return (
    <div className="session-list">
      {sessions.map(s => (
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
                <span>{formatDate(s.lastModified)}</span>
                {busySessions?.has(s.id) && <span className="session-busy-dot" title="执行中" />}
              </div>
              <div className="session-item-actions">
                <button onClick={(e) => handleRenameStart(e, s.id, s.title)}>✏</button>
                <button className="danger" onClick={(e) => handleDelClick(e, s.id)}>✕</button>
              </div>
            </>
          )}
        </div>
      ))}
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
