import { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { getDirs, linkProject, unlinkProject, mkdir } from '../api';

export default function ProjectSelector({ projects, currentProjectId, onSelect, onLink }) {
  const { user, setView } = useApp();
  const isAdmin = user?.role === 'admin';
  const [showDialog, setShowDialog] = useState(false);
  const [currentPath, setCurrentPath] = useState(user?.role !== 'admin' ? (user?.homeDir || '/root') : '/root');
  const [dirs, setDirs] = useState([]);
  const [newDirName, setNewDirName] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null); // { id, x, y }
  const dropdownRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    };
    if (dropdownOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  useEffect(() => {
    if (showDialog) {
      getDirs(currentPath).then(d => setDirs(d.dirs)).catch(() => setDirs([]));
    }
  }, [showDialog, currentPath]);

  // For non-admin users, don't allow navigating above homeDir
  const homeBoundary = user?.role !== 'admin' ? (user?.homeDir || `/home/${user?.username}`) : null;

  const goUp = () => {
    const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
    // Restrict: non-admin users cannot navigate above their homeDir
    if (homeBoundary && !parent.startsWith(homeBoundary) && parent !== homeBoundary) return;
    setCurrentPath(parent);
  };

  const handleLink = async () => {
    try {
      const result = await linkProject(currentPath);
      onSelect(result.id);
      onLink();
      setShowDialog(false);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleUnlink = async (id) => {
    try {
      await unlinkProject(id);
      setConfirmDel(null);
      onLink();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDelClick = (e, id) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setConfirmDel({ id, x: rect.left + rect.width / 2, y: rect.top });
  };

  const handleCreateDir = async () => {
    const name = newDirName.trim();
    if (!name) return;
    try {
      await mkdir(currentPath, name);
      setNewDirName('');
      getDirs(currentPath).then(d => setDirs(d.dirs)).catch(() => {});
    } catch (err) {
      alert(err.message);
    }
  };

  const project = projects.find(p => p.id === currentProjectId);

  return (
    <div className="project-selector" ref={dropdownRef}>
      <div className="project-section-label">选取会话存储目录</div>
      {/* Wrap trigger + dropdown so dropdown is positioned right below trigger */}
      <div className="project-dropdown-wrap">
        <div className="project-dropdown-trigger" onClick={() => setDropdownOpen(!dropdownOpen)}>
          <span className="project-dropdown-label">
            {project ? project.cwd : '选择项目...'}
          </span>
          <span className="project-dropdown-arrow">{dropdownOpen ? '▲' : '▼'}</span>
        </div>

        {dropdownOpen && (
          <div className="project-dropdown-list">
            <div className="project-dropdown-scroll">
            {projects.length === 0 && (
              <div className="project-dropdown-empty">无项目</div>
            )}
            {projects.map(p => (
              <div
                key={p.id}
                className={`project-dropdown-item ${p.id === currentProjectId ? 'active' : ''}`}
                onClick={() => { onSelect(p.id); setDropdownOpen(false); }}
              >
                <span className="project-dropdown-path">{p.cwd}</span>
                <span className="project-dropdown-count">({p.sessionCount})</span>
                <button
                  className="project-dropdown-del"
                  onClick={(e) => handleDelClick(e, p.id)}
                  title="取消链接"
                >
                  ×
                </button>
              </div>
            ))}
            </div>
          </div>
        )}
      </div>

      <div className="project-actions">
        <button onClick={() => setShowDialog(true)}>+ 添加会话存储目录</button>
        <button className="new-chat-btn-inline" onClick={() => { onSelect(currentProjectId); setView('chat'); }}>
          + 新建对话
        </button>
      </div>

      {/* Inline confirmation popup */}
      {confirmDel && (
        <div
          className="confirm-popup-overlay"
          onClick={() => setConfirmDel(null)}
        >
          <div
            className="confirm-popup"
            style={{ left: confirmDel.x, top: confirmDel.y - 10 }}
            onClick={e => e.stopPropagation()}
          >
            <div className="confirm-popup-text">此操作会清空该目录下所有会话数据</div>
            <div className="confirm-popup-actions">
              <button className="confirm-popup-cancel" onClick={() => setConfirmDel(null)}>取消</button>
              <button className="confirm-popup-ok" onClick={() => handleUnlink(confirmDel.id)}>确定</button>
            </div>
          </div>
        </div>
      )}

      {showDialog && (
        <div className="dialog-overlay" onClick={() => setShowDialog(false)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <h3>添加会话存储目录</h3>
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
              <div className="dialog-dir-scroll">
              {currentPath !== '/' && (
                <div className="dialog-dir-item" onClick={goUp}>
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
            </div>
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
