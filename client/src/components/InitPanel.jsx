import { useState, useEffect, useCallback, useRef } from 'react';
import { authHeaders, getInitStatus, saveInitConfig, testProxy, checkClaudeUpdate,
         getCcswitchConfig, saveCcswitchConfig, getCcswitchStatus, restartCcswitch, initCcswitchProvider, fetchModels } from '../api';
import { useApp } from '../context/AppContext';

const BASE = '/api';

export default function InitPanel() {
  const [status, setStatus] = useState(null);
  const [envChecked, setEnvChecked] = useState(false);
  const [installingCcswitch, setInstallingCcswitch] = useState(false);
  const [installingClaude, setInstallingClaude] = useState(false);
  const [upgradingClaude, setUpgradingClaude] = useState(false);
  const [upgradeClaudeLog, setUpgradeClaudeLog] = useState('');
  const [checkingClaudeUpdate, setCheckingClaudeUpdate] = useState(false);
  const [claudeUpdateInfo, setClaudeUpdateInfo] = useState(null);
  const [installingSDK, setInstallingSDK] = useState(false);
  const [sdkInstallLog, setSdkInstallLog] = useState('');
  const [claudeInstallLog, setClaudeInstallLog] = useState('');
  const [claudeInstallPct, setClaudeInstallPct] = useState(0);
  const [installLog, setInstallLog] = useState('');
  const [proxyUrl, setProxyUrl] = useState('');
  const [proxyPort, setProxyPort] = useState('15721');
  const [testResult, setTestResult] = useState(null);
  const [installingEnv, setInstallingEnv] = useState(null);
  const [envProgress, setEnvProgress] = useState({});
  const [saveMsg, setSaveMsg] = useState('');
  const [ccSwitchVersion, setCcSwitchVersion] = useState('3.14.1');
  const envQueueRef = useRef([]); // 环境组件安装排队

  // Parse a URL string like "http://127.0.0.1:15721" into host and port
  const parseProxyUrl = (urlStr) => {
    try {
      const u = new URL(urlStr);
      const host = `${u.protocol}//${u.hostname}`;
      const port = u.port || '15721';
      return { host, port };
    } catch {
      return { host: urlStr || 'http://127.0.0.1', port: '15721' };
    }
  };

  const loadStatus = useCallback(() => {
    getInitStatus().then(d => {
      setStatus(d);
      const fullUrl = d.proxyUrl || d.claudeProxyUrl || 'http://127.0.0.1:15721';
      const { host, port } = parseProxyUrl(fullUrl);
      setProxyUrl(host);
      setProxyPort(port);
    }).catch(() => {});
  }, []);

  const handleStartCheck = useCallback(async () => {
    setEnvChecked(false);
    setEnvProgress({}); // clear previous results
    const res = await getInitStatus();
    setStatus(res);
    const fullUrl = res.proxyUrl || res.claudeProxyUrl || 'http://127.0.0.1:15721';
    const { host, port } = parseProxyUrl(fullUrl);
    setProxyUrl(host);
    setProxyPort(port);
    setEnvChecked(true);

    const items = ['node', 'npm', 'git', 'buildtools', 'sqlite3', 'gtk', 'curl', 'os'];
    for (let i = 0; i < items.length; i++) {
      await new Promise(r => setTimeout(r, 700));
      setEnvProgress(prev => ({ ...prev, [items[i]]: { checked: true } }));
    }
  }, []);

  // Auto-load status on mount
  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleCheckClaudeUpdate = useCallback(async () => {
    setCheckingClaudeUpdate(true); setClaudeUpdateInfo(null);
    try { const res = await checkClaudeUpdate(); setClaudeUpdateInfo(res); } catch {}
    setCheckingClaudeUpdate(false);
  }, []);

  const handleUpgradeClaude = useCallback(async () => {
    setUpgradingClaude(true); setUpgradeClaudeLog('');
    try {
      const res = await fetch(`${BASE}/init/upgrade-claude`, { method: 'POST', headers: authHeaders({ Accept: 'text/event-stream' }) });
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        if (value) { buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || '';
          for (const line of lines) { if (line.startsWith('data: ')) { try { const d = JSON.parse(line.slice(6)); if (d.text) setUpgradeClaudeLog(prev => prev + d.text); } catch {} } }
        }
      }
    } catch {}
    setUpgradingClaude(false); setTimeout(() => loadStatus(), 1000);
  }, [loadStatus]);

  const handleInstallSDK = useCallback(async () => {
    setInstallingSDK(true); setSdkInstallLog('');
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
              try { const data = JSON.parse(line.slice(6)); if (data.text) setSdkInstallLog(prev => prev + data.text); } catch {}
            }
          }
        }
      }
    } catch {}
    setInstallingSDK(false);
    setTimeout(() => loadStatus(), 1000);
  }, [loadStatus]);

  const handleInstallClaude = useCallback(async () => {
    setInstallingClaude(true); setClaudeInstallLog(''); setClaudeInstallPct(0);
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
              try { const d = JSON.parse(line.slice(6)); if (d.pct !== undefined) setClaudeInstallPct(d.pct); if (d.text) setClaudeInstallLog(prev => prev + d.text); } catch {}
            }
          }
        }
      }
    } catch {}
    setInstallingClaude(false);
    setTimeout(() => loadStatus(), 1000);
  }, [loadStatus]);

  const handleInstallCCSwitch = useCallback(async () => {
    setInstallingCcswitch(true); setInstallLog('');
    try {
      const res = await fetch(`${BASE}/init/install-ccswitch`, {
        method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
        body: JSON.stringify({ version: ccSwitchVersion }),
      });
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        if (value) {
          buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try { const data = JSON.parse(line.slice(6)); if (data.text) setInstallLog(prev => prev + data.text); } catch {}
            }
          }
        }
      }
    } catch {}
    setInstallingCcswitch(false);
    setTimeout(() => loadStatus(), 1000);
  }, [loadStatus, ccSwitchVersion]);

  const runEnvInstall = useCallback(async (component) => {
    setInstallingEnv(component);
    setEnvProgress(prev => ({ ...prev, [component]: { pct: 5, text: '准备中...', checked: true } }));
    try {
      const res = await fetch(`${BASE}/init/install-env/${component}`, {
        method: 'POST', headers: authHeaders({ Accept: 'text/event-stream' }),
      });
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        if (value) {
          buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.pct !== undefined) setEnvProgress(prev => ({ ...prev, [component]: { pct: data.pct, text: data.text || '' } }));
              } catch {}
            }
          }
        }
      }
    } catch {}
    // Brief pause then re-check just this component
    setTimeout(async () => {
      setEnvProgress(prev => ({ ...prev, [component]: { checked: false, pct: 0 } }));
      await new Promise(r => setTimeout(r, 700));
      const res = await getInitStatus();
      setStatus(res);
      const envOk = component === 'buildtools' ? (res.env?.buildTools)
        : component === 'node' ? res.env?.node
        : component === 'npm' ? res.env?.npm
        : component === 'git' ? res.env?.git
        : component === 'sqlite3' ? res.env?.sqlite3
        : component === 'curl' ? res.env?.curl
        : component === 'gtk' ? res.env?.gtk
        : true;
      setEnvProgress(prev => ({ ...prev, [component]: { checked: true, ok: envOk, pct: 100 } }));
      setInstallingEnv(null);
      // 处理队列中的下一个
      if (envQueueRef.current.length > 0) {
        const next = envQueueRef.current.shift();
        setTimeout(() => runEnvInstall(next), 300);
      }
    }, 500);
  }, []);

  const handleInstallEnv = useCallback((component) => {
    if (installingEnv) {
      // 已有安装进行中，排队
      envQueueRef.current.push(component);
      setEnvProgress(prev => ({ ...prev, [component]: { checked: true, queued: true } }));
      return;
    }
    runEnvInstall(component);
  }, [installingEnv, runEnvInstall]);

  const handleSaveConfig = useCallback(async () => {
    setSaveMsg('');
    try {
      const fullUrl = `${proxyUrl}:${proxyPort}`;
      const d = await saveInitConfig({ proxyUrl: fullUrl, proxyPort });
      if (d.ok) {
        setStatus(prev => ({ ...prev, saved: true }));
        setSaveMsg('✅ 配置已保存');
        setTimeout(() => setSaveMsg(''), 2000);
      }
    } catch (err) {
      setSaveMsg(`❌ 保存失败: ${err.message}`);
    }
  }, [proxyUrl, proxyPort]);

  const handleTestProxy = useCallback(async () => {
    setTestResult(null);
    try {
      const d = await testProxy({ url: `${proxyUrl}:${proxyPort}` });
      setTestResult(d.ok ? 'success' : 'fail');
    } catch { setTestResult('fail'); }
  }, [proxyUrl, proxyPort]);

  const env = status?.env || {};
  const envItems = [
    { key: 'node', label: 'Node.js', ok: env.node, value: env.nodeVersion || '未安装' },
    { key: 'npm', label: 'npm', ok: env.npm, value: env.npmVersion || '未安装' },
    { key: 'git', label: 'Git', ok: env.git, value: env.gitVersion || '未安装' },
    { key: 'buildtools', label: '编译工具', ok: env.buildTools, value: env.buildTools ? '已安装' : '未安装 (node-pty需要)' },
    { key: 'sqlite3', label: 'sqlite3', ok: env.sqlite3, value: env.sqlite3 ? '已安装' : '未安装 (CC-Switch需要)' },
    { key: 'gtk', label: 'GTK3 运行库', ok: env.gtk, value: env.gtk ? '已安装' : '未安装 (CC-Switch需要)' },
    { key: 'curl', label: 'curl', ok: env.curl, value: env.curl ? '已安装' : '未安装' },
  ];
  if (env.os) envItems.push({ key: 'os', label: '操作系统', ok: true, value: `${env.os} (${env.arch})` });

  return (
    <div className="init-panel">
      <h2>🔧 初始化配置</h2>
      <p className="init-desc">新部署完成后，在此页面安装和配置所需组件</p>

      {/* ── 系统环境 ── */}
      <div className="init-section">
        <div className="init-section-header">
          <h3>📋 系统环境检测</h3>
          <button className="init-btn init-btn-check" onClick={handleStartCheck}>
            {envChecked ? '重新检测' : '开始检测'}
          </button>
        </div>
        <div className="init-env-grid">
          {envItems.map(item => (
            <EnvCard key={item.key} item={item} checked={envChecked} installing={installingEnv === item.key} queued={envProgress[item.key]?.queued} progress={envProgress[item.key]} onInstall={() => handleInstallEnv(item.key)} />
          ))}
        </div>
      </div>

      {/* ── Agent SDK ── */}
      {status && (
        <div className="init-section">
          <div className="init-section-header">
            <h3>📦 Agent SDK (工具调用引擎)</h3>
            <span className={`init-status-badge ${status.sdkInstalled ? 'ok' : 'warn'}`}>{status.sdkInstalled ? '已安装' : '未安装'}</span>
          </div>
          <div className="init-info-grid">
            <div className="init-info-item"><span className="init-info-label">状态</span><span className="init-info-value">{status.sdkInstalled ? `已安装 (v${status.sdkVersion})` : '未安装 — 发消息会报错'}</span></div>
            <div className="init-info-item"><span className="init-info-label">路径</span><span className="init-info-value mono">{status.sdkPath || '—'}</span></div>
          </div>
          {!status.sdkInstalled && (
            <div className="init-deploy-area">
              <button className="init-btn init-btn-install" onClick={handleInstallSDK} disabled={installingSDK}>
                {installingSDK ? '安装中...' : '安装 SDK'}
              </button>
              {sdkInstallLog && <div className="init-install-log"><pre>{sdkInstallLog}</pre></div>}
            </div>
          )}
        </div>
      )}

      {/* ── Claude Code ── */}
      {status && (
        <div className="init-section">
          <div className="init-section-header">
            <h3>🤖 Claude Code</h3>
            <span className={`init-status-badge ${status.claudeInstalled ? 'ok' : 'warn'}`}>{status.claudeInstalled ? '已安装' : '未安装'}</span>
          </div>
          <div className="init-info-grid">
            <div className="init-info-item"><span className="init-info-label">状态</span><span className="init-info-value">{status.claudeInstalled ? `已安装 (${status.claudeVersion || 'v?'})` : '未安装'}</span></div>
            <div className="init-info-item"><span className="init-info-label">路径</span><span className="init-info-value mono">{status.claudePath || '—'}</span></div>
          </div>
          {!status.claudeInstalled ? (
            <div className="init-deploy-area">
              <button className="init-btn init-btn-install" onClick={handleInstallClaude} disabled={installingClaude}>
                {installingClaude ? `安装中 ${claudeInstallPct}%...` : '安装 Claude Code'}
              </button>
              {installingClaude && (
                <div className="init-progress-bar" style={{ marginTop: 8, height: 6, borderRadius: 3, background: 'var(--input-bg)', overflow: 'hidden' }}>
                  <div style={{ width: `${claudeInstallPct}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.3s' }} />
                </div>
              )}
              {claudeInstallLog && <div className="init-install-log"><pre>{claudeInstallLog}</pre></div>}
            </div>
          ) : (
            <div className="init-deploy-area" style={{ marginTop: 10 }}>
              <button className="init-btn init-btn-test" onClick={handleCheckClaudeUpdate} disabled={checkingClaudeUpdate} style={{ marginRight: 8 }}>
                {checkingClaudeUpdate ? '检查中...' : '检查更新'}
              </button>
              {claudeUpdateInfo && claudeUpdateInfo.hasUpdate && (
                <button className="init-btn init-btn-install" onClick={handleUpgradeClaude} disabled={upgradingClaude}>
                  {upgradingClaude ? '升级中...' : `升级到 v${claudeUpdateInfo.latest}`}
                </button>
              )}
              {claudeUpdateInfo && !claudeUpdateInfo.hasUpdate && claudeUpdateInfo.current && (
                <span style={{ fontSize: 12, color: 'var(--success)' }}>已是最新 v{claudeUpdateInfo.current}</span>
              )}
              {upgradeClaudeLog && <div className="init-install-log"><pre>{upgradeClaudeLog}</pre></div>}
            </div>
          )}
        </div>
      )}

      {/* ── CC-Switch ── */}
      {status && (
        <div className="init-section">
          <div className="init-section-header">
            <h3>🔄 CC-Switch 代理</h3>
            <span className={`init-status-badge ${status.ccSwitchInstalled ? 'ok' : 'warn'}`}>{status.ccSwitchInstalled ? '已安装' : '未安装'}</span>
          </div>
          <div className="init-info-grid">
            <div className="init-info-item"><span className="init-info-label">状态</span><span className="init-info-value">{status.ccSwitchInstalled ? `已安装 (${status.ccSwitchPath})` : '未安装'}</span></div>
          </div>
          {!status.ccSwitchInstalled && (
            <div className="init-deploy-area">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>版本:</span>
                <input type="text" value={ccSwitchVersion} onChange={e => setCcSwitchVersion(e.target.value)}
                  style={{ width: 80, fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
                <button className="init-btn init-btn-install" onClick={handleInstallCCSwitch} disabled={installingCcswitch}>{installingCcswitch ? '安装中...' : '安装 CC-Switch'}</button>
              </div>
              {installLog && <div className="init-install-log"><pre>{installLog}</pre></div>}
            </div>
          )}
          {status.ccSwitchInstalled && (
            <CCSwitchConfig />
          )}
        </div>
      )}

      {/* ── 代理配置 ── */}
      {status && (
        <div className="init-section">
          <h3>⚙ 代理连接配置</h3>
          <div className="init-config-row">
            <label>代理地址</label>
            <div className="init-config-inputs">
              <input type="text" value={proxyUrl} onChange={e => setProxyUrl(e.target.value)} placeholder="http://127.0.0.1" />
              <span>:</span>
              <input type="text" value={proxyPort} onChange={e => setProxyPort(e.target.value)} placeholder="15721" style={{ width: 80 }} />
            </div>
          </div>
          <div className="init-config-actions">
            <button className="init-btn init-btn-test" onClick={handleTestProxy}>测试连接</button>
            <button className="init-btn init-btn-save" onClick={handleSaveConfig}>保存配置</button>
          </div>
          {testResult && <div className={`init-test-result ${testResult}`}>{testResult === 'success' ? '✅ 连接成功' : '❌ 连接失败'}</div>}
          {saveMsg && <div className="init-test-result" style={{ color: saveMsg.includes('✅') ? 'var(--success)' : 'var(--danger)' }}>{saveMsg}</div>}
        </div>
      )}

      {/* ── 环境信息 ── */}
      {status && (
        <div className="init-section">
          <h3>📋 当前环境信息</h3>
          <div className="init-info-grid">
            <div className="init-info-item"><span className="init-info-label">SDK 版本</span><span className="init-info-value">v{status.sdkVersion}</span></div>
            <div className="init-info-item"><span className="init-info-label">代理地址</span><span className="init-info-value mono">{status.claudeProxyUrl}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}

function CCSwitchConfig() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editProvider, setEditProvider] = useState(null);
  const [ccStatus, setCcStatus] = useState(null); // { running, portOpen }
  const [restarting, setRestarting] = useState(false);
  const [toast, setToast] = useState(null); // { type: 'success'|'error', msg: string }
  const [initProvider, setInitProvider] = useState(false); // auto-init in progress
  const [fetchingModels, setFetchingModels] = useState(false); // pulling model list
  const [pulledModels, setPulledModels] = useState(null); // models from manual pull
  const initAttemptedRef = useRef(false); // 防止重复自动初始化

  const { loadAvailableModels } = useApp();

  const ccRunning = ccStatus?.running;
  const ccPortOpen = ccStatus?.portOpen;

  const loadConfig = () => {
    getCcswitchConfig().then(d => { setConfig(d); setLoading(false); }).catch(() => setLoading(false));
  };

  // Auto-init provider if CC-Switch is running but DB has no default provider
  useEffect(() => {
    if (!ccRunning || !config || loading) return;
    if (config.error) return;
    if (initAttemptedRef.current) return;
    const hasDefault = config.providers.some(p => p.id === 'default');
    if (!hasDefault) {
      initAttemptedRef.current = true;
      setInitProvider(true);
      initCcswitchProvider()
        .then(() => setTimeout(loadConfig, 1500))
        .catch(() => { setInitProvider(false); initAttemptedRef.current = false; });
    }
  }, [ccRunning, config, loading]);

  useEffect(() => {
    loadConfig();
    getCcswitchStatus().then(d => setCcStatus(d)).catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveCcswitchConfig({
        providerId: editProvider.id,
        config_json: editProvider.config_json,
      });
      setToast({ type: 'success', msg: '保存成功，重启 CC-Switch 后生效' });
      setEditProvider(null);
      loadConfig(); // 重新加载配置以获取 availableModels 等最新数据
      loadAvailableModels(); // 更新聊天模型选择列表
    } catch (err) { setToast({ type: 'error', msg: '保存失败: ' + err.message }); }
    setSaving(false);
  };

  const handleRestartCCSwitch = async () => {
    setRestarting(true);
    try {
      const d = await restartCcswitch();
      if (d.ok) {
        setCcStatus({ running: true, portOpen: true });
        setToast({ type: 'success', msg: 'CC-Switch 已启动，等待几秒后刷新配置' });
        // Reload config after a delay (db may need time to be created)
        setTimeout(loadConfig, 3000);
      } else setToast({ type: 'error', msg: d.error || '启动失败' });
    } catch (err) { setToast({ type: 'error', msg: '启动失败: ' + err.message }); }
    setRestarting(false);
  };

  if (loading) return <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>加载配置中...</div>;

  // ── Toast overlay ──
  const toastOverlay = toast && (
    <div className="restart-overlay" style={{ zIndex: 200 }} onClick={() => setToast(null)}>
      <div className="restart-toast" onClick={e => e.stopPropagation()} style={{ padding: '24px 32px', gap: 12 }}>
        <p style={{ color: toast.type === 'error' ? 'var(--danger)' : 'var(--success)', fontSize: 15 }}>
          {toast.type === 'error' ? '❌' : '✅'} {toast.msg}
        </p>
        <button className="restart-reload-btn" onClick={() => setToast(null)}>确定</button>
      </div>
    </div>
  );

  // Always show run status + start/restart button
  const statusBar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
      <span className={`init-status-badge ${ccRunning ? 'ok' : 'warn'}`} style={{ fontSize: 10 }}>
        {ccStatus === null ? '检测中' : ccRunning ? '● 进程运行中' : '○ 进程未运行'}
      </span>
      {ccRunning && (
        <span className={`init-status-badge ${ccPortOpen ? 'ok' : 'warn'}`} style={{ fontSize: 10 }}>
          {ccPortOpen ? '● 端口已监听' : '○ 端口未监听'}
        </span>
      )}
      <button className="init-btn init-btn-install" onClick={handleRestartCCSwitch} disabled={restarting} style={{ fontSize: 11, padding: '5px 12px' }}>
        {restarting ? '启动中...' : ccRunning ? '重启 CC-Switch' : '启动 CC-Switch'}
      </button>
    </div>
  );

  // No DB or no provider: just show start hint
  if (!config || config.error || !(config.providers || []).find(p => p.id === 'default')) {
    const needsInit = !loading && ccRunning && config && !config.error && !initAttemptedRef.current;
    return (
      <div className="init-ccswitch-config">
        <h4>🔧 Provider 配置</h4>
        {statusBar}
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {!ccRunning
            ? '请先点击"启动 CC-Switch"，首次启动会自动创建数据库和默认 Provider'
            : (initProvider || needsInit)
              ? '⏳ 正在创建初始化 Provider 配置...'
              : !ccPortOpen
                ? 'CC-Switch 进程已运行但端口未监听，请查看日志排查'
                : config?.error
                  ? config.error
                  : '未找到 Provider，请确认 CC-Switch 已正常启动'}
        </div>
        {toastOverlay}
      </div>
    );
  }

  const defaultProvider = config.providers.find(p => p.id === 'default');
  const cfg = defaultProvider.config || {};
  const env = cfg.env || {};

  if (editProvider) {
    const edEnv = editProvider.config_json?.env || {};
    const avail = (config.availableModels || []).concat(pulledModels || []);
    const handlePullModels = async () => {
      const baseUrl = edEnv.ANTHROPIC_BASE_URL || '';
      const token = edEnv.ANTHROPIC_AUTH_TOKEN || '';
      if (!baseUrl || !token) { setToast({ type: 'error', msg: '请先填写 API Key 和 Base URL' }); return; }
      setFetchingModels(true);
      try {
        const d = await fetchModels(baseUrl, token);
        if (d.ok) {
          setPulledModels(d.models || []);
          loadAvailableModels(); // 更新聊天模型选择列表
        }
        else setToast({ type: 'error', msg: d.error || '拉取失败' });
      } catch (err) { setToast({ type: 'error', msg: '拉取失败: ' + err.message }); }
      setFetchingModels(false);
    };
    const handleModelChange = (model) => {
      const newEnv = {
        ...edEnv,
        ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      };
      setEditProvider({ ...editProvider, config_json: { ...editProvider.config_json, env: newEnv } });
    };
    return (
      <div className="init-ccswitch-config">
        <h4>🔧 编辑 Provider: {editProvider.name}</h4>
        <div className="init-config-row">
          <label>API Key</label>
          <input type="text" value={edEnv.ANTHROPIC_AUTH_TOKEN || ''} onChange={e => {
            const newEnv = { ...edEnv, ANTHROPIC_AUTH_TOKEN: e.target.value };
            setEditProvider({ ...editProvider, config_json: { ...editProvider.config_json, env: newEnv } });
          }} style={{ flex: 1 }} />
        </div>
        <div className="init-config-row">
          <label>Base URL</label>
          <input type="text" value={edEnv.ANTHROPIC_BASE_URL || ''} onChange={e => {
            const newEnv = { ...edEnv, ANTHROPIC_BASE_URL: e.target.value };
            setEditProvider({ ...editProvider, config_json: { ...editProvider.config_json, env: newEnv } });
          }} style={{ flex: 1 }} />
        </div>
        <div className="init-config-row">
          <label>默认模型</label>
          <div style={{ display: 'flex', gap: 6, flex: 1 }}>
            {avail.length > 0 ? (
              <select value={edEnv.ANTHROPIC_MODEL || ''} onChange={e => handleModelChange(e.target.value)} style={{ flex: 1 }}>
                {avail.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input type="text" value={edEnv.ANTHROPIC_MODEL || ''} onChange={e => handleModelChange(e.target.value)}
                style={{ flex: 1 }} placeholder="手动输入模型名" />
            )}
            <button className="init-btn init-btn-test" onClick={handlePullModels} disabled={fetchingModels}
              style={{ fontSize: 11, padding: '6px 10px', whiteSpace: 'nowrap' }}>
              {fetchingModels ? '拉取中...' : '拉取模型'}
            </button>
          </div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '8px 0' }}>选择模型后将同步更新 Haiku / Sonnet / Opus 四个字段</div>
        <div className="init-config-actions" style={{ marginTop: 12 }}>
          <button className="init-btn init-btn-save" onClick={handleSave} disabled={saving}>{saving ? '保存中...' : '保存配置'}</button>
          <button className="init-btn init-btn-test" onClick={() => setEditProvider(null)}>取消</button>
        </div>
        {toastOverlay}
      </div>
    );
  }

  return (
    <div className="init-ccswitch-config">
      <h4>🔧 Provider 配置</h4>
      {statusBar}
      <div className="init-info-grid">
        <div className="init-info-item"><span className="init-info-label">Provider</span><span className="init-info-value">{defaultProvider.name} ({defaultProvider.id})</span></div>
        <div className="init-info-item"><span className="init-info-label">模型</span><span className="init-info-value mono">{env.ANTHROPIC_MODEL || '未配置'}</span></div>
      </div>
      <button className="init-btn init-btn-test" style={{ marginTop: 8 }} onClick={() => setEditProvider({ ...defaultProvider, config_json: cfg })}>
        编辑配置
      </button>
      {toastOverlay}
    </div>
  );
}

function EnvCard({ item, checked, installing, queued, progress, onInstall }) {
  const pct = progress?.pct || 0;
  const itemChecked = checked && (progress?.checked || installing);
  const itemOk = progress?.ok !== undefined ? progress.ok : item.ok;
  const showPending = !itemChecked && !installing && !queued;
  const showInstalling = installing && !queued;
  const showQueued = queued && !installing;
  const showOk = itemChecked && itemOk && !installing && !queued;
  const showWarn = itemChecked && !itemOk && !installing && !queued;
  const showChecking = checked && !itemChecked && !installing && !queued;

  return (
    <div className={`init-env-card ${showInstalling ? 'installing' : ''} ${showPending ? 'pending' : ''}`}>
      {showInstalling && <div className="init-env-card-fill" style={{ width: `${pct}%` }} />}
      <div className="init-env-card-content">
        <span className={`init-env-dot ${showChecking ? 'checking' : (showPending ? 'pending' : (item.ok ? 'ok' : 'warn'))}`} />
        <span className="init-env-label">{item.label}</span>
        {showChecking ? (
          <span className="init-env-checking-text">检测中...</span>
        ) : showInstalling ? (
          <span className="init-env-pct">{pct}%</span>
        ) : showQueued ? (
          <span className="init-env-pending" style={{ color: 'var(--accent)' }}>等待中...</span>
        ) : showPending ? (
          <span className="init-env-pending">待检测</span>
        ) : showOk ? (
          <span className="init-env-value">{item.value}</span>
        ) : (
          <button className="init-env-install-btn" onClick={onInstall}>安装</button>
        )}
      </div>
    </div>
  );
}

