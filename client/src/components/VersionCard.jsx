import { useState, useEffect, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { useApp } from '../context/AppContext';
import { checkVersion, getVersionInfo, upgradeVersion, getUpgradeStatus, getVersionHistory, rollbackVersion, getRecentChangelogs } from '../api';
import { IconTag, IconRocket } from './icons';

export default function VersionCard({ triggerCheck }) {
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
  const [changelogs, setChangelogs] = useState([]);

  useEffect(() => {
    getVersionInfo().then(d => { setInfo(d); setRemote(d.remote || ''); }).catch(() => {});
    getRecentChangelogs().then(d => setChangelogs(d.changelogs || [])).catch(() => {});
  }, []);

  // Auto-check when user clicks upgrade tab
  useEffect(() => {
    if (triggerCheck > 0) handleCheck();
  }, [triggerCheck]);
  // Periodic check every 6 hours
  useEffect(() => {
    const t = setInterval(() => {
      checkVersion({ remote }).then(d => {
        setCheckResult(d);
        if (d.hasUpdate) setUpdateAvailable(true);
        localStorage.setItem('claude-ui:lastCheck', JSON.stringify(d));
      }).catch(() => {});
    }, 360 * 60000);
    return () => clearInterval(t);
  }, [remote]);

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
    catch (err) {
      const msg = err.message || '';
      let hint = '检测失败';
      if (/timeout|ETIMEDOUT|连接超时/i.test(msg)) hint = '连接仓库超时，请检查网络或仓库地址';
      else if (/ENOTFOUND|getaddrinfo|DNS|找不到/i.test(msg)) hint = '无法解析仓库地址，请检查 URL 是否正确';
      else if (/401|403|权限|Authentication/i.test(msg)) hint = '仓库访问被拒绝，请检查认证信息';
      else if (/not found|404|不存在/i.test(msg)) hint = '仓库不存在或地址无效';
      else hint = `检测失败: ${msg}`;
      setCheckResult({ error: hint });
    }
    setChecking(false);
  }, [remote]);

  const handleUpgrade = useCallback(async () => {
    flushSync(() => { setUpgrading(true); setUpgradeProgress(0); setUpgradeMsg('启动升级...'); setUpgradeDone(false); setUpgradeError(null); });
    try { const d = await upgradeVersion({ remote }); if (!d.ok) { setUpgradeError(d.error||'启动失败'); setUpgrading(false); } }
    catch (err) { setUpgradeError(`启动失败: ${err.message}`); setUpgrading(false); }
  }, [remote]);

  // ── Rollback ──
  const [rollbackVersions, setRollbackVersions] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(null);

  const handleLoadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const data = await getVersionHistory();
      setRollbackVersions(data.versions || []);
    } catch (err) {
      setUpgradeError('加载版本历史失败: ' + err.message);
    }
    setLoadingHistory(false);
  }, []);

  const handleRollback = useCallback(async (tag) => {
    setConfirmRollback(null);
    flushSync(() => {
      setUpgrading(true);
      setUpgradeProgress(0);
      setUpgradeMsg(`正在回滚到 ${tag}...`);
      setUpgradeDone(false);
      setUpgradeError(null);
      setRollingBack(true);
    });
    try {
      const d = await rollbackVersion(tag);
      if (!d.ok) { setUpgradeError(d.error || '启动失败'); setUpgrading(false); setRollingBack(false); }
    } catch (err) { setUpgradeError(`启动失败: ${err.message}`); setUpgrading(false); setRollingBack(false); }
  }, []);

  useEffect(() => {
    if (!upgrading && (upgradeDone || upgradeError)) setRollingBack(false);
  }, [upgrading, upgradeDone, upgradeError]);

  return (
    <div className="settings-card">
      <div className="settings-card-header"><IconTag/> 版本升级</div>
      <div className="settings-card-body">
        {info && (
          <div className="settings-info-row">
            <span className="settings-info-label">当前版本</span>
            <span className="settings-info-value">v{info.version} ({info.commit?.slice(0,8)})</span>
          </div>
        )}

        {/* ── Recent changelogs ── */}
        {changelogs.length > 0 && (
          <div style={{ marginTop: 12, marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--text-secondary)' }}>最近更新</div>
            {changelogs.map((cl, i) => (
              <div key={cl.tag} style={{ marginBottom: i < changelogs.length - 1 ? 10 : 0 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', marginBottom: 2 }}>
                  v{cl.version} <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 4 }}>{cl.date}</span>
                </div>
                {cl.commits.map((c, j) => (
                  <div key={j} style={{ fontSize: 11, color: 'var(--text-muted)', paddingLeft: 10, lineHeight: '1.6' }}>
                    <code style={{ fontSize: 10, marginRight: 4 }}>{c.hash}</code>
                    {c.message}
                  </div>
                ))}
              </div>
            ))}
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
          {checkResult?.error && (
            <span style={{ fontSize: 12, color: 'var(--danger)', marginLeft: 8, alignSelf: 'center' }}>{checkResult.error}</span>
          )}
        </div>
        {checkResult && !checkResult.error && (
          <div style={{ fontSize: 12, padding: '8px 12px', borderRadius: 8, background: checkResult.hasUpdate ? 'rgba(255,183,77,0.1)' : 'rgba(76,175,80,0.1)', border: `1px solid ${checkResult.hasUpdate ? 'rgba(255,183,77,0.3)' : 'rgba(76,175,80,0.2)'}` }}>
            {checkResult.hasUpdate ? (
              <>
                <div style={{ marginBottom: checkResult.commits?.length ? 8 : 0 }}><IconRocket/> 新版本 v{checkResult.newVersion}（当前 v{checkResult.currentVersion}）</div>
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

        {/* ── Version rollback ── */}
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--text-secondary)' }}>版本回滚</div>
          {!rollingBack ? (
            <>
              <button onClick={handleLoadHistory} disabled={loadingHistory}
                style={{ padding: '6px 14px', fontSize: 12, borderRadius: 6, background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer' }}>
                {loadingHistory ? '加载中...' : '加载历史版本'}
              </button>

              {rollbackVersions.length > 0 && (
                <div className="version-update-commits" style={{ marginTop: 8 }}>
                  {rollbackVersions.map((v) => (
                    <div key={v.tag} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', fontSize: 12 }}>
                      <div>
                        <span style={{ color: v.current ? 'var(--accent)' : 'var(--text-muted)' }}>
                          {v.current ? '● 当前' : `v${v.version}`}
                        </span>
                        <code style={{ marginLeft: 8 }}>{v.commit}</code>
                        <span style={{ marginLeft: 6, color: 'var(--text-muted)', fontSize: 11 }}>{v.date}</span>
                      </div>
                      {!v.current && (
                        <button onClick={() => setConfirmRollback(v.tag)}
                          style={{ padding: '2px 10px', fontSize: 11, borderRadius: 4, background: 'transparent', color: 'var(--warning)', border: '1px solid var(--warning)', cursor: 'pointer' }}>
                          回滚
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {confirmRollback && (
                <div style={{ marginTop: 10, padding: 10, borderRadius: 6, background: 'rgba(255,183,77,0.1)', border: '1px solid rgba(255,183,77,0.3)', fontSize: 12 }}>
                  <div style={{ marginBottom: 8 }}>确定回滚到 <strong>{confirmRollback}</strong>？服务将短暂中断。</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => handleRollback(confirmRollback)}
                      style={{ padding: '4px 14px', fontSize: 12, borderRadius: 6, background: 'var(--warning)', color: '#fff', border: 'none', cursor: 'pointer' }}>
                      确认回滚
                    </button>
                    <button onClick={() => setConfirmRollback(null)}
                      style={{ padding: '4px 14px', fontSize: 12, borderRadius: 6, background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)', cursor: 'pointer' }}>
                      取消
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>回滚进行中，请查看上方进度</div>
          )}
        </div>
      </div>
    </div>
  );
}
