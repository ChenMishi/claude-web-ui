import { useState, useEffect, useRef, useCallback } from 'react';
import { getBackupList, createBackup, deleteBackup, getBackupConfig, saveBackupConfig, restoreBackup, getBackupDownloadUrl } from '../api';
import { listDir, mkdir } from '../api';
import { IconFolder, IconNewFolder, IconSave, IconPlus, IconDownload, IconZap, IconAlert } from './icons';

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function DirPicker({ value, onSelect, onClose }) {
  const [cwd, setCwd] = useState(value || '/');
  const [dirs, setDirs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [newDirName, setNewDirName] = useState('');
  const [createMsg, setCreateMsg] = useState('');

  const loadDir = useCallback(async (p) => {
    setLoading(true); setError('');
    try {
      const data = await listDir(p);
      setCwd(data.path);
      setDirs(data.dirs || []);
      if (data.path !== '/') {
        const parent = data.path.split('/').slice(0, -1).join('/') || '/';
        setDirs(prev => [{ name: '..', path: parent, isParent: true }, ...prev]);
      }
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadDir(cwd); }, [cwd, loadDir]);

  const handleCreateDir = async () => {
    if (!newDirName.trim()) return;
    setCreateMsg('');
    try {
      await mkdir(cwd, newDirName.trim());
      setNewDirName('');
      setCreating(false);
      loadDir(cwd);
    } catch (err) {
      setCreateMsg(`创建失败: ${err.message}`);
      setTimeout(() => setCreateMsg(''), 3000);
    }
  };

  return (
    <div className="dir-picker-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dir-picker-modal">
        <div className="dir-picker-header">
          <span><IconFolder/> 选择备份目录</span>
          <button className="profile-close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="dir-picker-path">
          <span className="dir-picker-path-label">当前路径:</span>
          <span className="dir-picker-path-value">{cwd}</span>
        </div>
        <div className="dir-picker-list">
          {loading ? (
            <div className="dir-picker-loading">加载中...</div>
          ) : error ? (
            <div className="dir-picker-error">{error}</div>
          ) : dirs.length === 0 ? (
            <div className="dir-picker-empty">此目录为空</div>
          ) : (
            dirs.map(d => (
              <div
                key={d.path}
                className={`dir-picker-item ${d.isParent ? 'dir-picker-parent' : ''}`}
                onClick={() => setCwd(d.path)}
              >
                <span className="dir-picker-icon">{d.isParent ? <><IconNewFolder/> ..</> : <IconFolder/>}</span>
                <span className="dir-picker-name">{d.name}</span>
              </div>
            ))
          )}
        </div>
        {createMsg && <div className="dir-picker-create-msg">{createMsg}</div>}
        {creating && (
          <div className="dir-picker-create-row">
            <input
              type="text" placeholder="新目录名称" autoFocus
              value={newDirName}
              onChange={e => setNewDirName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreateDir(); if (e.key === 'Escape') { setCreating(false); setNewDirName(''); } }}
              className="dir-picker-create-input"
            />
            <button className="init-btn init-btn-save" onClick={handleCreateDir}>创建</button>
            <button className="init-btn" onClick={() => { setCreating(false); setNewDirName(''); }}>取消</button>
          </div>
        )}
        <div className="dir-picker-actions">
          <button className="init-btn" onClick={() => setCreating(v => !v)}><IconNewFolder/> 新建目录</button>
          <div className="dir-picker-actions-right">
            <button className="init-btn" onClick={onClose}>取消</button>
            <button className="init-btn init-btn-save" onClick={() => { onSelect(cwd); onClose(); }}>选择此目录</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function BackupCard() {
  const [backups, setBackups] = useState([]);
  const [backupPath, setBackupPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [config, setConfig] = useState({ path: '', frequency: 'manual', maxBackups: 3 });
  const [saveMsg, setSaveMsg] = useState('');
  const [restoreMsg, setRestoreMsg] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [confirmFile, setConfirmFile] = useState(null);
  const [restoreProgress, setRestoreProgress] = useState('');
  const fileInputRef = useRef(null);

  const loadData = async () => {
    try {
      const [listData, cfgData] = await Promise.all([getBackupList(), getBackupConfig()]);
      setBackups(listData.backups || []);
      setBackupPath(listData.path || '');
      setConfig(cfgData);
    } catch {}
  };

  useEffect(() => { loadData(); }, []);

  const handleCreate = async () => {
    setMsg('');
    setLoading(true);
    try {
      const result = await createBackup();
      setMsg(`✅ 备份已创建: ${result.name} (${formatSize(result.size)})`);
      loadData();
    } catch (err) {
      setMsg(`❌ 创建失败: ${err.message}`);
    }
    setLoading(false);
    setTimeout(() => setMsg(''), 5000);
  };

  const handleDelete = async (name) => {
    if (!confirm(`确定删除备份 ${name}？`)) return;
    try {
      await deleteBackup(name);
      loadData();
    } catch (err) {
      setMsg(`❌ 删除失败: ${err.message}`);
      setTimeout(() => setMsg(''), 3000);
    }
  };

  const handleDownload = (name) => {
    const url = getBackupDownloadUrl(name);
    const headers = {};
    const token = localStorage.getItem('claude-ui:accessToken');
    if (token) headers['Authorization'] = `Bearer ${token}`;
    fetch(url, { headers })
      .then(res => {
        if (!res.ok) throw new Error('下载失败');
        return res.blob();
      })
      .then(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
      })
      .catch(err => {
        setMsg(`❌ 下载失败: ${err.message}`);
        setTimeout(() => setMsg(''), 3000);
      });
  };

  const handleConfigSave = async () => {
    setSaveMsg('');
    try {
      await saveBackupConfig(config);
      setSaveMsg('✅ 配置已保存');
      loadData();
      setTimeout(() => setSaveMsg(''), 3000);
    } catch (err) {
      setSaveMsg(`❌ 保存失败: ${err.message}`);
    }
  };

  const handleRestore = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setConfirmFile(file);
    e.target.value = '';
  };

  const handleConfirmRestore = async () => {
    const file = confirmFile;
    if (!file) return;
    setConfirmFile(null);
    setRestoreMsg('');
    setRestoring(true);
    setRestoreProgress('正在上传并解压备份文件...');
    try {
      const result = await restoreBackup(file);
      setRestoreProgress('');
      setRestoreMsg(`✅ ${result.message || '备份已还原'}`);
    } catch (err) {
      setRestoreProgress('');
      setRestoreMsg(`❌ 还原失败: ${err.message}`);
    }
    setRestoring(false);
    setTimeout(() => setRestoreMsg(''), 8000);
  };

  const cancelRestore = () => {
    setConfirmFile(null);
  };

  return (
    <div className="settings-card">
      <div className="settings-card-header"><IconSave/> 备份 & 还原</div>
      <div className="settings-card-body">
        {/* Config row */}
        <div className="settings-row">
          <label>备份目录</label>
          <div className="backup-path-row">
            <input type="text" value={config.path || ''} onChange={e => setConfig({ ...config, path: e.target.value })}
              placeholder={backupPath || '默认: ~/.claude-web-ui/backups'} className="backup-path-input" />
            <button className="init-btn" onClick={() => setShowPicker(true)}><IconNewFolder/> 选择</button>
          </div>
        </div>
        {showPicker && (
          <DirPicker
            value={config.path || backupPath || '/'}
            onSelect={(p) => setConfig({ ...config, path: p })}
            onClose={() => setShowPicker(false)}
          />
        )}
        <div style={{ display: 'flex', gap: 16 }}>
          <div className="settings-row" style={{ flex: 1 }}>
            <label>自动备份</label>
            <select value={config.frequency || 'manual'} onChange={e => setConfig({ ...config, frequency: e.target.value })}>
              <option value="manual">手动</option>
              <option value="hourly">每小时</option>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
            </select>
          </div>
          <div className="settings-row" style={{ flex: 1 }}>
            <label>最大备份数</label>
            <input type="number" min="1" max="100" value={config.maxBackups || 3}
              onChange={e => setConfig({ ...config, maxBackups: parseInt(e.target.value) || 3 })} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="init-btn init-btn-save" onClick={handleConfigSave}>保存配置</button>
          {saveMsg && (
            <span className="backup-msg" style={{ color: saveMsg.includes('✅') ? 'var(--success)' : 'var(--danger)' }}>{saveMsg}</span>
          )}
        </div>

        {/* Divider */}
        <div className="backup-divider" />

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="init-btn init-btn-save" onClick={handleCreate} disabled={loading}>
            {loading ? '创建中...' : <><IconPlus/> 创建备份</>}
          </button>
          <button className="init-btn" onClick={() => fileInputRef.current?.click()} disabled={restoring}
            style={{ background: 'var(--accent-light)', color: 'var(--accent)', border: '1px solid var(--accent)' }}>
            {restoring ? '还原中...' : <><IconDownload/> 还原备份</>}
          </button>
          <input ref={fileInputRef} type="file" accept=".tar.gz" style={{ display: 'none' }} onChange={handleRestore} />
          {msg && (
            <span className="backup-msg" style={{ color: msg.includes('✅') ? 'var(--success)' : 'var(--danger)' }}>{msg}</span>
          )}
        </div>
        {restoreMsg && (
          <div style={{
            marginTop: 8, padding: '8px 12px', borderRadius: 6, fontSize: 12,
            color: restoreMsg.includes('✅') ? 'var(--success)' : 'var(--danger)',
            background: restoreMsg.includes('✅') ? 'rgba(76,175,80,0.1)' : 'var(--danger-bg)',
          }}>{restoreMsg}</div>
        )}

        {/* Backup list */}
        {backups.length > 0 && (
          <table className="settings-table" style={{ marginTop: 16 }}>
            <thead>
              <tr>
                <th>文件名</th>
                <th>大小</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {backups.map(b => (
                <tr key={b.name}>
                  <td className="backup-name-cell" title={b.name}>{b.name}</td>
                  <td>{formatSize(b.size)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="user-mgmt-del-btn" onClick={() => handleDownload(b.name)}
                        style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>下载</button>
                      <button className="user-mgmt-del-btn" onClick={() => handleDelete(b.name)}>删除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="backup-hint">
          <IconZap/> 备份包含：Provider 配置、初始化配置、定价配置、用户数据、统计、Skills、会话数据。还原后需重启服务生效。
        </div>
      </div>

      {/* Confirmation dialog */}
      {confirmFile && (
        <div className="restore-confirm-backdrop" onClick={cancelRestore}>
          <div className="restore-confirm-modal" onClick={e => e.stopPropagation()}>
            <div className="restore-confirm-icon"><IconAlert/></div>
            <h3 className="restore-confirm-title">确认还原备份</h3>
            <p className="restore-confirm-name">{confirmFile.name} ({formatSize(confirmFile.size)})</p>
            <p className="restore-confirm-warn">
              还原将<strong>覆盖当前所有配置</strong>，包括 Provider 设置、定价、用户账号和密码、JWT 密钥等。
            </p>
            <p className="restore-confirm-hint">还原完成后需要重启服务才能生效。</p>
            <div className="restore-confirm-actions">
              <button className="init-btn" onClick={cancelRestore}>取消</button>
              <button className="init-btn" onClick={handleConfirmRestore}
                style={{ background: 'var(--danger)', color: '#fff', border: 'none' }}>
                确认还原
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Progress overlay */}
      {restoring && (
        <div className="restore-confirm-backdrop">
          <div className="restore-progress-modal">
            <div className="restore-progress-spinner" />
            <p className="restore-progress-title">正在还原备份...</p>
            <p className="restore-progress-hint">{restoreProgress}</p>
          </div>
        </div>
      )}
    </div>
  );
}
