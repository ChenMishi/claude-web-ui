import { useState, useEffect, useRef } from 'react';
import { getBackupList, createBackup, deleteBackup, getBackupConfig, saveBackupConfig, restoreBackup, getBackupDownloadUrl } from '../api';

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
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
    // Use fetch to get blob with auth headers, then trigger download
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
      setTimeout(() => setSaveMsg(''), 3000);
    } catch (err) {
      setSaveMsg(`❌ 保存失败: ${err.message}`);
    }
  };

  const handleRestore = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setRestoreMsg('');
    setRestoring(true);
    try {
      const result = await restoreBackup(file);
      setRestoreMsg(`✅ ${result.message || '备份已还原'}`);
    } catch (err) {
      setRestoreMsg(`❌ 还原失败: ${err.message}`);
    }
    setRestoring(false);
    e.target.value = '';
    setTimeout(() => setRestoreMsg(''), 8000);
  };

  return (
    <div className="backup-card">
      <div className="settings-card">
        <div className="settings-card-header">💾 备份配置</div>
        <div className="settings-card-body">
          <div className="settings-row">
            <label>备份目录</label>
            <input type="text" value={config.path || ''} onChange={e => setConfig({ ...config, path: e.target.value })}
              placeholder={backupPath || '默认: ~/.claude-web-ui/backups'} />
          </div>
          <div className="settings-row">
            <label>自动备份</label>
            <select value={config.frequency || 'manual'} onChange={e => setConfig({ ...config, frequency: e.target.value })}>
              <option value="manual">手动</option>
              <option value="hourly">每小时</option>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
            </select>
          </div>
          <div className="settings-row">
            <label>最大备份数</label>
            <input type="number" min="1" max="100" value={config.maxBackups || 3}
              onChange={e => setConfig({ ...config, maxBackups: parseInt(e.target.value) || 3 })} />
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="init-btn init-btn-save" onClick={handleConfigSave}>保存配置</button>
            {saveMsg && (
              <span className="backup-msg" style={{ color: saveMsg.includes('✅') ? 'var(--success)' : 'var(--danger)' }}>{saveMsg}</span>
            )}
          </div>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-header">📦 备份管理</div>
        <div className="settings-card-body">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
            <button className="init-btn init-btn-save" onClick={handleCreate} disabled={loading}>
              {loading ? '创建中...' : '➕ 创建备份'}
            </button>
            <button className="init-btn" onClick={() => fileInputRef.current?.click()} disabled={restoring} style={{ background: 'var(--accent-light)', color: 'var(--accent)', border: '1px solid var(--accent)' }}>
              {restoring ? '还原中...' : '📥 还原备份'}
            </button>
            <input ref={fileInputRef} type="file" accept=".tar.gz" style={{ display: 'none' }} onChange={handleRestore} />
            {msg && (
              <span className="backup-msg" style={{ color: msg.includes('✅') ? 'var(--success)' : 'var(--danger)' }}>{msg}</span>
            )}
          </div>
          {restoreMsg && (
            <div className="backup-msg" style={{
              marginBottom: 12, padding: '8px 12px', borderRadius: 6, fontSize: 12,
              color: restoreMsg.includes('✅') ? 'var(--success)' : 'var(--danger)',
              background: restoreMsg.includes('✅') ? 'rgba(76,175,80,0.1)' : 'var(--danger-bg)',
            }}>{restoreMsg}</div>
          )}

          {backups.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '16px 0', textAlign: 'center' }}>
              暂无备份文件，点击「创建备份」生成第一个备份
            </div>
          ) : (
            <table className="settings-table">
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
            💡 备份包含：Provider 配置、初始化配置、定价配置、用户数据、统计、Skills、会话数据。还原后需重启服务生效。
          </div>
        </div>
      </div>
    </div>
  );
}
