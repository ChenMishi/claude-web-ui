import { useState, useEffect, useRef, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { useApp } from '../context/AppContext';
import { checkVersion, getVersionInfo, upgradeVersion, getUpgradeLog, getUpgradeStatus } from '../api';

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
  const [upgradeLog, setUpgradeLog] = useState('');
  const logRef = useRef(null);
  const [checkInterval, setCheckInterval] = useState(() => parseInt(localStorage.getItem('claude-ui:checkInterval') || '0') || 0);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [upgradeLog]);

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
      getUpgradeLog().then(d => {
        setUpgradeLog(d.log || '');
        const m = (d.log || '').match(/\[INFO\]\s*(.+)/g);
        if (m) { const last = m[m.length-1].replace('[INFO]','').trim(); if (last) setUpgradeMsg(last); }
      }).catch(() => {});
      getUpgradeStatus().then(s => {
        if (s.progress !== undefined) setUpgradeProgress(s.progress);
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
    flushSync(() => { setUpgrading(true); setUpgradeProgress(0); setUpgradeMsg('启动升级...'); setUpgradeDone(false); setUpgradeError(null); setUpgradeLog(''); });
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
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="version-btn version-btn-check" onClick={handleCheck} disabled={checking}
            style={{ padding: '6px 14px', fontSize: 12, borderRadius: 6, background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer' }}>
            {checking ? '检测中...' : '检测新版本'}
          </button>
        </div>
        {checkResult && !checkResult.error && (
          <div style={{ fontSize: 12, padding: '8px 12px', borderRadius: 8, background: checkResult.hasUpdate ? 'rgba(255,183,77,0.1)' : 'rgba(76,175,80,0.1)', border: `1px solid ${checkResult.hasUpdate ? 'rgba(255,183,77,0.3)' : 'rgba(76,175,80,0.2)'}` }}>
            {checkResult.hasUpdate ? <>🆕 新版本 v{checkResult.newVersion}（当前 v{checkResult.currentVersion}）</> : <>✅ 最新 v{checkResult.currentVersion}</>}
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
              {upgradeDone ? (upgradeMsg.includes('失败') ? `100% — ${upgradeMsg}` : <>100% — 升级完成，请<a href="#" onClick={e => { e.preventDefault(); location.reload(); }} style={{ color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline' }}>刷新</a></>) : `${upgradeProgress}% — ${upgradeMsg}`}
            </div>
            {upgrading && upgradeLog && (
              <pre ref={logRef} style={{ marginTop: 8, background: '#0d0d1f', border: '1px solid var(--border)', borderRadius: 8, padding: 10, maxHeight: 200, overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.5, color: '#a0e0a0', whiteSpace: 'pre-wrap' }}>{upgradeLog}</pre>
            )}
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
