import { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { uploadFile, downloadFile } from '../api';

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export default function FileTransfer({ onClose }) {
  const { user } = useApp();
  const rootPath = user?.role !== 'admin' ? (user?.homeDir || `/home/${user?.username}`) : '/root';
  const [mode, setMode] = useState('upload'); // 'upload' | 'download'
  const [serverPath, setServerPath] = useState(rootPath);
  const [serverDirs, setServerDirs] = useState([]);
  const [serverFiles, setServerFiles] = useState([]);
  const [selectedServer, setSelectedServer] = useState({}); // { path: { name, type, size } }
  const [localFiles, setLocalFiles] = useState([]); // [{ file, name, size, id }]
  const [loading, setLoading] = useState(true);
  const [transfers, setTransfers] = useState([]); // [{ id, name, direction, loaded, total, status }]
  const [msg, setMsg] = useState('');
  const localInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const serverNavRef = useRef(0);

  const token = localStorage.getItem('claude-ui:accessToken');

  const loadServerDir = useCallback(() => {
    setLoading(true);
    fetch(`/api/fs/list?path=${encodeURIComponent(serverPath)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(r => r.json())
    .then(d => {
      setServerDirs(d.dirs || []);
      setServerFiles(d.files || []);
      setLoading(false);
    })
    .catch(() => setLoading(false));
  }, [serverPath, token]);

  useEffect(() => { loadServerDir(); }, [loadServerDir]);

  const toggleServerSelect = (item) => {
    setSelectedServer(prev => {
      const next = { ...prev };
      if (next[item.path]) {
        delete next[item.path];
      } else {
        next[item.path] = item;
      }
      return next;
    });
  };

  const handleServerClick = (item) => {
    if (item.type === 'dir') {
      setServerPath(item.path);
      if (mode === 'download') setSelectedServer({});
    } else if (mode === 'download') {
      toggleServerSelect(item);
    }
  };

  const goUp = () => {
    if (Date.now() - serverNavRef.current < 200) return;
    serverNavRef.current = Date.now();
    const parent = serverPath.split('/').slice(0, -1).join('/') || '/';
    if (user?.role !== 'admin' && !parent.startsWith(rootPath)) return;
    setServerPath(parent);
    setSelectedServer({});
  };

  const breadcrumbSegs = serverPath.split('/').filter(Boolean);

  const handleLocalFiles = (e) => {
    const files = Array.from(e.target.files || []);
    setLocalFiles(prev => {
      const existing = new Set(prev.map(f => f.name + f.size));
      const added = files.filter(f => !existing.has(f.name + f.size))
        .map(f => ({ file: f, name: f.webkitRelativePath || f.name, size: f.size, id: Date.now() + Math.random() }));
      return [...prev, ...added];
    });
    e.target.value = '';
  };

  const removeLocalFile = (id) => {
    setLocalFiles(prev => prev.filter(f => f.id !== id));
  };

  const runUpload = async () => {
    if (localFiles.length === 0) {
      setMsg('请先选择要上传的文件');
      return;
    }
    setMsg('');
    const queue = localFiles.map(f => ({
      id: f.id,
      name: f.name,
      direction: 'upload',
      loaded: 0,
      total: f.size,
      status: 'waiting',
    }));
    setTransfers(queue);

    for (const item of queue) {
      const localFile = localFiles.find(f => f.id === item.id);
      if (!localFile) continue;
      setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, status: 'transferring' } : t));
      try {
        await uploadFile(serverPath, localFile.file, (p) => {
          setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, loaded: p.loaded, total: p.total } : t));
        });
        setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, status: 'done', loaded: t.total } : t));
      } catch (err) {
        setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, status: 'error', error: err.message } : t));
      }
    }
    loadServerDir();
    setLocalFiles([]);
  };

  const runDownload = async () => {
    const selected = Object.values(selectedServer);
    if (selected.length === 0) {
      setMsg('请先在服务器目录中选择要下载的文件');
      return;
    }
    setMsg('');
    const queue = selected.map(f => ({
      id: f.path,
      name: f.name,
      direction: 'download',
      loaded: 0,
      total: f.size || 0,
      status: 'waiting',
    }));
    setTransfers(queue);

    for (const item of queue) {
      setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, status: 'transferring' } : t));
      try {
        await downloadFile(item.id, (p) => {
          setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, loaded: p.loaded, total: p.total || p.loaded } : t));
        });
        setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, status: 'done', loaded: t.total } : t));
      } catch (err) {
        setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, status: 'error', error: err.message } : t));
      }
    }
    setSelectedServer({});
  };

  const isTransferring = transfers.some(t => t.status === 'transferring' || t.status === 'waiting');
  const selectedCount = mode === 'upload' ? localFiles.length : Object.keys(selectedServer).length;

  return (
    <div className="modal-overlay" style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {/* Backdrop — no click handler, blocking outside close */}
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)' }} />
      <div className="file-transfer-dialog" style={{
        position: 'relative', width: '85vw', maxWidth: 1100, height: '80vh', maxHeight: 750,
        background: 'var(--bg-secondary)', borderRadius: 12, display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)', border: '1px solid var(--border)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderBottom: '1px solid var(--border)' }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>📁 文件传输</h3>
          <button onClick={onClose} disabled={isTransferring}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 20, cursor: 'pointer', lineHeight: 1, opacity: isTransferring ? 0.3 : 1 }}
            title="关闭">✕</button>
        </div>

        {/* Mode tabs */}
        <div style={{ display: 'flex', gap: 0, padding: '0 20px', borderBottom: '1px solid var(--border)' }}>
          <button onClick={() => { setMode('upload'); setSelectedServer({}); setMsg(''); }}
            style={{ padding: '10px 24px', fontSize: 13, cursor: 'pointer', border: 'none', background: 'transparent',
              color: mode === 'upload' ? 'var(--accent)' : 'var(--text-muted)', borderBottom: mode === 'upload' ? '2px solid var(--accent)' : '2px solid transparent',
              fontWeight: mode === 'upload' ? 600 : 400 }}>
            ⬆ 上传（本地 → 服务器）
          </button>
          <button onClick={() => { setMode('download'); setLocalFiles([]); setMsg(''); }}
            style={{ padding: '10px 24px', fontSize: 13, cursor: 'pointer', border: 'none', background: 'transparent',
              color: mode === 'download' ? 'var(--accent)' : 'var(--text-muted)', borderBottom: mode === 'download' ? '2px solid var(--accent)' : '2px solid transparent',
              fontWeight: mode === 'download' ? 600 : 400 }}>
            ⬇ 下载（服务器 → 本地）
          </button>
        </div>

        {/* Body — two panels */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
          {/* Server panel (left) */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', minWidth: 0 }}>
            <div style={{ padding: '8px 12px', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
              💻 服务器目录
            </div>
            {/* Breadcrumb */}
            <div style={{ padding: '4px 12px', fontSize: 11, overflow: 'auto', whiteSpace: 'nowrap' }}>
              <span onClick={() => setServerPath('/')} style={{ cursor: 'pointer', color: 'var(--accent)' }}>/</span>
              {breadcrumbSegs.map((seg, i) => (
                <span key={i}>
                  <span onClick={() => setServerPath('/' + breadcrumbSegs.slice(0, i + 1).join('/'))}
                    style={{ cursor: 'pointer', color: 'var(--accent)' }}>{seg}</span>
                  {i < breadcrumbSegs.length - 1 && <span style={{ color: 'var(--text-muted)' }}> / </span>}
                </span>
              ))}
            </div>
            {/* File list */}
            <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
              {serverPath !== '/' && (
                <div onClick={goUp} style={{ padding: '6px 12px', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)' }}>
                  📁 <span>..</span>
                </div>
              )}
              {loading ? (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 20 }}>加载中...</div>
              ) : (
                <>
                  {serverDirs.map(d => (
                    <div key={d.path}
                      onClick={() => handleServerClick({ type: 'dir', path: d.path, name: d.name })}
                      style={{ padding: '6px 12px', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6,
                        background: 'transparent', transition: 'background 0.15s' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--hover)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                      📁 {d.name}
                    </div>
                  ))}
                  {mode === 'download' ? (
                    serverFiles.map(f => (
                      <div key={f.path}
                        onClick={() => handleServerClick({ type: 'file', path: f.path, name: f.name })}
                        style={{ padding: '6px 12px', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6,
                          background: selectedServer[f.path] ? 'var(--accent-light)' : 'transparent' }}
                        onMouseEnter={e => { if (!selectedServer[f.path]) e.currentTarget.style.background = 'var(--hover)'; }}
                        onMouseLeave={e => { if (!selectedServer[f.path]) e.currentTarget.style.background = 'transparent'; }}>
                        <input type="checkbox" checked={!!selectedServer[f.path]} onChange={() => toggleServerSelect({ type: 'file', path: f.path, name: f.name })} style={{ margin: 0 }} />
                        📄 {f.name}
                      </div>
                    ))
                  ) : (
                    serverFiles.map(f => (
                      <div key={f.path} style={{ padding: '6px 12px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)' }}>
                        📄 {f.name}
                      </div>
                    ))
                  )}
                  {serverDirs.length === 0 && serverFiles.length === 0 && (
                    <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 20 }}>目录为空</div>
                  )}
                </>
              )}
            </div>
            {/* Server current path hint */}
            <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
              {mode === 'upload' ? '上传目标：' + serverPath : '已选 ' + Object.keys(selectedServer).length + ' 个文件'}
            </div>
          </div>

          {/* Local panel (right) */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ padding: '8px 12px', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
              🖥 本地电脑
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
              {mode === 'upload' ? (
                <>
                  {localFiles.length === 0 ? (
                    <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 40 }}>
                      点击下方按钮选择要上传的文件或文件夹
                    </div>
                  ) : (
                    localFiles.map(f => (
                      <div key={f.id} style={{ padding: '6px 12px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          📄 {f.name}
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>({formatBytes(f.size)})</span>
                        </span>
                        <button onClick={() => removeLocalFile(f.id)}
                          style={{ background: 'transparent', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: 14 }}>✕</button>
                      </div>
                    ))
                  )}
                </>
              ) : (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 40 }}>
                  请在左侧服务器目录中勾选要下载的文件<br />
                  点击文件旁的复选框即可选中
                </div>
              )}
            </div>
            {/* Local actions */}
            <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
              {mode === 'upload' && (
                <>
                  <input type="file" ref={localInputRef} multiple onChange={handleLocalFiles} style={{ display: 'none' }} />
                  <input type="file" ref={folderInputRef} webkitdirectory="" directory="" onChange={handleLocalFiles} style={{ display: 'none' }} />
                  <button onClick={() => localInputRef.current?.click()}
                    style={{ padding: '6px 14px', fontSize: 12, borderRadius: 4, background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer' }}>
                    📄 选择文件
                  </button>
                  <button onClick={() => folderInputRef.current?.click()}
                    style={{ padding: '6px 14px', fontSize: 12, borderRadius: 4, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-primary)', cursor: 'pointer' }}>
                    📁 选择文件夹
                  </button>
                  {localFiles.length > 0 && (
                    <button onClick={() => setLocalFiles([])}
                      style={{ padding: '6px 14px', fontSize: 12, borderRadius: 4, background: 'transparent', border: '1px solid var(--border)', color: 'var(--danger)', cursor: 'pointer' }}>
                      清空
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Progress area */}
        {transfers.length > 0 && (
          <div style={{ padding: '8px 20px', borderTop: '1px solid var(--border)' }}>
            {transfers.map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 12, minWidth: 40 }}>
                  {t.direction === 'upload' ? '⬆' : '⬇'} {t.status === 'waiting' ? '等待' : t.status === 'transferring' ? '传输' : t.status === 'done' ? '完成' : '失败'}
                </span>
                <span style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 80, textAlign: 'right' }}>
                  {t.status === 'done' ? formatBytes(t.total) : t.status === 'error' ? t.error : `${formatBytes(t.loaded)} / ${formatBytes(t.total || t.loaded)}`}
                </span>
                <div style={{ width: 120, height: 6, background: 'var(--bg-primary)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: t.total > 0 ? `${Math.min(100, Math.round((t.loaded / t.total) * 100))}%` : (t.status === 'done' ? '100%' : '20%'),
                    height: '100%', background: t.status === 'error' ? 'var(--danger)' : t.status === 'done' ? '#4caf50' : 'var(--accent)',
                    transition: 'width 0.3s', borderRadius: 3 }} />
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 36, textAlign: 'right' }}>
                  {t.total > 0 ? Math.min(100, Math.round((t.loaded / t.total) * 100)) + '%' : (t.status === 'done' ? '100%' : '')}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* msg */}
        {msg && (
          <div style={{ padding: '4px 20px', fontSize: 12, color: msg.includes('✅') || msg.includes('完成') ? 'var(--success)' : 'var(--danger)' }}>{msg}</div>
        )}

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 20px', borderTop: '1px solid var(--border)' }}>
          {mode === 'upload' ? (
            <button onClick={runUpload} disabled={localFiles.length === 0 || isTransferring}
              style={{ padding: '8px 24px', fontSize: 13, borderRadius: 6, background: localFiles.length === 0 || isTransferring ? 'var(--border)' : 'var(--accent)', color: '#fff', border: 'none', cursor: localFiles.length === 0 || isTransferring ? 'not-allowed' : 'pointer', fontWeight: 600 }}>
              开始上传 ({localFiles.length} 个文件)
            </button>
          ) : (
            <button onClick={runDownload} disabled={Object.keys(selectedServer).length === 0 || isTransferring}
              style={{ padding: '8px 24px', fontSize: 13, borderRadius: 6, background: Object.keys(selectedServer).length === 0 || isTransferring ? 'var(--border)' : 'var(--accent)', color: '#fff', border: 'none', cursor: Object.keys(selectedServer).length === 0 || isTransferring ? 'not-allowed' : 'pointer', fontWeight: 600 }}>
              开始下载 ({Object.keys(selectedServer).length} 个文件)
            </button>
          )}
          <button onClick={onClose} disabled={isTransferring}
            style={{ padding: '8px 24px', fontSize: 13, borderRadius: 6, background: 'transparent', border: '1px solid var(--border)', color: isTransferring ? 'var(--text-muted)' : 'var(--text-primary)', cursor: isTransferring ? 'not-allowed' : 'pointer' }}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
