import { useState, useEffect, useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useApp } from '../context/AppContext';
import { checkVersion, getVersionInfo, upgradeVersion, getUpgradeLog, getUpgradeStatus, getVersionHistory, rollbackVersion } from '../api';

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

  // Poll upgrade log + status during upgrade
  useEffect(() => {
    if (!upgrading) return;
    const timer = setInterval(() => {
      // Fetch log first (for display only, never for message)
      getUpgradeLog().then(d => {
        setUpgradeLog(d.log || '');
      }).catch(() => {});
      // Fetch status AFTER log — status message always wins
      getUpgradeStatus().then(s => {
        if (s.progress !== undefined) setUpgradeProgress(s.progress);
        if (s.message) setUpgradeMsg(s.message);
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

  // ── Rollback ──
  const [versions, setVersions] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [confirmTag, setConfirmTag] = useState(null);

  const handleLoadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const data = await getVersionHistory();
      setVersions(data.versions || []);
    } catch (err) {
      setUpgradeError('加载版本历史失败: ' + err.message);
    }
    setLoadingHistory(false);
  }, []);

  const handleRollback = useCallback(async (tag) => {
    setConfirmTag(null);
    flushSync(() => {
      setUpgrading(true);
      setUpgradeProgress(0);
      setUpgradeMsg('启动回滚...');
      setUpgradeDone(false);
      setUpgradeError(null);
      setUpgradeLog('');
      setRollingBack(true);
    });

    try {
      const data = await rollbackVersion(tag);
      if (!data.ok) {
        setUpgradeError(data.error || '启动失败');
        setUpgrading(false);
        setRollingBack(false);
      }
    } catch (err) {
      setUpgradeError(`启动失败: ${err.message}`);
      setUpgrading(false);
      setRollingBack(false);
    }
  }, []);

  // Reset rollback flag on done/error
  useEffect(() => {
    if (!upgrading && (upgradeDone || upgradeError)) {
      setRollingBack(false);
    }
  }, [upgrading, upgradeDone, upgradeError]);

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
            placeholder="https://github.com/user/repo.git"
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
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
          系统每 2 小时自动检测是否有新版本
        </div>
      </div>

      {/* Version rollback */}
      <div className="settings-group">
        <label>版本回滚</label>
        {!rollingBack ? (
          <>
            <button
              className="version-btn version-btn-check"
              onClick={handleLoadHistory}
              disabled={loadingHistory}
            >
              {loadingHistory ? '加载中...' : '加载历史版本'}
            </button>

            {versions.length > 0 && (
              <div className="version-update-commits" style={{ marginTop: 8 }}>
                {versions.map((v) => (
                  <div key={v.tag} className="version-commit-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0' }}>
                    <div>
                      <span className={`version-commit-tag tag-${v.current ? '版本' : '其他'}`}>
                        {v.current ? '当前' : v.tag}
                      </span>
                      <code>{v.commit}</code>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>{v.date}</span>
                    </div>
                    {!v.current && (
                      <button
                        className="version-btn version-btn-upgrade"
                        style={{ fontSize: 11, padding: '2px 10px' }}
                        onClick={() => setConfirmTag(v.tag)}
                      >
                        回滚
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {confirmTag && (
              <div style={{ marginTop: 10, padding: 10, border: '1px solid var(--border-color)', borderRadius: 6, background: 'var(--input-bg)' }}>
                <div style={{ fontSize: 12, marginBottom: 8 }}>
                  确定回滚到 <strong>{confirmTag}</strong>？服务将短暂中断。
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="version-btn version-btn-upgrade"
                    onClick={() => handleRollback(confirmTag)}
                    style={{ fontSize: 12 }}
                  >
                    确认回滚
                  </button>
                  <button
                    className="version-btn version-btn-check"
                    onClick={() => setConfirmTag(null)}
                    style={{ fontSize: 12 }}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            回滚进行中，请查看上方进度
          </div>
        )}
      </div>
    </div>
  );
}
