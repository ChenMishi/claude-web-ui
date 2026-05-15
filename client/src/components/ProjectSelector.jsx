import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { getDirs, linkProject, unlinkProject } from '../api';

const BASE = '/api';

export default function ProjectSelector({ projects, currentProjectId, onSelect, onLink }) {
  const [showDialog, setShowDialog] = useState(false);
  const [currentPath, setCurrentPath] = useState('/root');
  const [dirs, setDirs] = useState([]);
  const [newDirName, setNewDirName] = useState('');

  useEffect(() => {
    if (showDialog) {
      getDirs(currentPath).then(d => setDirs(d.dirs)).catch(() => {});
    }
  }, [showDialog, currentPath]);

  const handleLink = async () => {
    try {
      await linkProject(currentPath);
      onLink();
      setShowDialog(false);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleUnlink = async (id) => {
    if (!confirm('确定取消链接此项目？会话文件不会被删除。')) return;
    try {
      await unlinkProject(id);
      onLink(); // refresh project list
    } catch (err) {
      alert(err.message);
    }
  };

  const handleCreateDir = async () => {
    const name = newDirName.trim();
    if (!name) return;
    try {
      const res = await fetch(`${BASE}/fs/mkdir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentPath, name }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || '创建失败');
      }
      setNewDirName('');
      // Refresh directory listing
      getDirs(currentPath).then(d => setDirs(d.dirs)).catch(() => {});
    } catch (err) {
      alert(err.message);
    }
  };

  const project = projects.find(p => p.id === currentProjectId);

  return (
    <div className="project-selector">
      <select
        value={currentProjectId || ''}
        onChange={(e) => e.target.value && onSelect(e.target.value)}
      >
        {projects.length === 0 && <option value="">无项目</option>}
        {projects.map(p => (
          <option key={p.id} value={p.id}>
            {p.cwd || p.id} ({p.sessionCount})
          </option>
        ))}
      </select>
      <div className="project-actions">
        <button onClick={() => setShowDialog(true)}>+ 链接项目</button>
        {currentProjectId && (
          <button className="danger" onClick={() => handleUnlink(currentProjectId)}>取消链接</button>
        )}
      </div>

      {currentProjectId && project && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', wordBreak: 'break-all' }}>
          {project.cwd}
        </div>
      )}

      {showDialog && (
        <div className="dialog-overlay" onClick={() => setShowDialog(false)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <h3>链接项目目录</h3>
            {/* Breadcrumb with clickable root */}
            <div className="dialog-breadcrumb">
              <span className="breadcrumb-link" onClick={() => setCurrentPath('/')}>/</span>
              {currentPath.split('/').filter(Boolean).map((seg, i, arr) => (
                <span key={i}>
                  <span
                    className="breadcrumb-link"
                    onClick={() => setCurrentPath('/' + arr.slice(0, i + 1).join('/'))}
                  >
                    {seg}
                  </span>
                  {i < arr.length - 1 && ' / '}
                </span>
              ))}
            </div>
            <div className="dialog-dir-list">
              {/* Parent directory */}
              {currentPath !== '/' && (
                <div
                  className="dialog-dir-item"
                  onClick={() => setCurrentPath(currentPath.split('/').slice(0, -1).join('/') || '/')}
                >
                  <span>📁</span>
                  <span className="name" style={{ color: 'var(--text-muted)' }}>..</span>
                </div>
              )}
              {dirs.map(d => (
                <div key={d.path} className="dialog-dir-item">
                  <span>📁</span>
                  <span className="name" onClick={() => setCurrentPath(d.path)}>{d.name}</span>
                  <span className="enter" onClick={() => setCurrentPath(d.path)}>进入 →</span>
                </div>
              ))}
              {dirs.length === 0 && (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  此目录为空
                </div>
              )}
            </div>
            {/* Create new directory */}
            <div className="dialog-mkdir">
              <input
                type="text"
                placeholder="新目录名称..."
                value={newDirName}
                onChange={e => setNewDirName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreateDir(); }}
              />
              <button onClick={handleCreateDir}>创建</button>
            </div>
            <div className="dialog-actions">
              <button className="cancel-btn" onClick={() => setShowDialog(false)}>取消</button>
              <button className="confirm-btn" onClick={handleLink}>链接此目录</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
