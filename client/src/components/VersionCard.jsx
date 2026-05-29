import { useState, useEffect, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { useApp } from '../context/AppContext';
import { checkVersion, getVersionInfo, upgradeVersion, getUpgradeStatus } from '../api';

export default function VersionCard() {
  const { setUpdateAvailable } = useApp();
  const [info, setInfo] = useState(null);
  const [remote, setRemote] = useState('');
  const [checkResult, setCheckResult] = useState(null);
  const [checking, setChecking] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeProgress, setUpgradeProgress] = useState(0);
  const [upgradeMsg, setUpgradeMsg] = useState('');
  const [upgradeDone, setUpgradeDone] = useState(false);
  const [upgradeError, setUpgradeError] = useState(null);
  const [checkInterval, setCheckInterval] = useState(() => parseInt(localStorage.getItem('claude-ui:checkInterval') || '0') || 0);

  useEffect(() => {
    getVersionInfo().then(d => { setInfo(d); setRemote(d.remote || ''); }).catch(() => {});
  }, []);

  // Periodic check
  useEffect(() => {
    if (checkInterval <= 0) return;
    const t = setInterval(() => {
      checkVersion({ remote }).then(d => {
        setCheckResult(d);
        if (d.hasUpdate) setUpdateAvailable(true);
        localStorage.setItem('claude-ui:lastCheck', JSON.stringify(d));
      }).catch(() => {});
    }, checkInterval * 60000);
    return () => clearInterval(t);
  }, [checkInterval, remote]);

  useEffect(() => {
    if (!upgrading) return;
    const t = setInterval(() => {
      getUpgradeStatus().then(s => {
        if (s.progress !== undefined) setUpgradeProgress(s.progress);
        if (s.message) setUpgradeMsg(s.message);
        if (s.status === 'done' || s.progress >= 100) { setUpgradeProgress(100); setUpgradeDone(true); setUpgrading(false); }
        if (s.status === 'error') { setUpgradeError(s.message || '升级失败'); setUpgrading(false); }
      }).catch(() => {});
    }, 800);
    return () => clearInterval(t);
  }, [upgrading]);

  const handleCheck = useCallback(async () => {
    setChecking(true); setCheckResult(null);
    try { const d = await checkVersion({ remote }); setCheckResult(d); }
    catch (err) { setCheckResult({ error: err.message }); }
    setChecking(false);
  }, [remote]);

  const handleUpgrade = useCallback(async () => {
    flushSync(() => { setUpgrading(true); setUpgradeProgress(0); setUpgradeMsg('启动升级...'); setUpgradeDone(false); setUpgradeError(null); });
    try { const d = await upgradeVersion({ remote }); if (!d.ok) { setUpgradeError(d.error||'启动失败'); setUpgrading(false); } }
    catch (err) { setUpgradeError(`启动失败: ${err.message}`); setUpgrading(false); }
  }, [remote]);

  return (
    <div className="settings-card">
      <div className="settings-card-header">🏷 版本升级</div>
      <div className="settings-card-body">
        {info && (
          <div className="settings-info-row">
            <span className="settings-info-label">当前版本</span>
            <span className="settings-info-value">v{info.version} ({info.commit?.slice(0,8)})</span>
          </div>
        )}
        <div className="settings-row">
          <label>Git 仓库地址</label>
          <input
            type="text"
            value={remote}
            onChange={e => setRemote(e.target.value)}
            placeholder="https://github.com/user/repo.git"
            style={{ flex: 1, padding: '6px 10px', fontSize: 12, borderRadius: 4, background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="version-btn version-btn-check" onClick={handleCheck} disabled={checking}
            style={{ padding: '6px 14px', fontSize: 12, borderRadius: 6, background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer' }}>
            {checking ? '检测中...' : '检测新版本'}
          </button>
        </div>
        {checkResult && !checkResult.error && (
          <div style={{ fontSize: 12, padding: '8px 12px', borderRadius: 8, background: checkResult.hasUpdate ? 'rgba(255,183,77,0.1)' : 'rgba(76,175,80,0.1)', border: `1px solid ${checkResult.hasUpdate ? 'rgba(255,183,77,0.3)' : 'rgba(76,175,80,0.2)'}` }}>
            {checkResult.hasUpdate ? (
              <>
                <div style={{ marginBottom: checkResult.commits?.length ? 8 : 0 }}>🚀 新版本 v{checkResult.newVersion}（当前 v{checkResult.currentVersion}）</div>
                {checkResult.commits?.length > 0 && (
                  <div className="version-update-commits">
                    {checkResult.commits.map((c, i) => (
                      <div key={i} className="version-commit-item">
                        <span className={`version-commit-tag tag-${c.category}`}>{c.category}</span>
                        <code>{c.hash?.slice(0, 8)}</code> {c.message}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : <>✅ 最新 v{checkResult.currentVersion}</>}
          </div>
        )}
        {checkResult?.hasUpdate && !upgrading && !upgradeDone && (
          <button onClick={handleUpgrade}
            style={{ padding: '8px 0', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer', width: '100%' }}>
            执行升级
          </button>
        )}
        {(upgrading || upgradeDone) && (
          <div>
            <div style={{ height: 6, background: 'var(--bg-primary)', borderRadius: 3, overflow: 'hidden', marginBottom: 8 }}>
              <div style={{ height: '100%', width: `${upgradeProgress}%`, background: 'linear-gradient(90deg, var(--accent), #82b1ff)', borderRadius: 3, transition: 'width 0.3s' }} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {upgradeDone ? (upgradeMsg.includes('失败') ? `100% — ${upgradeMsg}` : <>100% — 升级完成，请<a href="#" onClick={e => { e.preventDefault(); window.location.reload(); }} style={{ color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline' }}>刷新页面</a>!</>) : `${upgradeProgress}% — ${upgradeMsg}`}
            </div>
          </div>
        )}
        {upgradeError && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{upgradeError}</div>}

        {/* Check interval */}
        <div className="settings-row" style={{ marginTop: 4 }}>
          <label>定时检测</label>
          <select value={checkInterval} onChange={e => { const v = parseInt(e.target.value); setCheckInterval(v); localStorage.setItem('claude-ui:checkInterval', String(v)); }}>
            <option value={0}>关闭</option>
            <option value={30}>每 30 分钟</option>
            <option value={60}>每 1 小时</option>
            <option value={360}>每 6 小时</option>
            <option value={720}>每 12 小时</option>
            <option value={1440}>每 24 小时</option>
          </select>
        </div>
      </div>
    </div>
  );
}
