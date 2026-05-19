import { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../context/AppContext';

const BASE = '/api';

export default function VersionPanel() {
  const { setSetting } = useApp();
  const [info, setInfo] = useState(null);
  const [remote, setRemote] = useState('');
  const [checkResult, setCheckResult] = useState(null);
  const [checking, setChecking] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeProgress, setUpgradeProgress] = useState(0);
  const [upgradeMsg, setUpgradeMsg] = useState('');
  const [upgradeDone, setUpgradeDone] = useState(false);
  const [checkInterval, setCheckInterval] = useState(() => {
    return parseInt(localStorage.getItem('claude-ui:checkInterval') || '0') || 0;
  });
  const pollRef = useRef(null);

  // Load info
  useEffect(() => {
    fetch(`${BASE}/version/info`).then(r => r.json()).then(d => {
      setInfo(d);
      setRemote(d.remote || '');
    }).catch(() => {});
  }, []);

  // Periodic check
  useEffect(() => {
    if (checkInterval <= 0) return;
    const timer = setInterval(() => {
      fetch(`${BASE}/version/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remote }),
      }).then(r => r.json()).then(d => {
        setCheckResult(d);
        localStorage.setItem('claude-ui:lastCheck', JSON.stringify(d));
      }).catch(() => {});
    }, checkInterval * 60000);
    return () => clearInterval(timer);
  }, [checkInterval, remote]);

  const handleCheck = useCallback(async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await fetch(`${BASE}/version/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remote }),
      });
      const data = await res.json();
      setCheckResult(data);
      localStorage.setItem('claude-ui:lastCheck', JSON.stringify(data));
    } catch (err) {
      setCheckResult({ error: err.message });
    }
    setChecking(false);
  }, [remote]);

  const handleUpgrade = useCallback(async () => {
    setUpgrading(true);
    setUpgradeProgress(0);
    setUpgradeMsg('启动升级...');
    setUpgradeDone(false);

    try {
      // Start upgrade
      const res = await fetch(`${BASE}/version/upgrade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remote }),
      });
      const data = await res.json();
      if (!data.ok) { setUpgradeMsg(data.error || '启动失败'); setUpgrading(false); return; }

      // Poll progress
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`${BASE}/version/upgrade/status`);
          const s = await r.json();
          setUpgradeProgress(s.progress || 0);
          setUpgradeMsg(s.message || '');
          if (s.status === 'done') {
            clearInterval(pollRef.current);
            setUpgradeDone(true);
            setUpgrading(false);
            setCheckResult(null);
          } else if (s.status === 'error') {
            clearInterval(pollRef.current);
            setUpgradeMsg(s.message || '升级失败');
            setUpgrading(false);
          }
        } catch {}
      }, 800);
    } catch (err) {
      setUpgradeMsg(`启动失败: ${err.message}`);
      setUpgrading(false);
    }
  }, [remote]);

  const handleIntervalChange = (v) => {
    setCheckInterval(v);
    localStorage.setItem('claude-ui:checkInterval', String(v));
  };

  return (
    <div className="version-panel">
      <h2>版本管理</h2>

      {/* Server config */}
      <div className="settings-group">
        <label>Git 服务器地址</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={remote}
            onChange={e => setRemote(e.target.value)}
            placeholder="http://10.178.5.224:3000/gogs/claude-web-ui.git"
            style={{ flex: 1 }}
          />
        </div>
      </div>

      {/* Current info */}
      {info && (
        <div className="settings-group">
          <label>当前版本</label>
          <div className="version-info-grid">
            <div className="version-info-item">
              <span className="version-info-label">版本号</span>
              <span className="version-info-value">v{info.version}</span>
            </div>
            <div className="version-info-item">
              <span className="version-info-label">Commit</span>
              <span className="version-info-value">{info.commit?.slice(0, 8)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Check updates */}
      <div className="settings-group">
        <label>版本检测</label>
        <button className="version-btn version-btn-check" onClick={handleCheck} disabled={checking}>
          {checking ? '检测中...' : '检测新版本'}
        </button>

        {checkResult && !checkResult.error && (
          <div className={`version-check-result ${checkResult.hasUpdate ? 'has-update' : ''}`}>
            {checkResult.hasUpdate ? (
              <>
                <div className="version-update-badge">
                  新版本 v{checkResult.newVersion}（当前 v{checkResult.currentVersion}）
                </div>
                <div className="version-update-commits">
                  {checkResult.commits?.map((c, i) => (
                    <div key={i} className="version-commit-item">
                      <span className={`version-commit-tag tag-${c.category}`}>{c.category}</span>
                      <code>{c.hash?.slice(0, 8)}</code> {c.message}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="version-uptodate">已是最新版本 v{checkResult.currentVersion}</div>
            )}
          </div>
        )}
        {checkResult?.error && (
          <div className="version-check-error">检测失败: {checkResult.error}</div>
        )}
      </div>

      {/* One-click upgrade */}
      <div className="settings-group">
        <label>一键升级</label>
        {upgrading || upgradeDone ? (
          <div className="version-upgrade-progress">
            <div className="progress-bar-track">
              <div className="progress-bar-fill" style={{ width: `${upgradeProgress}%` }} />
            </div>
            <div className="progress-bar-text">
              {upgradeProgress}% — {upgradeMsg}
            </div>
            {upgradeDone && (
              <div className="version-refresh-hint">
                服务已重启，请<button onClick={() => location.reload()} className="version-refresh-btn">刷新页面</button>访问新版本
              </div>
            )}
          </div>
        ) : (
          <button className="version-btn version-btn-upgrade" onClick={handleUpgrade}>
            执行升级 (upgrade.sh)
          </button>
        )}
      </div>

      {/* Schedule check */}
      <div className="settings-group">
        <label>定时检测</label>
        <select value={checkInterval} onChange={e => handleIntervalChange(parseInt(e.target.value))}>
          <option value={0}>关闭</option>
          <option value={30}>每 30 分钟</option>
          <option value={60}>每 1 小时</option>
          <option value={360}>每 6 小时</option>
          <option value={720}>每 12 小时</option>
          <option value={1440}>每 24 小时</option>
        </select>
      </div>
    </div>
  );
}
