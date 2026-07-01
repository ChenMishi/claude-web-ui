import { useState, useEffect, useCallback } from 'react';
import { authHeaders, getInitStatus, checkSdkUpdate } from '../api';
import { IconPackage } from './icons';

const BASE = '/api';

export default function AgentSdkCard({ triggerCheck }) {
  const [status, setStatus] = useState(null);       // { sdkInstalled, sdkVersion, sdkPath }
  const [installing, setInstalling] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [installPct, setInstallPct] = useState(0);
  const [installLog, setInstallLog] = useState('');
  const [upgradeLog, setUpgradeLog] = useState('');
  const [upgradeDone, setUpgradeDone] = useState(false);
  const [upgradeError, setUpgradeError] = useState(null);
  const [installDone, setInstallDone] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);

  const loadStatus = useCallback(() => {
    getInitStatus().then(d => setStatus(d)).catch(() => {});
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Auto-check SDK update every 6 hours (only if installed)
  useEffect(() => {
    if (!status?.sdkInstalled) return;
    const doCheck = () => {
      checkSdkUpdate().then(res => setUpdateInfo(res)).catch(() => {});
    };
    doCheck(); // check once on mount
    const t = setInterval(doCheck, 360 * 60000);
    return () => clearInterval(t);
  }, [status?.sdkInstalled]);

  // Auto-check when user clicks upgrade tab
  useEffect(() => {
    if (triggerCheck > 0 && status?.sdkInstalled) handleCheckUpdate();
  }, [triggerCheck]);

  const handleInstall = useCallback(async () => {
    setInstalling(true); setInstallLog(''); setInstallPct(0);
    try {
      const res = await fetch(`${BASE}/init/install-sdk`, {
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
    setInstalling(false); setInstallDone(true);
    setTimeout(() => loadStatus(), 1000);
  }, [loadStatus]);

  const handleCheckUpdate = useCallback(async () => {
    setCheckingUpdate(true); setUpdateInfo(null); setUpgradeDone(false); setUpgradeError(null);
    try { const res = await checkSdkUpdate(); setUpdateInfo(res); } catch {}
    setCheckingUpdate(false);
  }, []);

  const handleUpgrade = useCallback(async () => {
    setUpgrading(true); setUpgradeLog(''); setUpgradeDone(false); setUpgradeError(null);
    try {
      const res = await fetch(`${BASE}/init/upgrade-sdk`, {
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
      setUpgradeDone(true);
    } catch (err) {
      setUpgradeError(err.message || '升级失败');
    }
    setUpgrading(false);
    setTimeout(() => { loadStatus(); handleCheckUpdate(); }, 1000);
  }, [loadStatus, handleCheckUpdate]);

  if (!status) return null;

  return (
    <div className="settings-card">
      <div className="settings-card-header"><IconPackage/> Agent SDK</div>
      <div className="settings-card-body">
        <div className="settings-info-row">
          <span className="settings-info-label">状态</span>
          <span className="settings-info-value" style={{ color: status.sdkInstalled ? 'var(--success)' : 'var(--danger)' }}>
            {status.sdkInstalled ? `已安装 (v${status.sdkVersion})` : '未安装 — 发消息会报错'}
          </span>
        </div>
        {status.sdkInstalled && (
          <div className="settings-info-row">
            <span className="settings-info-label">路径</span>
            <span className="settings-info-value mono" style={{ fontSize: 11 }}>{status.sdkPath || '—'}</span>
          </div>
        )}

        {!status.sdkInstalled ? (
          <div style={{ marginTop: 12 }}>
            <button className="init-btn init-btn-install" onClick={handleInstall} disabled={installing}
              style={{ width: '100%', padding: '8px 0', borderRadius: 8, fontSize: 13 }}>
              {installing ? `安装中 ${installPct}%...` : '安装 SDK'}
            </button>
            {installing && installPct > 0 && (
              <div style={{ height: 6, background: 'var(--bg-primary)', borderRadius: 3, overflow: 'hidden', marginTop: 8 }}>
                <div style={{ height: '100%', width: `${installPct}%`, background: 'linear-gradient(90deg, var(--accent), #82b1ff)', borderRadius: 3, transition: 'width 0.3s' }} />
              </div>
            )}
            {installDone && !installing && (
              <div style={{ fontSize: 12, color: 'var(--success)', marginTop: 8 }}>✅ Agent SDK 安装完成</div>
            )}
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
        {upgrading && (
          <div style={{ height: 4, background: 'var(--bg-primary)', borderRadius: 2, overflow: 'hidden', marginTop: 8 }}>
            <div style={{ height: '100%', width: '60%', background: 'linear-gradient(90deg, var(--accent), #82b1ff, var(--accent))', borderRadius: 2, animation: 'sdProgressPulse 1.5s ease-in-out infinite' }} />
          </div>
        )}
        {upgradeDone && !upgrading && (
          <div style={{ fontSize: 12, color: 'var(--success)', marginTop: 8 }}>✅ Agent SDK 升级完成</div>
        )}
        {upgradeError && (
          <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 8 }}>❌ {upgradeError}</div>
        )}
      </div>
    </div>
  );
}
