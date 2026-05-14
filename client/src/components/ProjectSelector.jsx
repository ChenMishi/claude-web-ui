import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { getDirs, linkProject } from '../api';

export default function ProjectSelector({ projects, currentProjectId, onSelect, onLink }) {
  const [showDialog, setShowDialog] = useState(false);
  const [currentPath, setCurrentPath] = useState('/root');
  const [dirs, setDirs] = useState([]);

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
            <div className="dialog-breadcrumb">{currentPath}</div>
            <div className="dialog-dir-list">
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
