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

const TOKEN = () => localStorage.getItem('claude-ui:accessToken') || '';

export default function FileTransfer({ onClose }) {
  const { user } = useApp();
  const rootPath = user?.role !== 'admin' ? (user?.homeDir || `/home/${user?.username}`) : '/root';

  const [mode, setMode] = useState('upload');

  // Server panel
  const [serverPath, setServerPath] = useState(rootPath);
  const [serverDirs, setServerDirs] = useState([]);
  const [serverFiles, setServerFiles] = useState([]);
  const [serverLoading, setServerLoading] = useState(true);
  const [selectedServer, setSelectedServer] = useState({});

  // Transfers
  const [transfers, setTransfers] = useState([]);
  const [msg, setMsg] = useState('');
  const serverNavRef = useRef(0);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  // ═══════════════════════════════════════════════════════════
  // Server panel
  // ═══════════════════════════════════════════════════════════

  const loadServer = useCallback(async () => {
    setServerLoading(true);
    try {
      const r = await fetch(`/api/fs/list?path=${encodeURIComponent(serverPath)}`, {
        headers: { 'Authorization': `Bearer ${TOKEN()}` }
      });
      const d = await r.json();
      setServerDirs(d.dirs || []);
      setServerFiles(d.files || []);
    } catch (e) { setMsg('加载服务器目录失败: ' + e.message); }
    setServerLoading(false);
  }, [serverPath]);

  useEffect(() => { loadServer(); }, [loadServer]);

  const goUpServer = () => {
    if (Date.now() - serverNavRef.current < 200) return;
    serverNavRef.current = Date.now();
    const parent = serverPath.split('/').slice(0, -1).join('/') || '/';
    if (user?.role !== 'admin' && !parent.startsWith(rootPath)) return;
    setServerPath(parent);
    setSelectedServer({});
  };

  const toggleServer = (entry) => {
    setSelectedServer(prev => {
      const next = { ...prev };
      if (next[entry.path]) delete next[entry.path];
      else next[entry.path] = entry;
      return next;
    });
  };

  const toggleAllServer = () => {
    const allFiles = serverFiles.filter(f => !f.name.startsWith('.'));
    const allSelected = allFiles.every(f => selectedServer[f.path]);
    if (allSelected) {
      setSelectedServer({});
    } else {
      const next = {};
      allFiles.forEach(f => { next[f.path] = f; });
      setSelectedServer(next);
    }
  };

  // ═══════════════════════════════════════════════════════════
  // Upload / Download
  // ═══════════════════════════════════════════════════════════

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setMsg('');
    const queue = files.map(f => ({
      id: Date.now() + '_' + Math.random().toString(36).slice(2) + '_' + f.name,
      name: f.name, direction: 'upload',
      loaded: 0, total: f.size, status: 'waiting',
      _file: f,
    }));
    runUploadQueue(queue);
  };

  const runUploadQueue = async (queue) => {
    setTransfers(prev => [...prev, ...queue]);
    for (const item of queue) {
      setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, status: 'transferring' } : t));
      try {
        await uploadFile(serverPath, item._file, (p) => {
          setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, loaded: p.loaded, total: p.total } : t));
        });
        setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, status: 'done', loaded: t.total } : t));
      } catch (err) {
        setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, status: 'error', error: err.message } : t));
      }
    }
    loadServer();
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (folderInputRef.current) folderInputRef.current.value = '';
  };

  const runDownload = async () => {
    const selected = Object.values(selectedServer);
    if (selected.length === 0) { setMsg('请先在服务器目录中选择要下载的文件'); return; }
    setMsg('');
    const queue = selected.map(f => ({
      id: f.path, name: f.name, direction: 'download',
      loaded: 0, total: f.size || 0, status: 'waiting',
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

  const serverBreadcrumb = serverPath.split('/').filter(Boolean);
  const allFilesFiltered = serverFiles.filter(f => !f.name.startsWith('.'));
  const allSelected = allFilesFiltered.length > 0 && allFilesFiltered.every(f => selectedServer[f.path]);
  const selCount = Object.keys(selectedServer).length;

  // ═══════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)' }} />
      <div style={{
        position: 'relative', width: '90vw', maxWidth: 720, height: '80vh', maxHeight: 700,
        background: 'var(--bg-secondary)', borderRadius: 12, display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)', border: '1px solid var(--border)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>📁 文件传输</h3>
          <button onClick={onClose} disabled={isTransferring}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 20, cursor: 'pointer', lineHeight: 1, opacity: isTransferring ? 0.3 : 1 }}
            title="关闭">✕</button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', padding: '0 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {[
            ['upload', '⬆ 上传（本地 → 服务器）'],
            ['download', '⬇ 下载（服务器 → 本地）'],
          ].map(([m, label]) => (
            <button key={m} onClick={() => { setMode(m); setMsg(''); }}
              style={{
                padding: '10px 20px', border: 'none', background: 'transparent',
                color: mode === m ? 'var(--accent)' : 'var(--text-muted)',
                borderBottom: mode === m ? '2px solid var(--accent)' : '2px solid transparent',
                cursor: 'pointer', fontSize: 13, fontWeight: mode === m ? 600 : 400,
              }}>{label}</button>
          ))}
        </div>

        {/* Server directory panel */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* Breadcrumb */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '10px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', marginRight: 4 }}>服务器:</span>
            <span onClick={() => { setServerPath('/'); setSelectedServer({}); }}
              style={{ color: 'var(--accent)', cursor: 'pointer', fontSize: 12 }}>/</span>
            {serverBreadcrumb.map((seg, i) => (
              <span key={i} style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 2 }}>
                <span
                  style={{ color: i === serverBreadcrumb.length - 1 ? 'var(--text-primary)' : 'var(--accent)', cursor: i === serverBreadcrumb.length - 1 ? 'default' : 'pointer' }}
                  onClick={() => { if (i < serverBreadcrumb.length - 1) { setServerPath('/' + serverBreadcrumb.slice(0, i + 1).join('/')); setSelectedServer({}); } }}
                >{seg}</span>
                {i < serverBreadcrumb.length - 1 && <span>/</span>}
              </span>
            ))}
          </div>

          {/* File list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
            {serverLoading ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: 13 }}>加载中...</div>
            ) : (serverDirs.length === 0 && serverFiles.length === 0) ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: 13 }}>空目录</div>
            ) : (
              <>
                {serverPath !== '/' && (
                  <div onClick={goUpServer}
                    style={{ padding: '6px 12px', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)' }}>
                    📁 ..
                  </div>
                )}
                {serverDirs.map(d => (
                  <div key={d.path} onClick={() => { setServerPath(d.path); setSelectedServer({}); }}
                    style={{ padding: '6px 12px', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, borderRadius: 4 }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <span>📁</span>
                    <span>{d.name}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>进入 →</span>
                  </div>
                ))}
                {serverFiles.map(f => {
                  const isSel = !!selectedServer[f.path];
                  return (
                    <div key={f.path} onClick={() => toggleServer(f)}
                      style={{ padding: '6px 12px', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, borderRadius: 4, background: isSel ? 'var(--accent-light)' : 'transparent' }}
                      onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'var(--hover)'; }}
                      onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}>
                      <input type="checkbox" checked={isSel} readOnly style={{ margin: 0 }} />
                      <span>📄</span>
                      <span>{f.name}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>{formatBytes(f.size)}</span>
                    </div>
                  );
                })}
              </>
            )}
          </div>

          {/* Selection bar */}
          {allFilesFiltered.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderTop: '1px solid var(--border)', flexShrink: 0, fontSize: 12, color: 'var(--text-muted)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={allSelected} onChange={toggleAllServer} style={{ margin: 0 }} /> 全选
              </label>
              {selCount > 0 && <span style={{ color: 'var(--accent)' }}>已选 {selCount} 项</span>}
            </div>
          )}
        </div>

        {/* Action bar */}
        <div style={{ display: 'flex', gap: 8, padding: '12px 20px', borderTop: '1px solid var(--border)', flexShrink: 0, alignItems: 'center' }}>
          {mode === 'upload' ? (
            <>
              <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileSelect} />
              <input ref={folderInputRef} type="file" webkitdirectory="" directory="" style={{ display: 'none' }} onChange={handleFileSelect} />
              <button className="init-btn init-btn-save" onClick={() => fileInputRef.current?.click()}>
                📄 选择文件
              </button>
              <button className="init-btn" onClick={() => folderInputRef.current?.click()}
                style={{ background: 'var(--accent-light)', color: 'var(--accent)', border: '1px solid var(--accent)' }}>
                📁 选择文件夹
              </button>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>上传至: {serverPath}</span>
            </>
          ) : (
            <button className="init-btn init-btn-save" onClick={runDownload} disabled={selCount === 0 || isTransferring}>
              ⬇ 下载选中文件 ({selCount})
            </button>
          )}
          {msg && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{msg}</span>}
        </div>

        {/* Transfer queue */}
        {transfers.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border)', flexShrink: 0, maxHeight: 160, overflowY: 'auto', padding: '8px 20px' }}>
            {transfers.map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12 }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.name}
                </span>
                <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontSize: 11 }}>
                  {t.direction === 'upload' ? '⬆' : '⬇'}
                </span>
                {t.status === 'waiting' && <span style={{ color: 'var(--text-muted)' }}>等待中</span>}
                {t.status === 'transferring' && (
                  <div style={{ width: 120, height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ width: t.total ? `${(t.loaded / t.total) * 100}%` : '50%', height: '100%', background: 'var(--accent)', borderRadius: 2, transition: 'width 0.3s' }} />
                  </div>
                )}
                {t.status === 'done' && <span style={{ color: 'var(--success)' }}>✓</span>}
                {t.status === 'error' && <span style={{ color: 'var(--danger)' }} title={t.error}>失败</span>}
                {t.total > 0 && <span style={{ color: 'var(--text-muted)', fontSize: 10, flexShrink: 0 }}>{formatBytes(t.loaded)}/{formatBytes(t.total)}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
