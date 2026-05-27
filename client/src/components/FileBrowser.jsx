import { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { getDirs, readFile, writeFile, deleteFileOrDir, mkdir } from '../api';
import FileTransfer from './FileTransfer';

export default function FileBrowser() {
  const { user } = useApp();
  const rootPath = user?.role !== 'admin' ? (user?.homeDir || `/home/${user?.username}`) : '/root';
  const [currentPath, setCurrentPath] = useState(rootPath);
  const [dirs, setDirs] = useState([]);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [newDirName, setNewDirName] = useState('');
  const [showNewDir, setShowNewDir] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [showNewFile, setShowNewFile] = useState(false);
  const [msg, setMsg] = useState('');
  const [showTransfer, setShowTransfer] = useState(false);
  const editRef = useRef(null);
  const lastClickRef = useRef(0);

  const loadDir = () => {
    setLoading(true);
    setError(null);
    getDirs(currentPath).then(d => {
      setDirs(d.dirs || []);
      // Also get files
      const dirPath = d.path || currentPath;
      // Fetch file listing from tree-like structure
      setFiles([]);
      setLoading(false);
    }).catch(err => { setError(err.message); setLoading(false); });
  };

  // Also load files via tree API (reuse project tree)
  const loadFiles = () => {
    fetch(`/api/fs/dirs?path=${encodeURIComponent(currentPath)}`, {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('claude-ui:accessToken')}` }
    })
    .then(r => r.json())
    .then(d => {
      setDirs(d.dirs || []);
      // Get files by checking each entry
      loadFileList();
    }).catch(() => {});
  };

  const loadFileList = () => {
    fetch(`/api/fs/list?path=${encodeURIComponent(currentPath)}`, {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('claude-ui:accessToken')}` }
    })
    .then(r => r.json())
    .then(d => {
      if (d.files) setFiles(d.files);
      setLoading(false);
    })
    .catch(() => setLoading(false));
  };

  useEffect(() => { loadFiles(); }, [currentPath]);

  const handleFileClick = async (item) => {
    if (Date.now() - lastClickRef.current < 300) return;
    lastClickRef.current = Date.now();
    if (item.type === 'dir') {
      setCurrentPath(item.path);
      return;
    }
    try {
      const data = await readFileByPath(item.path);
      setFileContent(data.content);
      setFileSize(data.size);
      setSelectedFile(item);
      setEditing(false);
    } catch (err) {
      setFileContent(`// Error: ${err.message}`);
      setSelectedFile(item);
    }
  };

  const readFileByPath = (filePath) => {
    return fetch(`/api/fs/read?path=${encodeURIComponent(filePath)}`, {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('claude-ui:accessToken')}` }
    }).then(r => r.json());
  };

  const handleCreateDir = async () => {
    const name = newDirName.trim();
    if (!name) return;
    try {
      await mkdir(currentPath, name);
      setNewDirName('');
      setShowNewDir(false);
      setMsg('✅ 目录已创建');
      setTimeout(() => setMsg(''), 2000);
      loadFiles();
    } catch (err) {
      setMsg('❌ ' + err.message);
    }
  };

  const handleCreateFile = async () => {
    const name = newFileName.trim();
    if (!name) return;
    const filePath = currentPath + '/' + name;
    try {
      await writeFile(filePath, '');
      setNewFileName('');
      setShowNewFile(false);
      setMsg('✅ 文件已创建');
      setTimeout(() => setMsg(''), 2000);
      loadFiles();
    } catch (err) {
      setMsg('❌ ' + err.message);
    }
  };

  const handleDelete = async (item) => {
    if (!confirm(`确定删除 ${item.name}？`)) return;
    try {
      await deleteFileOrDir(item.path);
      setMsg('✅ 已删除');
      setTimeout(() => setMsg(''), 2000);
      if (selectedFile?.path === item.path) {
        setSelectedFile(null);
        setFileContent('');
      }
      loadFiles();
    } catch (err) {
      setMsg('❌ ' + err.message);
    }
  };

  const handleSaveFile = async () => {
    if (!selectedFile) return;
    try {
      await writeFile(selectedFile.path, editContent);
      setFileContent(editContent);
      setEditing(false);
      setMsg('✅ 已保存');
      setTimeout(() => setMsg(''), 2000);
    } catch (err) {
      setMsg('❌ ' + err.message);
    }
  };

  const goUp = () => {
    if (Date.now() - lastClickRef.current < 300) return;
    lastClickRef.current = Date.now();
    const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
    if (user?.role !== 'admin' && !parent.startsWith(rootPath) && parent !== rootPath) return;
    setCurrentPath(parent);
  };

  const homeBoundary = user?.role !== 'admin' ? rootPath : null;

  const breadcrumbSegs = currentPath.split('/').filter(Boolean);

  return (
    <div className="file-browser">
      <div className="file-tree-panel">
        <div className="file-tree-header">
          <span className="file-tree-title">📁 文件浏览</span>
          <div className="file-tree-toggle">
            <button onClick={() => setShowTransfer(true)} title="文件传输" style={{ fontWeight: 600 }}>📁 文件传输</button>
            <button onClick={() => setShowNewDir(true)} title="新建目录">📂+</button>
            <button onClick={() => setShowNewFile(true)} title="新建文件">📄+</button>
          </div>
        </div>

        {/* Breadcrumb */}
        <div className="dialog-breadcrumb" style={{ padding: '4px 8px', fontSize: 12 }}>
          <span className="breadcrumb-link" onClick={() => setCurrentPath('/')}>/</span>
          {breadcrumbSegs.map((seg, i) => (
            <span key={i}>
              <span className="breadcrumb-link" onClick={() => setCurrentPath('/' + breadcrumbSegs.slice(0, i + 1).join('/'))}>
                {seg}
              </span>
              {i < breadcrumbSegs.length - 1 && ' / '}
            </span>
          ))}
        </div>

        {/* New dir input */}
        {showNewDir && (
          <div style={{ display: 'flex', gap: 4, padding: '4px 8px' }}>
            <input value={newDirName} onChange={e => setNewDirName(e.target.value)}
              placeholder="目录名" style={{ flex: 1, padding: '4px 8px', fontSize: 12, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
              onKeyDown={e => { if (e.key === 'Enter') handleCreateDir(); if (e.key === 'Escape') setShowNewDir(false); }} autoFocus />
            <button onClick={handleCreateDir} style={{ padding: '4px 8px', fontSize: 11, borderRadius: 4, background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer' }}>创建</button>
            <button onClick={() => setShowNewDir(false)} style={{ padding: '4px 8px', fontSize: 11, background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-muted)', cursor: 'pointer' }}>取消</button>
          </div>
        )}

        {/* New file input */}
        {showNewFile && (
          <div style={{ display: 'flex', gap: 4, padding: '4px 8px' }}>
            <input value={newFileName} onChange={e => setNewFileName(e.target.value)}
              placeholder="文件名" style={{ flex: 1, padding: '4px 8px', fontSize: 12, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
              onKeyDown={e => { if (e.key === 'Enter') handleCreateFile(); if (e.key === 'Escape') setShowNewFile(false); }} autoFocus />
            <button onClick={handleCreateFile} style={{ padding: '4px 8px', fontSize: 11, borderRadius: 4, background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer' }}>创建</button>
            <button onClick={() => setShowNewFile(false)} style={{ padding: '4px 8px', fontSize: 11, background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-muted)', cursor: 'pointer' }}>取消</button>
          </div>
        )}

        {msg && (
          <div style={{ padding: '4px 8px', fontSize: 11, color: msg.includes('✅') ? 'var(--success)' : 'var(--danger)' }}>{msg}</div>
        )}

        {/* Directory listing */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {currentPath !== '/' && (
            <div className="file-tree-item dir" onClick={goUp} style={{ paddingLeft: 8 }}>
              📁 <span style={{ color: 'var(--text-muted)' }}>..</span>
            </div>
          )}
          {dirs.map(d => (
            <div key={d.path} style={{ display: 'flex', alignItems: 'center' }}>
              <div className="file-tree-item dir" onClick={() => handleFileClick({ type: 'dir', path: d.path, name: d.name })} style={{ flex: 1, paddingLeft: 8 }}>
                📁 {d.name}
              </div>
              <button onClick={(e) => { e.stopPropagation(); handleDelete({ type: 'dir', path: d.path, name: d.name }); }}
                style={{ padding: '2px 6px', fontSize: 10, background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button>
            </div>
          ))}
          {files.map(f => (
            <div key={f.path} style={{ display: 'flex', alignItems: 'center' }}>
              <div className={`file-tree-item ${selectedFile?.path === f.path ? 'dir' : ''}`}
                onClick={() => handleFileClick({ type: 'file', path: f.path, name: f.name })}
                style={{ flex: 1, paddingLeft: 8 }}>
                {selectedFile?.path === f.path ? '📝' : '📄'} {f.name}
              </div>
              <button onClick={(e) => { e.stopPropagation(); handleDelete({ type: 'file', path: f.path, name: f.name }); }}
                style={{ padding: '2px 6px', fontSize: 10, background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button>
            </div>
          ))}
          {!loading && dirs.length === 0 && files.length === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 20 }}>目录为空</div>
          )}
          {loading && <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 20 }}>加载中...</div>}
          {error && <div style={{ textAlign: 'center', color: 'var(--danger)', fontSize: 12, padding: 20 }}>{error}</div>}
        </div>
      </div>

      {/* File viewer / editor */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {selectedFile ? (
          <>
            <div className="file-viewer-header">
              <h3>{selectedFile.name}</h3>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fileSize} 字节</span>
                {!editing ? (
                  <button onClick={() => { setEditContent(fileContent); setEditing(true); }}
                    style={{ padding: '4px 12px', fontSize: 12, borderRadius: 4, background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer' }}>
                    编辑
                  </button>
                ) : (
                  <>
                    <button onClick={handleSaveFile}
                      style={{ padding: '4px 12px', fontSize: 12, borderRadius: 4, background: '#4caf50', color: '#fff', border: 'none', cursor: 'pointer' }}>
                      保存
                    </button>
                    <button onClick={() => setEditing(false)}
                      style={{ padding: '4px 12px', fontSize: 12, borderRadius: 4, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer' }}>
                      取消
                    </button>
                  </>
                )}
              </div>
            </div>
            {editing ? (
              <textarea ref={editRef} value={editContent} onChange={e => setEditContent(e.target.value)}
                style={{ flex: 1, padding: 16, background: 'var(--bg-primary)', color: 'var(--text-primary)', border: 'none', resize: 'none', fontFamily: 'var(--font-mono)', fontSize: 13, outline: 'none' }} />
            ) : (
              <div className="file-viewer-content" style={{ flex: 1, padding: 16, overflow: 'auto' }}>{fileContent}</div>
            )}
          </>
        ) : (
          <div className="empty-state">选择左侧文件以查看内容</div>
        )}
      </div>
      {showTransfer && <FileTransfer onClose={() => setShowTransfer(false)} />}
    </div>
  );
}
