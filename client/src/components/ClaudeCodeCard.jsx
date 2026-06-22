import { useState, useEffect, useCallback } from 'react';
import { authHeaders, getInitStatus, checkClaudeUpdate } from '../api';
import { IconBot } from './icons';

const BASE = '/api';

export default function ClaudeCodeCard() {
  const [status, setStatus] = useState(null);       // { claudeInstalled, claudeVersion, claudePath }
  const [installing, setInstalling] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [installPct, setInstallPct] = useState(0);
  const [installLog, setInstallLog] = useState('');
  const [upgradeLog, setUpgradeLog] = useState('');
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);

  const loadStatus = useCallback(() => {
    getInitStatus().then(d => setStatus(d)).catch(() => {});
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleInstall = useCallback(async () => {
    setInstalling(true); setInstallLog(''); setInstallPct(0);
    try {
      const res = await fetch(`${BASE}/init/install-claude`, {
        method: 'POST', headers: authHeaders({ Accept: 'text/event-stream' }),
      });
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        if (value) {
          buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try { const d = JSON.parse(line.slice(6)); if (d.pct !== undefined) setInstallPct(d.pct); if (d.text) setInstallLog(prev => prev + d.text); } catch {}
            }
          }
        }
      }
    } catch {}
    setInstalling(false);
    setTimeout(() => loadStatus(), 1000);
  }, [loadStatus]);

  const handleCheckUpdate = useCallback(async () => {
    setCheckingUpdate(true); setUpdateInfo(null);
    try { const res = await checkClaudeUpdate(); setUpdateInfo(res); } catch {}
    setCheckingUpdate(false);
  }, []);

  const handleUpgrade = useCallback(async () => {
    setUpgrading(true); setUpgradeLog('');
    try {
      const res = await fetch(`${BASE}/init/upgrade-claude`, {
        method: 'POST', headers: authHeaders({ Accept: 'text/event-stream' }),
      });
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        if (value) {
          buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try { const d = JSON.parse(line.slice(6)); if (d.text) setUpgradeLog(prev => prev + d.text); } catch {}
            }
          }
        }
      }
    } catch {}
    setUpgrading(false);
    setTimeout(() => loadStatus(), 1000);
  }, [loadStatus]);

  if (!status) return null;

  return (
    <div className="settings-card">
      <div className="settings-card-header"><IconBot/> Claude Code</div>
      <div className="settings-card-body">
        <div className="settings-info-row">
          <span className="settings-info-label">状态</span>
          <span className="settings-info-value" style={{ color: status.claudeInstalled ? 'var(--success)' : 'var(--danger)' }}>
            {status.claudeInstalled ? `已安装 (${status.claudeVersion || 'v?'})` : '未安装'}
          </span>
        </div>
        {status.claudeInstalled && (
          <div className="settings-info-row">
            <span className="settings-info-label">路径</span>
            <span className="settings-info-value mono" style={{ fontSize: 11 }}>{status.claudePath || '—'}</span>
          </div>
        )}

        {!status.claudeInstalled ? (
          <div style={{ marginTop: 12 }}>
            <button className="init-btn init-btn-install" onClick={handleInstall} disabled={installing}
              style={{ width: '100%', padding: '8px 0', borderRadius: 8, fontSize: 13 }}>
              {installing ? `安装中 ${installPct}%...` : '安装 Claude Code'}
            </button>
            {installing && installPct > 0 && (
              <div style={{ height: 6, background: 'var(--bg-primary)', borderRadius: 3, overflow: 'hidden', marginTop: 8 }}>
                <div style={{ height: '100%', width: `${installPct}%`, background: 'linear-gradient(90deg, var(--accent), #82b1ff)', borderRadius: 3, transition: 'width 0.3s' }} />
              </div>
            )}
            {installLog && <div className="init-install-log"><div className="init-install-scroll"><pre>{installLog}</pre></div></div>}
          </div>
        ) : (
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="init-btn init-btn-test" onClick={handleCheckUpdate} disabled={checkingUpdate}
              style={{ padding: '6px 14px', fontSize: 12, borderRadius: 6 }}>
              {checkingUpdate ? '检查中...' : '检查更新'}
            </button>
            {updateInfo && updateInfo.hasUpdate && (
              <button className="init-btn init-btn-install" onClick={handleUpgrade} disabled={upgrading}
                style={{ padding: '6px 14px', fontSize: 12, borderRadius: 6 }}>
                {upgrading ? '升级中...' : `升级到 v${updateInfo.latest}`}
              </button>
            )}
            {updateInfo && !updateInfo.hasUpdate && updateInfo.current && (
              <span style={{ fontSize: 12, color: 'var(--success)' }}>✅ 已是最新 v{updateInfo.current}</span>
            )}
          </div>
        )}
        {upgradeLog && <div className="init-install-log" style={{ marginTop: 8 }}><div className="init-install-scroll"><pre>{upgradeLog}</pre></div></div>}
      </div>
    </div>
  );
}
