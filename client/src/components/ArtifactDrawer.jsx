import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../context/AppContext';
import { getSessionArtifacts, deleteSessionArtifacts, getArtifactDownloadUrl, authHeaders } from '../api';
import { IconPackage, IconFile, IconDownload, IconTrash, IconX, IconAlert } from './icons';

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatTime(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ArtifactDrawer({ open, onClose, cwd }) {
  const { currentSessionId } = useApp();
  const drawerRef = useRef(null);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState({});
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null); // { count } or null
  const [closing, setClosing] = useState(false);
  const closingByDoClose = useRef(false);

  // Wrap onClose with closing animation (for X button, click-outside)
  const doClose = useCallback(() => {
    closingByDoClose.current = true;
    setClosing(true);
    setTimeout(() => {
      setClosing(false);
      onClose();
    }, 150);
  }, [onClose]);

  const loadFiles = useCallback(async () => {
    if (!currentSessionId) return;
    setLoading(true);
    setError('');
    try {
      const data = await getSessionArtifacts(currentSessionId, cwd);
      setFiles(data.files || []);
      setSelected({});
    } catch (e) {
      setError('加载失败: ' + e.message);
    }
    setLoading(false);
  }, [currentSessionId, cwd]);

  // Track open transitions for external close animation
  const wasOpenRef = useRef(false);
  const skipCloseAnimRef = useRef(false);

  // Catch external close (trigger button toggle) and play closing animation
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (wasOpen && !open && !closingByDoClose.current && !skipCloseAnimRef.current) {
      setClosing(true);
      const timer = setTimeout(() => setClosing(false), 150);
      return () => clearTimeout(timer);
    }
    skipCloseAnimRef.current = false;
    if (open) {
      setClosing(false);
      closingByDoClose.current = false;
    }
  }, [open]);

  // Reload when opened or session changes
  useEffect(() => {
    if (open && currentSessionId) loadFiles();
  }, [open, currentSessionId, loadFiles]);

  // Close on session change (immediate, no animation)
  useEffect(() => {
    if (!currentSessionId) {
      setFiles([]);
      setSelected({});
      skipCloseAnimRef.current = true;
      onClose();
    }
  }, [currentSessionId, onClose]);

  // Click outside to close (but not on the trigger button)
  useEffect(() => {
    if (!open || closing) return;
    const handleClick = (e) => {
      if (e.target.closest('.artifact-trigger-btn')) return;
      if (drawerRef.current && !drawerRef.current.contains(e.target)) {
        doClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, closing, doClose]);

  const toggleSelect = (name) => {
    setSelected(prev => {
      const next = { ...prev };
      if (next[name]) delete next[name];
      else next[name] = true;
      return next;
    });
  };

  const toggleAll = () => {
    const allSelected = files.every(f => selected[f.name]);
    if (allSelected) {
      setSelected({});
    } else {
      const next = {};
      files.forEach(f => { next[f.name] = true; });
      setSelected(next);
    }
  };

  const selList = Object.keys(selected);
  const selCount = selList.length;

  const handleDownload = async () => {
    if (selCount === 0) return;
    for (const name of selList) {
      try {
        const url = getArtifactDownloadUrl(currentSessionId, name, cwd);
        const res = await fetch(url, { headers: authHeaders() });
        if (!res.ok) throw new Error(res.statusText);
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      } catch (e) {
        console.error('下载失败:', name, e);
      }
    }
  };

  const handleDelete = () => {
    if (selCount === 0) return;
    setConfirmDelete({ count: selCount });
  };

  const handleConfirmDelete = async () => {
    const count = confirmDelete?.count || selCount;
    setConfirmDelete(null);
    setDeleting(true);
    try {
      await deleteSessionArtifacts(currentSessionId, selList, cwd);
      await loadFiles();
    } catch (e) {
      setError('删除失败: ' + e.message);
    }
    setDeleting(false);
  };

  if (!open && !closing) return null;

  return (
    <>
    <div className={`artifact-drawer${closing ? ' closing' : ''}`} ref={drawerRef}>
      <div className="artifact-drawer-header">
        <span className="artifact-drawer-title">
          <IconPackage /> 产物文件 {files.length > 0 && <span className="artifact-count">({files.length})</span>}
        </span>
        <button className="artifact-drawer-close" onClick={doClose} title="关闭">
          <IconX />
        </button>
      </div>

      <div className="artifact-drawer-body">
        {loading && <div className="artifact-drawer-message">加载中...</div>}
        {error && <div className="artifact-drawer-message artifact-drawer-error">{error}</div>}

        {!loading && !error && files.length === 0 && (
          <div className="artifact-drawer-empty">
            <IconPackage />
            <span>暂无产物文件</span>
          </div>
        )}

        {!loading && files.length > 0 && (
          <div className="artifact-file-list">
            {files.map(f => (
              <label
                key={f.name}
                className={`artifact-file-row${selected[f.name] ? ' selected' : ''}`}
              >
                <input
                  type="checkbox"
                  className="artifact-checkbox"
                  checked={!!selected[f.name]}
                  onChange={() => toggleSelect(f.name)}
                />
                <IconFile />
                <span className="artifact-file-name" title={f.name}>{f.name}</span>
                <span className="artifact-file-size">{formatSize(f.size)}</span>
                <span className="artifact-file-time">{formatTime(f.mtime)}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {files.length > 0 && (
        <div className="artifact-drawer-actions">
          <label className="artifact-action-select-all">
            <input type="checkbox" checked={selCount === files.length} onChange={toggleAll} />
            <span>全选</span>
          </label>
          <div className="artifact-action-btns">
            <button
              className="artifact-btn artifact-btn-download"
              disabled={selCount === 0}
              onClick={handleDownload}
              title="下载选中文件"
            >
              <IconDownload /> 下载 ({selCount})
            </button>
            <button
              className="artifact-btn artifact-btn-delete"
              disabled={selCount === 0 || deleting}
              onClick={handleDelete}
              title="删除选中文件"
            >
              <IconTrash /> 删除 ({selCount})
            </button>
          </div>
        </div>
      )}
    </div>
      {/* Delete confirmation dialog */}
      {confirmDelete && createPortal(
        <div className="confirm-backdrop" onClick={() => setConfirmDelete(null)}>
          <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
            <div className="confirm-dialog-icon"><IconAlert /></div>
            <div className="confirm-dialog-title">确认删除</div>
            <div className="confirm-dialog-name">{confirmDelete.count} 个文件</div>
            <div className="confirm-dialog-warn">此操作不可撤销，确定要删除吗？</div>
            <div className="confirm-dialog-actions">
              <button className="cancel-btn" onClick={() => setConfirmDelete(null)}>取消</button>
              <button className="danger-btn" onClick={handleConfirmDelete}>确认删除</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
