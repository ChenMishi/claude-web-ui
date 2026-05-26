import { useState, useEffect, useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useApp } from '../context/AppContext';
import { checkVersion, getVersionInfo, upgradeVersion, getUpgradeLog, getUpgradeStatus } from '../api';

export default function VersionPanel() {
  const { setSetting, setUpdateAvailable } = useApp();
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

  // Auto-scroll log to bottom
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [upgradeLog]);
  const [checkInterval, setCheckInterval] = useState(() => {
    return parseInt(localStorage.getItem('claude-ui:checkInterval') || '0') || 0;
  });
  const pollRef = useRef(null);

  // Clear update badge when user opens this page
  useEffect(() => {
    setUpdateAvailable(false);
  }, []);

  // Load info
  useEffect(() => {
    getVersionInfo().then(d => {
      setInfo(d);
      setRemote(d.remote || '');
    }).catch(() => {});
  }, []);

  // Periodic check
  useEffect(() => {
    if (checkInterval <= 0) return;
    const timer = setInterval(() => {
      checkVersion({ remote }).then(d => {
        setCheckResult(d);
        if (d.hasUpdate) setUpdateAvailable(true);
        localStorage.setItem('claude-ui:lastCheck', JSON.stringify(d));
      }).catch(() => {});
    }, checkInterval * 60000);
    return () => clearInterval(timer);
  }, [checkInterval, remote]);

  // Poll upgrade log + status during upgrade
  useEffect(() => {
    if (!upgrading) return;
    const timer = setInterval(() => {
      getUpgradeLog().then(d => {
        const log = d.log || '';
        setUpgradeLog(log);
        // Parse [PROGRESS] XX from log for real-time progress
        const progressMatch = log.match(/\[PROGRESS\]\s*(\d+)/g);
        if (progressMatch) {
          const last = progressMatch[progressMatch.length - 1];
          const pct = parseInt(last.match(/\d+/)[0]);
          if (!isNaN(pct)) setUpgradeProgress(pct);
        }
        // Parse [INFO] for status message
        const infoMatch = log.match(/\[INFO\]\s*(.+)/g);
        if (infoMatch) {
          const lastInfo = infoMatch[infoMatch.length - 1].replace('[INFO]', '').trim();
          if (lastInfo) setUpgradeMsg(lastInfo);
        }
      }).catch(() => {});
      getUpgradeStatus().then(s => {
        if (s.status === 'done' || s.progress >= 100) {
          setUpgradeProgress(100);
          setUpgradeDone(true);
          setUpgrading(false);
        }
        if (s.status === 'error') {
          setUpgradeError(s.message || '升级失败');
          setUpgrading(false);
        }
      }).catch(() => {});
    }, 800);
    return () => clearInterval(timer);
  }, [upgrading]);

  const handleCheck = useCallback(async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      const data = await checkVersion({ remote });
      setCheckResult(data);
      if (data.hasUpdate) setUpdateAvailable(true);
      localStorage.setItem('claude-ui:lastCheck', JSON.stringify(data));
    } catch (err) {
      setCheckResult({ error: err.message });
    }
    setChecking(false);
  }, [remote]);

  const handleUpgrade = useCallback(async () => {
    flushSync(() => {
      setUpgrading(true);
      setUpgradeProgress(0);
      setUpgradeMsg('启动升级...');
      setUpgradeDone(false);
      setUpgradeError(null);
      setUpgradeLog('');
    });

    try {
      const data = await upgradeVersion({ remote });
      if (!data.ok) {
        setUpgradeError(data.error || '启动失败');
        setUpgrading(false);
      }
    } catch (err) {
      setUpgradeError(`启动失败: ${err.message}`);
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
              {upgradeDone ? (
                upgradeMsg.includes('失败') ? (
                  <>100% — {upgradeMsg}</>
                ) : (
                  <>100% — 升级完成，请<a href="#" onClick={e => { e.preventDefault(); location.reload(); }} className="version-refresh-link">刷新</a>页面！</>
                )
              ) : (
                <>{upgradeProgress}% — {upgradeMsg}</>
              )}
            </div>
            {upgrading && upgradeLog && (
              <pre className="version-upgrade-log" ref={logRef}>{upgradeLog}</pre>
            )}
          </div>
        ) : (
          <>
            <button
              className="version-btn version-btn-upgrade"
              onClick={handleUpgrade}
              disabled={!checkResult?.hasUpdate}
            >
              执行升级
            </button>
            {!checkResult && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                请先点击"检测新版本"查看是否有更新
              </div>
            )}
            {upgradeError && (
              <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 6 }}>
                {upgradeError}
              </div>
            )}
          </>
        )}
      </div>

      {/* Schedule check */}
      <div className="settings-group">
        <label>定时检测</label>
        <select value={checkInterval} onChange={e => handleIntervalChange(parseInt(e.target.value))}>
          <option value={0}>关闭</option>
          <option value={1}>每 1 分钟（测试）</option>
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
