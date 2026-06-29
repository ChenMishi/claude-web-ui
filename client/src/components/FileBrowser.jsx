import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../context/AppContext';
import { getDirs, readFile, writeFile, deleteFileOrDir, renameFileOrDir, mkdir } from '../api';
import { IconFolder, IconEdit, IconFile, IconClipboard, IconAlert, IconDownload, IconTrash, IconPencil, IconUpload } from './icons';

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
  const [confirmDelete, setConfirmDelete] = useState(null); // { type, path, name }
  const [contextMenu, setContextMenu] = useState(null); // { x, y, path, name, isDir }
  const [renameTarget, setRenameTarget] = useState(null); // { path, name }
  const [renameValue, setRenameValue] = useState('');
  const [downloading, setDownloading] = useState(false); // { name } or false
  const [uploading, setUploading] = useState(false);
  const [showUploadMenu, setShowUploadMenu] = useState(false);
  const [confirmUpload, setConfirmUpload] = useState(null); // { entries, folderName }
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const uploadBtnRef = useRef(null);

  const supportsFSA = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

  // Recursively read files from a FileSystemDirectoryHandle
  const readFsaDir = async (dirHandle, basePath = '') => {
    const result = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'file') {
        const file = await handle.getFile();
        const relPath = basePath ? `${basePath}/${name}` : name;
        result.push({ file, relPath: `${dirHandle.name}/${relPath}` });
      } else if (handle.kind === 'directory') {
        const sub = await readFsaDir(handle, basePath ? `${basePath}/${name}` : name);
        result.push(...sub);
      }
    }
    return result;
  };

  const selectFolderViaFSA = async () => {
    try {
      const dirHandle = await window.showDirectoryPicker();
      const entries = await readFsaDir(dirHandle);
      if (entries.length === 0) return;
      // Show styled confirmation dialog instead of immediate upload
      setConfirmUpload({ entries, folderName: dirHandle.name });
    } catch (err) {
      if (err.name !== 'AbortError') setMsg('选择文件夹失败: ' + err.message);
    }
  };

  const handleConfirmUpload = () => {
    const info = confirmUpload;
    if (!info) return;
    setConfirmUpload(null);
    setUploading(true);
    setMsg('');
    startUploadQueue(info.entries, 0);
  };
  const editRef = useRef(null);
  const renameRef = useRef(null);
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
    fetch(`/api/fs/dirs?path=${encodeURIComponent(currentPath)}&all=1`, {
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
    fetch(`/api/fs/list?path=${encodeURIComponent(currentPath)}&all=1`, {
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
    setConfirmDelete(item);
  };

  const handleConfirmDelete = async () => {
    const item = confirmDelete;
    if (!item) return;
    setConfirmDelete(null);
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

  // Right-click context menu
  const handleContextMenu = (e, item) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, path: item.path, name: item.name, isDir: item.isDir });
  };

  const handleCopyPath = () => {
    if (!contextMenu) return;
    const path = contextMenu.path;
    let copied = false;
    // Try modern clipboard API first (requires secure context)
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(path).then(() => {
        setMsg('✅ 路径已复制: ' + path);
        setTimeout(() => setMsg(''), 2000);
      }).catch(() => {
        fallbackCopy(path);
      });
    } else {
      fallbackCopy(path);
    }
    setContextMenu(null);
  };

  const handleRenameStart = () => {
    if (!contextMenu) return;
    setRenameTarget({ path: contextMenu.path, name: contextMenu.name });
    setRenameValue(contextMenu.name);
    setContextMenu(null);
  };

  const handleRenameSubmit = async () => {
    const target = renameTarget;
    const newName = renameValue.trim();
    if (!target || !newName || newName === target.name) {
      setRenameTarget(null);
      return;
    }
    try {
      await renameFileOrDir(target.path, newName);
      setMsg('✅ 已重命名');
      setTimeout(() => setMsg(''), 2000);
      if (selectedFile?.path === target.path) {
        const newPath = target.path.replace(/[^/]+$/, newName);
        setSelectedFile({ ...selectedFile, path: newPath, name: newName });
      }
      loadFiles();
    } catch (err) {
      setMsg('❌ ' + (err.message || '重命名失败'));
    }
    setRenameTarget(null);
  };

  const handleDownload = (format) => {
    if (!contextMenu) return;
    const filePath = contextMenu.path;
    const url = `/api/fs/download?path=${encodeURIComponent(filePath)}${format ? '&format=' + format : ''}`;
    setContextMenu(null);
    setDownloading(contextMenu.name);
    fetch(url, {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('claude-ui:accessToken')}` }
    })
    .then(r => {
      if (!r.ok) throw new Error(r.statusText);
      return r.blob();
    })
    .then(blob => {
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      const ext = format === 'zip' ? '.zip' : (format === 'tar.gz' ? '.tar.gz' : '');
      a.download = contextMenu.name + ext;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
      setMsg('✅ 下载完成');
      setTimeout(() => setMsg(''), 2000);
      setDownloading(false);
    })
    .catch(err => {
      setMsg('❌ 下载失败: ' + err.message);
      setTimeout(() => setMsg(''), 3000);
      setDownloading(false);
    });
  };

  const handleUploadFiles = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const entries = files.map(f => ({ file: f, relPath: f.webkitRelativePath || f.name }));
    setUploading(true);
    setMsg('');
    startUploadQueue(entries, 0);
    e.target.value = '';
  };

  const startUploadQueue = async (entries, idx) => {
    if (idx >= entries.length) {
      setUploading(false);
      setMsg('✅ 上传完成 (' + entries.length + ' 个文件)');
      setTimeout(() => setMsg(''), 3000);
      loadFiles();
      return;
    }
    const { file, relPath } = entries[idx];
    setMsg(`⬆ 正在上传 (${idx + 1}/${entries.length}): ${relPath}`);
    try {
      await uploadSingleFile(currentPath, file, relPath);
    } catch (err) {
      setMsg(`❌ 上传失败 (${idx + 1}/${entries.length}): ${relPath} — ${err.message}`);
      setTimeout(() => setMsg(''), 3000);
      setUploading(false);
      return;
    }
    startUploadQueue(entries, idx + 1);
  };

  const uploadSingleFile = (dir, file, relPath) => {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append('dir', dir);
      formData.append('file', file);
      formData.append('relPath', relPath);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/fs/upload');
      xhr.setRequestHeader('Authorization', `Bearer ${localStorage.getItem('claude-ui:accessToken')}`);
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
  const fallbackCopy = (text) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      setMsg('✅ 路径已复制: ' + text);
    } catch {
      setMsg('❌ 复制失败');
    }
    document.body.removeChild(ta);
    setTimeout(() => setMsg(''), 2000);
  };

  // Close context menu on any click outside
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [contextMenu]);

  // Close upload menu on click outside
  useEffect(() => {
    if (!showUploadMenu) return;
    const close = (e) => {
      if (uploadBtnRef.current && !uploadBtnRef.current.contains(e.target)) {
        setShowUploadMenu(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [showUploadMenu]);

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
          <span className="file-tree-title"><IconFolder/> 文件浏览</span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 8, fontWeight: 400 }}>右键点击可复制路径</span>
        </div>
        <div className="file-tree-toggle" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 4 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={() => setShowNewDir(true)} title="新建目录">📁 新建目录</button>
            <button onClick={() => setShowNewFile(true)} title="新建文件">📄 新建文件</button>
            <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleUploadFiles} />
            <input ref={folderInputRef} type="file" webkitdirectory="" directory="" style={{ display: 'none' }} onChange={handleUploadFiles} />
            <button ref={uploadBtnRef} onClick={() => setShowUploadMenu(v => !v)} title="上传" style={{ position: 'relative' }}>📤 上传{showUploadMenu && (
                <div className="context-menu" style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 100, minWidth: 140 }} onClick={e => e.stopPropagation()}>
                  <div className="context-menu-item" onClick={() => { setShowUploadMenu(false); fileInputRef.current?.click(); }}>
                    📄 上传文件
                  </div>
                  <div className="context-menu-item" onClick={() => { setShowUploadMenu(false); if (supportsFSA) selectFolderViaFSA(); else folderInputRef.current?.click(); }}>
                    📁 上传文件夹
                  </div>
                </div>
              )}</button>
            <button onClick={() => loadFiles()} title="刷新文件列表">🔄 刷新</button>
          </div>
        </div>

        {/* Breadcrumb */}
        <div className="dialog-breadcrumb" style={{ padding: '4px 8px', fontSize: 12, display: 'flex', alignItems: 'center' }}>
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

        {(downloading || uploading) && (
          <div style={{ padding: '6px 8px', fontSize: 11, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="spinner" style={{ width: 12, height: 12, border: '2px solid var(--border)', borderTop: '2px solid var(--accent)', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.8s linear infinite' }}></span>
            {downloading ? `正在打包下载: ${downloading}...` : (msg || '正在上传...')}
          </div>
        )}
        {!downloading && !uploading && msg && (
          <div style={{ padding: '4px 8px', fontSize: 11, color: msg.includes('✅') ? 'var(--success)' : 'var(--danger)' }}>{msg}</div>
        )}

        {/* Directory listing */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {currentPath !== '/' && (
            <div className="file-tree-item dir" onClick={goUp} onContextMenu={(e) => handleContextMenu(e, { path: currentPath.split('/').slice(0, -1).join('/') || '/', name: '..', isDir: true })} style={{ paddingLeft: 8 }}>
              <IconFolder/> <span style={{ color: 'var(--text-muted)' }}>..</span>
            </div>
          )}
          {dirs.map(d => (
            <div key={d.path} style={{ display: 'flex', alignItems: 'center' }}>
              <div className="file-tree-item dir" onClick={() => handleFileClick({ type: 'dir', path: d.path, name: d.name })}
                onContextMenu={(e) => handleContextMenu(e, { path: d.path, name: d.name, isDir: true })}
                style={{ flex: 1, paddingLeft: 8 }}>
                <IconFolder/> {d.name}
              </div>
              <button onClick={(e) => { e.stopPropagation(); handleDelete({ type: 'dir', path: d.path, name: d.name }); }}
                style={{ padding: '2px 6px', fontSize: 10, background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button>
            </div>
          ))}
          {files.map(f => (
            <div key={f.path} style={{ display: 'flex', alignItems: 'center' }}>
              <div className={`file-tree-item ${selectedFile?.path === f.path ? 'dir' : ''}`}
                onClick={() => handleFileClick({ type: 'file', path: f.path, name: f.name })}
                onContextMenu={(e) => handleContextMenu(e, { path: f.path, name: f.name, isDir: false })}
                style={{ flex: 1, paddingLeft: 8 }}>
                {selectedFile?.path === f.path ? <IconEdit/> : <IconFile/>} {f.name}
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

      {/* Right-click context menu */}
      {contextMenu && (
        <div className="context-menu" style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 9999 }}
          onClick={e => e.stopPropagation()}>
          <div className="context-menu-item" onClick={handleCopyPath}>
            <IconClipboard/> 复制绝对路径
          </div>
          <div className="context-menu-item" onClick={handleRenameStart}>
            <IconPencil/> 重命名
          </div>
          {contextMenu.isDir ? (
            <>
              <div className="context-menu-item" onClick={() => handleDownload('zip')}>
                <IconDownload/> 打包下载 (.zip)
              </div>
              <div className="context-menu-item" onClick={() => handleDownload('tar.gz')}>
                <IconDownload/> 打包下载 (.tar.gz)
              </div>
            </>
          ) : (
            <div className="context-menu-item" onClick={() => handleDownload()}>
              <IconDownload/> 下载
            </div>
          )}
          <div className="context-menu-sep"></div>
          <div className="context-menu-item context-menu-item-danger" onClick={() => { handleDelete({ type: contextMenu.isDir ? 'dir' : 'file', path: contextMenu.path, name: contextMenu.name }); setContextMenu(null); }}>
            <IconTrash/> 删除
          </div>
          <div className="context-menu-path" style={{ fontSize: 10, color: 'var(--text-muted)', padding: '4px 12px 6px', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {contextMenu.path}
          </div>
        </div>
      )}

      {/* Rename inline input */}
      {renameTarget && createPortal(
        <div className="confirm-backdrop" onClick={() => setRenameTarget(null)}>
          <div className="confirm-dialog" onClick={e => e.stopPropagation()} style={{ minWidth: 360 }}>
            <div className="confirm-dialog-icon"><IconPencil/></div>
            <div className="confirm-dialog-title">重命名</div>
            <div className="confirm-dialog-name" style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>{renameTarget.path}</div>
            <input
              ref={renameRef}
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleRenameSubmit(); if (e.key === 'Escape') setRenameTarget(null); }}
              style={{ width: '100%', padding: '8px 12px', fontSize: 14, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box' }}
              autoFocus
            />
            <div className="confirm-dialog-actions" style={{ marginTop: 16 }}>
              <button className="cancel-btn" onClick={() => setRenameTarget(null)}>取消</button>
              <button className="danger-btn" style={{ background: 'var(--accent)' }} onClick={handleRenameSubmit}>确认</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Delete confirmation dialog — rendered via Portal to avoid backdrop-filter stacking context */}
      {confirmDelete && createPortal(
        <div className="confirm-backdrop" onClick={() => setConfirmDelete(null)}>
          <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
            <div className="confirm-dialog-icon"><IconAlert/></div>
            <div className="confirm-dialog-title">确认删除</div>
            <div className="confirm-dialog-name">{confirmDelete.name}</div>
            <div className="confirm-dialog-warn">此操作不可撤销，确定要删除吗？</div>
            <div className="confirm-dialog-actions">
              <button className="cancel-btn" onClick={() => setConfirmDelete(null)}>取消</button>
              <button className="danger-btn" onClick={handleConfirmDelete}>确认删除</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Upload confirmation dialog */}
      {confirmUpload && createPortal(
        <div className="confirm-backdrop" onClick={() => setConfirmUpload(null)}>
          <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
            <div className="confirm-dialog-icon"><IconUpload/></div>
            <div className="confirm-dialog-title">确认上传</div>
            <div className="confirm-dialog-name">{confirmUpload.folderName}</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>包含 {confirmUpload.entries.length} 个文件</div>
            <div className="confirm-dialog-warn">上传至: {currentPath}</div>
            <div className="confirm-dialog-actions">
              <button className="cancel-btn" onClick={() => setConfirmUpload(null)}>取消</button>
              <button className="danger-btn" style={{ background: 'var(--accent)' }} onClick={handleConfirmUpload}>确认上传</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
