import { useState } from 'react';
import { useApp } from '../context/AppContext';
import { deleteSession, renameSession, getSessionMessages, getProjectSessions, getProjects } from '../api';

export default function SessionList() {
  const {
    sessions, currentSessionId, selectSession,
    currentProjectId, setMessages, setStreaming,
    setSessions, setProjects,
  } = useApp();
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');

  const handleSelect = async (id) => {
    if (id === currentSessionId) return;
    selectSession(id);
    try {
      setMessages([]);
      const msgs = await getSessionMessages(id);
      // Convert to chat format
      const chatMsgs = msgs.map(m => {
        const text = extractText(m.message?.content);
        return { role: m.type === 'user' ? 'user' : 'assistant', content: text, raw: m };
      }).filter(m => m.content);
      setMessages(chatMsgs);
    } catch {}
  };

  const handleDelete = async (e, id) => {
    e.stopPropagation();
    if (!confirm('确定删除此会话？')) return;
    try {
      await deleteSession(id);
      if (currentSessionId === id) selectSession(null);
      getProjectSessions(currentProjectId).then(setSessions).catch(() => {});
      getProjects().then(setProjects).catch(() => {});
    } catch (err) {
      alert(err.message);
    }
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
                <span>{s.status === 'busy' ? '● 运行中' : ''}</span>
              </div>
              <div className="session-item-actions">
                <button onClick={(e) => handleRenameStart(e, s.id, s.title)}>✏</button>
                <button className="danger" onClick={(e) => handleDelete(e, s.id)}>✕</button>
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
    </div>
  );
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === 'text').map(c => c.text).join('');
  }
  return '';
}
