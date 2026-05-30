import { useState, useEffect, useCallback, useRef } from 'react';
import { authHeaders, getInitStatus, saveInitConfig, testProxy, checkClaudeUpdate,
         getProviderConfig, saveProviderConfig, fetchModels } from '../api';
import { useApp } from '../context/AppContext';

const BASE = '/api';

export default function InitPanel() {
  const [status, setStatus] = useState(null);
  const [envChecked, setEnvChecked] = useState(false);
  const [installingClaude, setInstallingClaude] = useState(false);
  const [upgradingClaude, setUpgradingClaude] = useState(false);
  const [upgradeClaudeLog, setUpgradeClaudeLog] = useState('');
  const [checkingClaudeUpdate, setCheckingClaudeUpdate] = useState(false);
  const [claudeUpdateInfo, setClaudeUpdateInfo] = useState(null);
  const [installingSDK, setInstallingSDK] = useState(false);
  const [sdkInstallLog, setSdkInstallLog] = useState('');
  const [claudeInstallLog, setClaudeInstallLog] = useState('');
  const [claudeInstallPct, setClaudeInstallPct] = useState(0);
  const [proxyPort, setProxyPort] = useState('15721');
  const [testResult, setTestResult] = useState(null);
  const [installingEnv, setInstallingEnv] = useState(null);
  const [envProgress, setEnvProgress] = useState({});
  const [saveMsg, setSaveMsg] = useState('');
  const envQueueRef = useRef([]);

  // Provider config state
  const [providerConfig, setProviderConfig] = useState(null);
  const [providerLoading, setProviderLoading] = useState(true);
  const [editingProvider, setEditingProvider] = useState(false);
  const [editApiKey, setEditApiKey] = useState('');
  const [editBaseUrl, setEditBaseUrl] = useState('');
  const [editModel, setEditModel] = useState('');
  const [pulledModels, setPulledModels] = useState(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [providerToast, setProviderToast] = useState(null);
  const [showApiKey, setShowApiKey] = useState(false);

  const { loadAvailableModels } = useApp();

  const loadStatus = useCallback(() => {
    getInitStatus().then(d => {
      setStatus(d);
      setProxyPort(String(d.proxyPort || '15721'));
    }).catch(() => {});
  }, []);

  const loadProviderConfig = useCallback(() => {
    setProviderLoading(true);
    getProviderConfig().then(d => { setProviderConfig(d); setProviderLoading(false); }).catch(() => setProviderLoading(false));
  }, []);

  const handleStartCheck = useCallback(async () => {
    setEnvChecked(false);
    setEnvProgress({});
    const res = await getInitStatus();
    setStatus(res);
    setProxyPort(String(res.proxyPort || '15721'));
    setEnvChecked(true);

    const items = ['node', 'npm', 'git', 'buildtools', 'curl', 'os'];
    for (let i = 0; i < items.length; i++) {
      await new Promise(r => setTimeout(r, 700));
      setEnvProgress(prev => ({ ...prev, [items[i]]: { checked: true } }));
    }
  }, []);

  // Auto-load status on mount
  useEffect(() => { loadStatus(); loadProviderConfig(); }, [loadStatus, loadProviderConfig]);

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
    setTimeout(async () => {
      setEnvProgress(prev => ({ ...prev, [component]: { checked: false, pct: 0 } }));
      await new Promise(r => setTimeout(r, 700));
      const res = await getInitStatus();
      setStatus(res);
      const envOk = component === 'buildtools' ? (res.env?.buildTools)
        : component === 'node' ? res.env?.node
        : component === 'npm' ? res.env?.npm
        : component === 'git' ? res.env?.git
        : component === 'curl' ? res.env?.curl
        : true;
      setEnvProgress(prev => ({ ...prev, [component]: { checked: true, ok: envOk, pct: 100 } }));
      setInstallingEnv(null);
      if (envQueueRef.current.length > 0) {
        const next = envQueueRef.current.shift();
        setTimeout(() => runEnvInstall(next), 300);
      }
    }, 500);
  }, []);

  const handleInstallEnv = useCallback((component) => {
    if (installingEnv) {
      envQueueRef.current.push(component);
      setEnvProgress(prev => ({ ...prev, [component]: { checked: true, queued: true } }));
      return;
    }
    runEnvInstall(component);
  }, [installingEnv, runEnvInstall]);

  const handleSaveConfig = useCallback(async () => {
    setSaveMsg('');
    try {
      const d = await saveInitConfig({ proxyPort });
      if (d.ok) {
        setStatus(prev => ({ ...prev, saved: true }));
        setSaveMsg('✅ 配置已保存');
        setTimeout(() => setSaveMsg(''), 2000);
      }
    } catch (err) {
      setSaveMsg(`❌ 保存失败: ${err.message}`);
    }
  }, [proxyPort]);

  const handleTestProxy = useCallback(async () => {
    setTestResult(null);
    try {
      const d = await testProxy({ url: `http://127.0.0.1:${proxyPort}` });
      setTestResult(d.ok ? 'success' : 'fail');
    } catch { setTestResult('fail'); }
  }, [proxyPort]);

  // ── Provider config handlers ──

  const handleEditProvider = () => {
    const cfg = providerConfig || {};
    setEditApiKey(cfg.hasApiKey ? '' : ''); // always start empty for security
    setEditBaseUrl(cfg.baseUrl || 'https://api.anthropic.com');
    setEditModel(cfg.model || '');
    setPulledModels(null);
    setEditingProvider(true);
  };

  const handlePullModels = async () => {
    const baseUrl = editBaseUrl || providerConfig?.baseUrl || '';
    let apiKey = editApiKey;
    if (!apiKey) apiKey = providerConfig?.apiKey || '';
    if (!baseUrl || !apiKey) { setProviderToast({ type: 'error', msg: '请先填写 API Key 和 Base URL' }); return; }
    setFetchingModels(true);
    try {
      const d = await fetchModels(baseUrl, apiKey);
      if (d.ok) {
        setPulledModels(d.models || []);
        loadAvailableModels();
      } else {
        setProviderToast({ type: 'error', msg: d.error || '拉取失败' });
      }
    } catch (err) { setProviderToast({ type: 'error', msg: '拉取失败: ' + err.message }); }
    setFetchingModels(false);
  };

  const handleSaveProvider = async () => {
    try {
      const body = { baseUrl: editBaseUrl, model: editModel };
      if (editApiKey) body.apiKey = editApiKey; // only send if changed
      await saveProviderConfig(body);
      setProviderToast({ type: 'success', msg: 'Provider 配置已保存' });
      setEditingProvider(false);
      loadProviderConfig();
      loadAvailableModels();
    } catch (err) { setProviderToast({ type: 'error', msg: '保存失败: ' + err.message }); }
  };

  const env = status?.env || {};
  const envItems = [
    { key: 'node', label: 'Node.js', ok: env.node, value: env.nodeVersion || '未安装' },
    { key: 'npm', label: 'npm', ok: env.npm, value: env.npmVersion || '未安装' },
    { key: 'git', label: 'Git', ok: env.git, value: env.gitVersion || '未安装' },
    { key: 'buildtools', label: '编译工具', ok: env.buildTools, value: env.buildTools ? '已安装' : '未安装 (node-pty需要)' },
    { key: 'curl', label: 'curl', ok: env.curl, value: env.curl ? '已安装' : '未安装' },
  ];
  if (env.os) envItems.push({ key: 'os', label: '操作系统', ok: true, value: `${env.os} (${env.arch})` });

  const proxyRunning = status?.proxyRunning;

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

      {/* ── Provider 配置 ── */}
      {status && (
        <div className="init-section">
          <div className="init-section-header">
            <h3>🔧 Provider 配置</h3>
            <span className={`init-status-badge ${status.providerConfigured ? 'ok' : 'warn'}`}>
              {status.providerConfigured ? '已配置' : '未配置'}
            </span>
          </div>
          <div className="init-info-grid">
            <div className="init-info-item"><span className="init-info-label">默认模型</span><span className="init-info-value mono">{status.providerModel || '未配置'}</span></div>
          </div>

          {/* Provider config editor */}
          {!editingProvider ? (
            <div style={{ marginTop: 12 }}>
              <button className="init-btn init-btn-test" onClick={handleEditProvider}>
                编辑 Provider 配置
              </button>
            </div>
          ) : (
            <div className="init-ccswitch-config" style={{ marginTop: 12 }}>
              <h4>编辑 Provider 配置</h4>
              <div className="init-config-row">
                <label>API Key</label>
                <div style={{ display: 'flex', gap: 6, flex: 1 }}>
                  <input type={showApiKey ? 'text' : 'password'} value={editApiKey} onChange={e => setEditApiKey(e.target.value)}
                    placeholder={providerConfig?.hasApiKey ? '已保存 (不修改则留空)' : 'sk-...'}
                    style={{ flex: 1 }} />
                  <button className="init-btn init-btn-test" onClick={() => setShowApiKey(!showApiKey)}
                    style={{ fontSize: 11, padding: '6px 10px', whiteSpace: 'nowrap' }}
                    title={showApiKey ? '隐藏 API Key' : '显示 API Key'}>
                    {showApiKey ? '🙈 隐藏' : '👁 显示'}
                  </button>
                </div>
              </div>
              <div className="init-config-row">
                <label>Base URL</label>
                <input type="text" value={editBaseUrl} onChange={e => setEditBaseUrl(e.target.value)}
                  placeholder="https://api.anthropic.com"
                  style={{ flex: 1 }} />
              </div>
              <div className="init-config-row">
                <label>默认模型</label>
                <div style={{ display: 'flex', gap: 6, flex: 1 }}>
                  {pulledModels && pulledModels.length > 0 ? (
                    <select value={editModel} onChange={e => setEditModel(e.target.value)} style={{ flex: 1 }}>
                      <option value="">— 选择模型 —</option>
                      {pulledModels.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  ) : (
                    <input type="text" value={editModel} onChange={e => setEditModel(e.target.value)}
                      style={{ flex: 1 }} placeholder="手动输入模型名" />
                  )}
                  <button className="init-btn init-btn-test" onClick={handlePullModels} disabled={fetchingModels}
                    style={{ fontSize: 11, padding: '6px 10px', whiteSpace: 'nowrap' }}>
                    {fetchingModels ? '拉取中...' : '拉取模型'}
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '8px 0' }}>
                代理会将 SDK 请求转发到上游 API，自动注入 API Key。修改配置即时生效，无需重启。
              </div>
              <div className="init-config-actions" style={{ marginTop: 12 }}>
                <button className="init-btn init-btn-save" onClick={handleSaveProvider}>保存配置</button>
                <button className="init-btn init-btn-test" onClick={() => { setEditingProvider(false); setShowApiKey(false); }}>取消</button>
              </div>
            </div>
          )}

          {/* Toast */}
          {providerToast && (
            <div className="restart-overlay" style={{ zIndex: 200 }} onClick={() => setProviderToast(null)}>
              <div className="restart-toast" onClick={e => e.stopPropagation()} style={{ padding: '24px 32px', gap: 12 }}>
                <p style={{ color: providerToast.type === 'error' ? 'var(--danger)' : 'var(--success)', fontSize: 15 }}>
                  {providerToast.type === 'error' ? '❌' : '✅'} {providerToast.msg}
                </p>
                <button className="restart-reload-btn" onClick={() => setProviderToast(null)}>确定</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 代理地址 ── */}
      {status && (
        <div className="init-section">
          <div className="init-section-header">
            <h3>🔄 代理地址</h3>
            <span className={`init-status-badge ${proxyRunning ? 'ok' : 'warn'}`}>
              {proxyRunning ? '● 运行中' : '○ 未运行'}
            </span>
          </div>
          <div className="init-info-grid">
            <div className="init-info-item">
              <span className="init-info-label">监听地址</span>
              <span className="init-info-value mono">http://127.0.0.1</span>
            </div>
            <div className="init-info-item">
              <span className="init-info-label">端口</span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="number" value={proxyPort} onChange={e => setProxyPort(e.target.value)}
                  style={{ width: 80, fontSize: 13 }} min="1024" max="65535" />
              </div>
            </div>
          </div>
          <div className="init-config-actions" style={{ marginTop: 8 }}>
            <button className="init-btn init-btn-test" onClick={handleTestProxy}>测试连接</button>
            <button className="init-btn init-btn-save" onClick={handleSaveConfig}>保存端口</button>
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
