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

const hasDirPicker = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

// ── IndexedDB persistence for FileSystemDirectoryHandle ──
const DB_NAME = 'claude-ui-fs';
const DB_VERSION = 1;

function openFSDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => { req.result.createObjectStore('handles'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveDirHandle(handle) {
  try {
    const db = await openFSDB();
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(handle, 'rootDir');
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
    db.close();
  } catch { /* IndexedDB unavailable */ }
}

async function loadDirHandle() {
  try {
    const db = await openFSDB();
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readonly');
      const req = tx.objectStore('handles').get('rootDir');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle || null;
  } catch { return null; }
}

async function clearDirHandle() {
  try {
    const db = await openFSDB();
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').delete('rootDir');
    db.close();
  } catch { /* ignore */ }
}

export default function FileTransfer({ onClose }) {
  const { user } = useApp();
  const rootPath = user?.role !== 'admin' ? (user?.homeDir || `/home/${user?.username}`) : '/root';

  // ── Mode ──
  const [mode, setMode] = useState('upload');

  // ── Server panel (left) ──
  const [serverPath, setServerPath] = useState(rootPath);
  const [serverDirs, setServerDirs] = useState([]);
  const [serverFiles, setServerFiles] = useState([]);
  const [serverLoading, setServerLoading] = useState(true);
  const [selectedServer, setSelectedServer] = useState({});

  // ── Local panel (right) – File System Access API ──
  const [dirStack, setDirStack] = useState([]);          // [rootHandle, sub1, sub2, ...]
  const [localEntries, setLocalEntries] = useState([]);   // [{ name, kind, handle }]
  const [localDirName, setLocalDirName] = useState('');   // root dir display name
  const [localLoading, setLocalLoading] = useState(false);
  const [localRestoring, setLocalRestoring] = useState(false); // auto-restore in progress
  const [selectedLocal, setSelectedLocal] = useState({}); // { key: entry }
  const localInitRef = useRef(false);

  // ── Legacy file input (fallback) ──
  const [legacyFiles, setLegacyFiles] = useState([]);
  const localInputRef = useRef(null);
  const folderInputRef = useRef(null);

  // ── Transfers ──
  const [transfers, setTransfers] = useState([]);
  const [msg, setMsg] = useState('');
  const serverNavRef = useRef(0);

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

  const serverBreadcrumb = serverPath.split('/').filter(Boolean);

  const goUpServer = () => {
    if (Date.now() - serverNavRef.current < 200) return;
    serverNavRef.current = Date.now();
    const parent = serverPath.split('/').slice(0, -1).join('/') || '/';
    if (user?.role !== 'admin' && !parent.startsWith(rootPath)) return;
    setServerPath(parent);
    setSelectedServer({});
  };

  // ═══════════════════════════════════════════════════════════
  // Local panel – File System Access API
  // ═══════════════════════════════════════════════════════════

  const readDirEntries = useCallback(async (handle) => {
    setLocalLoading(true);
    const entries = [];
    try {
      for await (const entry of handle.values()) {
        entries.push({ name: entry.name, kind: entry.kind, handle: entry });
      }
      entries.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } catch (e) {
      setMsg('读取本地目录失败: ' + e.message);
    }
    setLocalEntries(entries);
    setLocalLoading(false);
  }, []);

  // ── Auto-restore saved directory handle on mount ──
  useEffect(() => {
    if (localInitRef.current || !hasDirPicker) return;
    localInitRef.current = true;

    (async () => {
      setLocalRestoring(true);
      try {
        const handle = await loadDirHandle();
        if (!handle) { setLocalRestoring(false); return; }

        // Request permission to re-use the handle
        const perm = await handle.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') { await clearDirHandle(); setLocalRestoring(false); return; }

        setDirStack([handle]);
        setLocalDirName(handle.name);
        await readDirEntries(handle);
      } catch {
        await clearDirHandle();
      }
      setLocalRestoring(false);
    })();
  }, [readDirEntries]);

  const openLocalDir = useCallback(async (e) => {
    e?.preventDefault?.();
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      setDirStack([handle]);
      setLocalDirName(handle.name);
      setSelectedLocal({});
      await readDirEntries(handle);
      // Persist handle so next time it auto-restores
      saveDirHandle(handle);
    } catch (e) {
      if (e.name !== 'AbortError') setMsg('打开目录失败: ' + e.message);
    }
  }, [readDirEntries]);

  const enterLocalDir = useCallback(async (entry) => {
    try {
      const current = dirStack[dirStack.length - 1];
      const subHandle = await current.getDirectoryHandle(entry.name);
      const newStack = [...dirStack, subHandle];
      setDirStack(newStack);
      setSelectedLocal({});
      await readDirEntries(subHandle);
    } catch (e) {
      setMsg('进入目录失败: ' + e.message);
    }
  }, [dirStack, readDirEntries]);

  const goUpLocal = useCallback(async () => {
    if (dirStack.length <= 1) return;
    const newStack = dirStack.slice(0, -1);
    setDirStack(newStack);
    setSelectedLocal({});
    await readDirEntries(newStack[newStack.length - 1]);
  }, [dirStack, readDirEntries]);

  const closeLocalDir = () => {
    setDirStack([]);
    setLocalEntries([]);
    setLocalDirName('');
    setSelectedLocal({});
    clearDirHandle();
  };

  const toggleLocalSelect = (entry) => {
    const key = entry.name + '|' + entry.kind;
    setSelectedLocal(prev => {
      const n = { ...prev };
      n[key] ? delete n[key] : n[key] = entry;
      return n;
    });
  };

  const selectAllLocal = () => {
    const files = localEntries.filter(e => e.kind === 'file');
    if (files.length === 0) return;
    const allSelected = files.every(f => selectedLocal[f.name + '|file']);
    if (allSelected) {
      setSelectedLocal({});
    } else {
      const next = {};
      files.forEach(f => { next[f.name + '|' + f.kind] = f; });
      setSelectedLocal(next);
    }
  };

  // Breadcrumb segments for local dir
  const localBreadcrumb = dirStack.map((h, i) => ({
    name: i === 0 ? localDirName : h.name,
    depth: i,
  }));

  // ═══════════════════════════════════════════════════════════
  // Legacy file input (browser file picker fallback)
  // ═══════════════════════════════════════════════════════════

  const handleLegacyFiles = (e) => {
    const files = Array.from(e.target.files || []);
    setLegacyFiles(prev => {
      const existing = new Set(prev.map(f => f.name + f.size));
      const added = files
        .filter(f => !existing.has(f.name + f.size))
        .map(f => ({ file: f, name: f.webkitRelativePath || f.name, size: f.size, id: Date.now() + Math.random() }));
      return [...prev, ...added];
    });
    e.target.value = '';
  };

  const removeLegacyFile = (id) => {
    setLegacyFiles(prev => prev.filter(f => f.id !== id));
  };

  // ═══════════════════════════════════════════════════════════
  // Upload / Download
  // ═══════════════════════════════════════════════════════════

  const picked = Object.values(selectedLocal);
  const totalUpload = picked.length + legacyFiles.length;

  const runUpload = async () => {
    if (totalUpload === 0) { setMsg('请先选择要上传的文件'); return; }
    setMsg('');

    const queue = [];

    // From directory picker: need to get File via handle.getFile()
    for (const entry of picked) {
      queue.push({
        id: entry.name,
        name: entry.name,
        direction: 'upload',
        loaded: 0,
        total: 0,
        status: 'waiting',
        _source: 'picker',
        _entry: entry,
      });
    }
    // From legacy input: already have File object
    for (const f of legacyFiles) {
      queue.push({
        id: f.id,
        name: f.name,
        direction: 'upload',
        loaded: 0,
        total: f.size,
        status: 'waiting',
        _source: 'input',
        _file: f.file,
      });
    }

    setTransfers(queue);

    for (const item of queue) {
      setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, status: 'transferring' } : t));
      try {
        let file;
        if (item._source === 'picker') {
          file = await item._entry.handle.getFile();
        } else {
          file = item._file;
        }
        await uploadFile(serverPath, file, (p) => {
          setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, loaded: p.loaded, total: p.total } : t));
        });
        setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, status: 'done', loaded: t.total } : t));
      } catch (err) {
        setTransfers(prev => prev.map(t => t.id === item.id ? { ...t, status: 'error', error: err.message } : t));
      }
    }

    loadServer();
    setLegacyFiles([]);
    setSelectedLocal({});
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

  // ═══════════════════════════════════════════════════════════
  // Render helpers
  // ═══════════════════════════════════════════════════════════

  const entryRowStyle = (selected) => ({
    padding: '6px 12px', cursor: 'pointer', fontSize: 13,
    display: 'flex', alignItems: 'center', gap: 6,
    background: selected ? 'var(--accent-light)' : 'transparent',
  });

  const hoverBg = (e, selected) => {
    if (!selected) e.currentTarget.style.background = 'var(--hover)';
  };
  const leaveBg = (e, selected) => {
    if (!selected) e.currentTarget.style.background = 'transparent';
  };

  // ═══════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)' }} />
      <div style={{
        position: 'relative', width: '85vw', maxWidth: 1100, height: '80vh', maxHeight: 750,
        background: 'var(--bg-secondary)', borderRadius: 12, display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)', border: '1px solid var(--border)',
      }}>
        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>📁 文件传输</h3>
          <button onClick={onClose} disabled={isTransferring}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 20, cursor: 'pointer', lineHeight: 1, opacity: isTransferring ? 0.3 : 1 }}
            title="关闭">✕</button>
        </div>

        {/* ── Tabs ── */}
        <div style={{ display: 'flex', padding: '0 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {[
            ['upload', '⬆ 上传（本地 → 服务器）'],
            ['download', '⬇ 下载（服务器 → 本地）'],
          ].map(([m, label]) => (
            <button key={m} onClick={() => { setMode(m); setMsg(''); }}
              style={{
                padding: '10px 24px', fontSize: 13, cursor: 'pointer', border: 'none', background: 'transparent',
                color: mode === m ? 'var(--accent)' : 'var(--text-muted)',
                borderBottom: mode === m ? '2px solid var(--accent)' : '2px solid transparent',
                fontWeight: mode === m ? 600 : 400,
              }}>{label}</button>
          ))}
        </div>

        {/* ── Body: two panels side by side ── */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
          {/* ══ LEFT: Server panel ══ */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, borderRight: '1px solid var(--border)' }}>
            <div style={{ padding: '8px 12px', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              💻 服务器目录
            </div>
            {/* Breadcrumb */}
            <div style={{ padding: '4px 12px', fontSize: 11, overflow: 'auto', whiteSpace: 'nowrap', flexShrink: 0 }}>
              <span onClick={() => setServerPath('/')} style={{ cursor: 'pointer', color: 'var(--accent)' }}>/</span>
              {serverBreadcrumb.map((seg, i) => (
                <span key={i}>
                  <span onClick={() => setServerPath('/' + serverBreadcrumb.slice(0, i + 1).join('/'))}
                    style={{ cursor: 'pointer', color: 'var(--accent)' }}>{seg}</span>
                  {i < serverBreadcrumb.length - 1 && <span style={{ color: 'var(--text-muted)' }}> / </span>}
                </span>
              ))}
            </div>
            {/* Listing */}
            <div style={{ flex: 1, overflow: 'auto' }}>
              {serverPath !== '/' && (
                <div onClick={goUpServer} style={{ padding: '6px 12px', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)' }}>
                  📁 <span>..</span>
                </div>
              )}
              {serverLoading ? (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 20 }}>加载中...</div>
              ) : (
                <>
                  {serverDirs.map(d => (
                    <div key={d.path} onClick={() => { setServerPath(d.path); if (mode === 'download') setSelectedServer({}); }}
                      style={entryRowStyle(false)}
                      onMouseEnter={e => hoverBg(e, false)} onMouseLeave={e => leaveBg(e, false)}>
                      📁 {d.name}
                    </div>
                  ))}
                  {mode === 'download' ? (
                    serverFiles.map(f => (
                      <div key={f.path} onClick={() => setSelectedServer(p => { const n = { ...p }; n[f.path] ? delete n[f.path] : n[f.path] = f; return n; })}
                        style={entryRowStyle(!!selectedServer[f.path])}
                        onMouseEnter={e => hoverBg(e, !!selectedServer[f.path])} onMouseLeave={e => leaveBg(e, !!selectedServer[f.path])}>
                        <input type="checkbox" checked={!!selectedServer[f.path]} readOnly style={{ margin: 0, flexShrink: 0 }} />
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
            <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
              {mode === 'upload' ? '上传目标：' + serverPath : '已选 ' + Object.keys(selectedServer).length + ' 个文件'}
            </div>
          </div>

          {/* ══ RIGHT: Local panel ══ */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ padding: '8px 12px', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>🖥 本地电脑</span>
              {dirStack.length > 0 && (
                <button onClick={closeLocalDir} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}>
                  关闭目录
                </button>
              )}
            </div>

            {mode === 'upload' ? (
              localRestoring ? (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>正在恢复上次的本地目录...</div>
                </div>
              ) : dirStack.length > 0 ? (
                /* ── Directory opened: show browser ── */
                <>
                  {/* Local breadcrumb */}
                  <div style={{ padding: '4px 12px', fontSize: 11, overflow: 'auto', whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {localBreadcrumb.map((seg, i) => (
                      <span key={i}>
                        <span style={{
                          color: i === localBreadcrumb.length - 1 ? 'var(--text-primary)' : 'var(--accent)',
                          cursor: i < localBreadcrumb.length - 1 ? 'pointer' : 'default',
                        }} onClick={i < localBreadcrumb.length - 1 ? async () => {
                          const targetStack = dirStack.slice(0, i + 1);
                          setDirStack(targetStack);
                          setSelectedLocal({});
                          await readDirEntries(targetStack[targetStack.length - 1]);
                        } : undefined}>
                          {seg.name}
                        </span>
                        {i < localBreadcrumb.length - 1 && <span style={{ color: 'var(--text-muted)' }}> / </span>}
                      </span>
                    ))}
                  </div>
                  {/* Local file listing */}
                  <div style={{ flex: 1, overflow: 'auto' }}>
                    {localLoading ? (
                      <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 20 }}>加载中...</div>
                    ) : (
                      <>
                        {dirStack.length > 1 && (
                          <div onClick={goUpLocal} style={{ padding: '6px 12px', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)' }}>
                            📁 <span>..</span>
                          </div>
                        )}
                        {localEntries.map(e => {
                          const key = e.name + '|' + e.kind;
                          const sel = !!selectedLocal[key];
                          return e.kind === 'directory' ? (
                            <div key={key} onClick={() => enterLocalDir(e)}
                              style={entryRowStyle(false)}
                              onMouseEnter={ev => hoverBg(ev, false)} onMouseLeave={ev => leaveBg(ev, false)}>
                              📁 {e.name}
                            </div>
                          ) : (
                            <div key={key} onClick={() => toggleLocalSelect(e)}
                              style={entryRowStyle(sel)}
                              onMouseEnter={ev => hoverBg(ev, sel)} onMouseLeave={ev => leaveBg(ev, sel)}>
                              <input type="checkbox" checked={sel} readOnly style={{ margin: 0, flexShrink: 0 }} />
                              📄 {e.name}
                            </div>
                          );
                        })}
                        {localEntries.length === 0 && (
                          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 20 }}>目录为空</div>
                        )}
                      </>
                    )}
                  </div>
                  {/* Local footer */}
                  <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>已选 {Object.keys(selectedLocal).length} 个文件</span>
                    {localEntries.some(e => e.kind === 'file') && (
                      <button onClick={selectAllLocal} style={{ background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11 }}>
                        {localEntries.filter(e => e.kind === 'file').every(f => selectedLocal[f.name + '|file']) ? '取消全选' : '全选文件'}
                      </button>
                    )}
                  </div>
                </>
              ) : (
                /* ── No directory opened yet ── */
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
                  {hasDirPicker ? (
                    <>
                      <button onClick={openLocalDir} style={{
                        padding: '14px 36px', fontSize: 15, borderRadius: 10, background: 'var(--accent)',
                        color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600, marginBottom: 12,
                      }}>
                        📂 选择本地文件夹
                      </button>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.6 }}>
                        点击后选择你 Windows 电脑上的文件夹<br />
                        即可浏览目录并选择文件上传
                      </div>
                    </>
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
                      当前浏览器不支持目录浏览<br />
                      请使用下方「选择文件」或「选择文件夹」按钮
                    </div>
                  )}
                </div>
              )
            ) : (
              /* ── Download mode: right panel is info-only ── */
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 40 }}>
                  请在左侧服务器目录中勾选要下载的文件<br />
                  文件将保存到浏览器下载目录
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Legacy file input row (upload mode) ── */}
        {mode === 'upload' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 20px', flexShrink: 0 }}>
              <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
              <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>或通过浏览器上传</span>
              <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            </div>
            <div style={{ padding: '4px 20px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <input type="file" ref={localInputRef} multiple onChange={handleLegacyFiles} style={{ display: 'none' }} />
              <input type="file" ref={folderInputRef} webkitdirectory="" directory="" onChange={handleLegacyFiles} style={{ display: 'none' }} />
              <button onClick={() => localInputRef.current?.click()}
                style={{ padding: '6px 14px', fontSize: 12, borderRadius: 4, background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer' }}>
                📄 选择文件
              </button>
              <button onClick={() => folderInputRef.current?.click()}
                style={{ padding: '6px 14px', fontSize: 12, borderRadius: 4, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-primary)', cursor: 'pointer' }}>
                📁 选择文件夹
              </button>
              {legacyFiles.length > 0 && (
                <>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{legacyFiles.length} 个文件</span>
                  <button onClick={() => setLegacyFiles([])}
                    style={{ padding: '4px 10px', fontSize: 11, borderRadius: 4, background: 'transparent', border: '1px solid var(--border)', color: 'var(--danger)', cursor: 'pointer' }}>清空</button>
                </>
              )}
            </div>
            {legacyFiles.length > 0 && (
              <div style={{ padding: '0 20px', maxHeight: 80, overflow: 'auto', flexShrink: 0 }}>
                {legacyFiles.map(f => (
                  <div key={f.id} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
                    📄 {f.name} ({formatBytes(f.size)})
                    <button onClick={() => removeLegacyFile(f.id)}
                      style={{ background: 'transparent', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: 12 }}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Progress ── */}
        {transfers.length > 0 && (
          <div style={{ padding: '8px 20px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
            {transfers.map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 12, minWidth: 40 }}>{t.direction === 'upload' ? '⬆' : '⬇'} {t.status === 'waiting' ? '等待' : t.status === 'transferring' ? '传输' : t.status === 'done' ? '完成' : '失败'}</span>
                <span style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 80, textAlign: 'right' }}>
                  {t.status === 'done' ? formatBytes(t.total) : t.status === 'error' ? t.error : `${formatBytes(t.loaded)} / ${formatBytes(t.total || t.loaded)}`}
                </span>
                <div style={{ width: 120, height: 6, background: 'var(--bg-primary)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    width: t.total > 0 ? `${Math.min(100, Math.round((t.loaded / t.total) * 100))}%` : (t.status === 'done' ? '100%' : '20%'),
                    height: '100%', background: t.status === 'error' ? 'var(--danger)' : t.status === 'done' ? '#4caf50' : 'var(--accent)',
                    transition: 'width 0.3s', borderRadius: 3,
                  }} />
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 36, textAlign: 'right' }}>
                  {t.total > 0 ? Math.min(100, Math.round((t.loaded / t.total) * 100)) + '%' : (t.status === 'done' ? '100%' : '')}
                </span>
              </div>
            ))}
          </div>
        )}

        {msg && (
          <div style={{ padding: '4px 20px', fontSize: 12, color: 'var(--danger)', flexShrink: 0 }}>{msg}</div>
        )}

        {/* ── Footer ── */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 20px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          {mode === 'upload' ? (
            <button onClick={runUpload} disabled={totalUpload === 0 || isTransferring}
              style={{ padding: '8px 24px', fontSize: 13, borderRadius: 6,
                background: totalUpload === 0 || isTransferring ? 'var(--border)' : 'var(--accent)', color: '#fff',
                border: 'none', cursor: totalUpload === 0 || isTransferring ? 'not-allowed' : 'pointer', fontWeight: 600 }}>
              开始上传 ({totalUpload} 个文件)
            </button>
          ) : (
            <button onClick={runDownload} disabled={Object.keys(selectedServer).length === 0 || isTransferring}
              style={{ padding: '8px 24px', fontSize: 13, borderRadius: 6,
                background: Object.keys(selectedServer).length === 0 || isTransferring ? 'var(--border)' : 'var(--accent)', color: '#fff',
                border: 'none', cursor: Object.keys(selectedServer).length === 0 || isTransferring ? 'not-allowed' : 'pointer', fontWeight: 600 }}>
              开始下载 ({Object.keys(selectedServer).length} 个文件)
            </button>
          )}
          <button onClick={onClose} disabled={isTransferring}
            style={{ padding: '8px 24px', fontSize: 13, borderRadius: 6, background: 'transparent',
              border: '1px solid var(--border)', color: isTransferring ? 'var(--text-muted)' : 'var(--text-primary)',
              cursor: isTransferring ? 'not-allowed' : 'pointer' }}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
