import { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { IconFolder, IconFile, IconPlay, IconClipboard } from './icons';

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

  // Server panel
  const [serverPath, setServerPath] = useState(rootPath);
  const [serverDirs, setServerDirs] = useState([]);
  const [serverFiles, setServerFiles] = useState([]);
  const [serverLoading, setServerLoading] = useState(true);
  const [selectedServer, setSelectedServer] = useState({});

  // Transfers
  const [transfers, setTransfers] = useState([]);
  const [pendingQueue, setPendingQueue] = useState([]); // 待确认上传的文件
  const [msg, setMsg] = useState('');
  const serverNavRef = useRef(0);
  const dirClickRef = useRef(0);    // 目录双击检测
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  // File System Access API support (avoids Chrome webkitdirectory warning popup)
  const supportsFSA = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

  // ═══════════════════════════════════════════════════════════
  // Server panel
  // ═══════════════════════════════════════════════════════════

  const loadServer = useCallback(async () => {
    setServerLoading(true);
    try {
      const r = await fetch(`/api/fs/list?path=${encodeURIComponent(serverPath)}&all=1`, {
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

  const toggleServer = (entry, isDir) => {
    setSelectedServer(prev => {
      const next = { ...prev };
      if (next[entry.path]) delete next[entry.path];
      else next[entry.path] = { ...entry, isDir: !!isDir };
      return next;
    });
  };

  const toggleAllServer = () => {
    const allItems = [
      ...serverDirs.map(d => ({ ...d, isDir: true })),
      ...serverFiles.filter(f => !f.name.startsWith('.')),
    ];
    const allSelected = allItems.every(item => selectedServer[item.path]);
    if (allSelected) {
      setSelectedServer({});
    } else {
      const next = {};
      allItems.forEach(item => { next[item.path] = item; });
      setSelectedServer(next);
    }
  };

  const selItems = Object.values(selectedServer);
  const selCount = selItems.length;

  // ═══════════════════════════════════════════════════════════
  // Upload
  // ═══════════════════════════════════════════════════════════

  // 递归遍历 File System Access API 目录
  const readFsaDir = async (dirHandle, basePath = '') => {
    const files = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'file') {
        const file = await handle.getFile();
        files.push({ file, relPath: basePath ? `${basePath}/${name}` : name });
      } else if (handle.kind === 'directory') {
        const sub = await readFsaDir(handle, basePath ? `${basePath}/${name}` : name);
        files.push(...sub);
      }
    }
    return files;
  };

  // 使用 File System Access API 选择文件夹（无 Chrome 安全弹窗）
  const selectFolderViaFSA = async () => {
    try {
      const dirHandle = await window.showDirectoryPicker();
      const entries = await readFsaDir(dirHandle);
      if (entries.length === 0) return;
      setMsg('');
      const queue = entries.map(({ file, relPath }) => ({
        id: Date.now() + '_' + Math.random().toString(36).slice(2) + '_' + file.name,
        name: relPath, direction: 'upload',
        loaded: 0, total: file.size, status: 'pending',
        _file: file,
        _relPath: relPath,
      }));
      setPendingQueue(prev => [...prev, ...queue]);
    } catch (err) {
      if (err.name !== 'AbortError') setMsg('选择文件夹失败: ' + err.message);
    }
  };

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setMsg('');
    const queue = files.map(f => ({
      id: Date.now() + '_' + Math.random().toString(36).slice(2) + '_' + f.name,
      name: f.webkitRelativePath || f.name, direction: 'upload',
      loaded: 0, total: f.size, status: 'pending',
      _file: f,
      _relPath: f.webkitRelativePath || f.name,
    }));
    setPendingQueue(prev => [...prev, ...queue]);
    // 重置 input 以便可以重复选择相同文件
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (folderInputRef.current) folderInputRef.current.value = '';
  };

  const startUpload = () => {
    if (pendingQueue.length === 0) return;
    setMsg('');
    const queue = pendingQueue.map(item => ({ ...item, status: 'waiting' }));
    setPendingQueue([]);
    setTransfers(prev => [...prev, ...queue]);
    runUploadQueue(queue);
  };

  const runUploadQueue = async (queue) => {
    for (const item of queue) {
      setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, status: 'transferring' } : t));
      try {
        const file = item._file;
        const relPath = item._relPath || file.webkitRelativePath || file.name;
        // Get the directory part of the relative path
        const dirParts = relPath.split('/');
        const fileName = dirParts.pop();
        const subDir = dirParts.length > 0 ? '/' + dirParts.join('/') : '';
        const targetDir = serverPath + subDir;

        await uploadFileToDir(targetDir, fileName, file, (p) => {
          setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, loaded: p.loaded, total: p.total } : t));
        });
        setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, status: 'done', loaded: t.total } : t));
      } catch (err) {
        setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, status: 'error', error: err.message } : t));
      }
    }
    loadServer();
  };

  const uploadFileToDir = (dir, fileName, file, onProgress) => {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append('dir', dir);
      formData.append('file', file, fileName);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/fs/upload');
      // 不设置 Content-Type，浏览器会自动设置带 boundary 的 multipart/form-data
      xhr.setRequestHeader('Authorization', `Bearer ${TOKEN()}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress({ loaded: e.loaded, total: e.total });
      };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new Error(data.error || `HTTP ${xhr.status}`));
        } catch { reject(new Error('解析响应失败')); }
      };
      xhr.onerror = () => reject(new Error('上传失败'));
      xhr.send(formData);
    });
  };

  // ═══════════════════════════════════════════════════════════
  // Download
  // ═══════════════════════════════════════════════════════════

  const downloadViaXhr = (filePath, fileName, onProgress) => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `/api/fs/download?path=${encodeURIComponent(filePath)}`);
      xhr.responseType = 'blob';
      xhr.setRequestHeader('Authorization', `Bearer ${TOKEN()}`);
      xhr.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress({ loaded: e.loaded, total: e.total });
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const blob = xhr.response;
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          resolve({ ok: true });
        } else {
          // Try to read error as text (blob → text)
          const reader = new FileReader();
          reader.onload = () => {
            try {
              const err = JSON.parse(reader.result);
              reject(new Error(err.error || `HTTP ${xhr.status}`));
            } catch { reject(new Error(`HTTP ${xhr.status}`)); }
          };
          reader.onerror = () => reject(new Error(`HTTP ${xhr.status}`));
          reader.readAsText(xhr.response);
        }
      };
      xhr.onerror = () => reject(new Error('下载失败'));
      xhr.send();
    });
  };

  const runDownload = async () => {
    if (selItems.length === 0) { setMsg('请先选择要下载的文件或目录'); return; }
    setMsg('');

    const queue = selItems.map(item => ({
      id: item.path,
      name: item.isDir ? item.name + '.tar.gz' : item.name,
      direction: 'download',
      loaded: 0, total: item.size || 0, status: 'waiting',
    }));
    setTransfers(queue);

    for (const item of queue) {
      setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, status: 'transferring' } : t));
      try {
        await downloadViaXhr(item.id, item.name, (p) => {
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
  const hasPending = pendingQueue.length > 0;
  const totalTransfers = transfers.length;
  const doneTransfers = transfers.filter(t => t.status === 'done').length;
  const errorTransfers = transfers.filter(t => t.status === 'error').length;

  const serverBreadcrumb = serverPath.split('/').filter(Boolean);
  const allItems = [
    ...serverDirs.map(d => ({ ...d, isDir: true })),
    ...serverFiles.filter(f => !f.name.startsWith('.')).map(f => ({ ...f, isDir: false })),
  ];
  const allSelected = allItems.length > 0 && allItems.every(item => selectedServer[item.path]);

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
          <h3 style={{ margin: 0, fontSize: 16 }}><IconFolder/> 文件传输</h3>
          <button onClick={onClose} disabled={isTransferring}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 20, cursor: 'pointer', lineHeight: 1, opacity: isTransferring ? 0.3 : 1 }}
            title="关闭">✕</button>
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
                    <IconFolder/> ..
                  </div>
                )}
                {serverDirs.map(d => {
                  const isSel = !!selectedServer[d.path];
                  return (
                    <div key={d.path}
                      style={{ padding: '6px 12px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, borderRadius: 4, background: isSel ? 'var(--accent-light)' : 'transparent' }}
                      onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'var(--hover)'; }}
                      onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}>
                      <input type="checkbox" checked={isSel} onChange={() => toggleServer(d, true)} style={{ margin: 0 }} />
                      <span style={{ cursor: 'pointer', flex: 1 }}
                        onClick={() => {
                          const now = Date.now();
                          if (now - dirClickRef.current < 350) {
                            // 双击 → 进入目录
                            dirClickRef.current = 0;
                            setServerPath(d.path);
                            setSelectedServer({});
                          } else {
                            // 单击 → 选中/取消
                            dirClickRef.current = now;
                            toggleServer(d, true);
                          }
                        }}
                        title="单击选中，双击进入"
                      ><IconFolder/> {d.name}</span>
                    </div>
                  );
                })}
                {serverFiles.map(f => {
                  const isSel = !!selectedServer[f.path];
                  return (
                    <div key={f.path} onClick={() => toggleServer(f, false)}
                      style={{ padding: '6px 12px', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, borderRadius: 4, background: isSel ? 'var(--accent-light)' : 'transparent' }}
                      onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'var(--hover)'; }}
                      onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}>
                      <input type="checkbox" checked={isSel} readOnly style={{ margin: 0, pointerEvents: 'none' }} />
                      <span><IconFile/> {f.name}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>{formatBytes(f.size)}</span>
                    </div>
                  );
                })}
              </>
            )}
          </div>

          {/* Selection bar */}
          {allItems.length > 0 && (
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
          <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileSelect} />
          {/* Folder input: prefer File System Access API (no Chrome warning popup), fallback to webkitdirectory */}
          {!supportsFSA && (
            <input ref={folderInputRef} type="file" webkitdirectory="" directory="" style={{ display: 'none' }} onChange={handleFileSelect} />
          )}
          <button className={`init-btn ${hasPending ? 'init-btn-ready' : 'init-btn-save'}`} onClick={startUpload} disabled={!hasPending}>
            <IconPlay/> 开始上传 ({pendingQueue.length})
          </button>
          <button className="init-btn init-btn-save" onClick={runDownload} disabled={selCount === 0 || isTransferring || hasPending}>
            ⬇ 下载选中 ({selCount})
          </button>
          <button className="init-btn" onClick={() => fileInputRef.current?.click()}>
            <IconFile/> 选择本地电脑文件上传
          </button>
          <button className="init-btn" onClick={() => {
            if (supportsFSA) selectFolderViaFSA();
            else folderInputRef.current?.click();
          }}>
            <IconFolder/> 选择本地电脑文件夹上传
          </button>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>{serverPath}</span>
          {msg && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{msg}</span>}
        </div>

        {/* Transfer queue */}
        {(transfers.length > 0 || pendingQueue.length > 0) && (
          <div style={{ borderTop: '1px solid var(--border)', flexShrink: 0, maxHeight: 180, overflowY: 'auto', padding: '8px 20px' }}>
            {pendingQueue.length > 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span><IconClipboard/> 待上传 ({pendingQueue.length} 项)</span>
                <button onClick={() => setPendingQueue([])}
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11, textDecoration: 'underline' }}>清空</button>
              </div>
            )}
            {pendingQueue.map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12 }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.name}>
                  {t.name}
                </span>
                <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontSize: 11 }}>⬆</span>
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>待确认</span>
                {t.total > 0 && <span style={{ color: 'var(--text-muted)', fontSize: 10, flexShrink: 0 }}>{formatBytes(t.total)}</span>}
                <button onClick={() => setPendingQueue(prev => prev.filter(x => x.id !== t.id))}
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}
                  title="移除">✕</button>
              </div>
            ))}
            {transfers.map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12 }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.name}>
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
            {/* 传输统计汇总 */}
            {totalTransfers > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0 0', fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border)', marginTop: 6, position: 'sticky', bottom: 0, background: 'var(--bg-primary)', zIndex: 1 }}>
                <span>共 {totalTransfers} 个文件</span>
                {doneTransfers > 0 && <span style={{ color: 'var(--success)' }}>✓ {doneTransfers} 完成</span>}
                {errorTransfers > 0 && <span style={{ color: 'var(--danger)' }}>✗ {errorTransfers} 失败</span>}
                {isTransferring && <span style={{ color: 'var(--accent)' }}>⏳ 进行中</span>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
