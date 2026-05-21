import { useState, useEffect, useCallback, useRef } from 'react';

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
  const [installLog, setInstallLog] = useState('');
  const [proxyUrl, setProxyUrl] = useState('');
  const [proxyPort, setProxyPort] = useState('15721');
  const [testResult, setTestResult] = useState(null);
  const [installingEnv, setInstallingEnv] = useState(null);
  const [envProgress, setEnvProgress] = useState({});

  const loadStatus = useCallback(() => {
    fetch(`${BASE}/init/status`).then(r => r.json()).then(d => {
      setStatus(d);
      setProxyUrl(d.claudeProxyUrl || d.proxyUrl || 'http://127.0.0.1:15721');
      setProxyPort(String(d.proxyPort || 15721));
    }).catch(() => {});
  }, []);

  const handleStartCheck = useCallback(async () => {
    setEnvChecked(false);
    setEnvProgress({}); // clear previous results
    const res = await fetch(`${BASE}/init/status`).then(r => r.json());
    setStatus(res);
    setProxyUrl(res.claudeProxyUrl || res.proxyUrl || 'http://127.0.0.1:15721');
    setProxyPort(String(res.proxyPort || 15721));
    setEnvChecked(true);

    const items = ['node', 'npm', 'git', 'buildtools', 'curl', 'os'];
    for (let i = 0; i < items.length; i++) {
      await new Promise(r => setTimeout(r, 700));
      setEnvProgress(prev => ({ ...prev, [items[i]]: { checked: true } }));
    }
  }, []);

  // Auto-load status on mount
  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleCheckClaudeUpdate = useCallback(async () => {
    setCheckingClaudeUpdate(true); setClaudeUpdateInfo(null);
    try { const res = await fetch(`${BASE}/init/check-claude-update`, { method: 'POST' }); setClaudeUpdateInfo(await res.json()); } catch {}
    setCheckingClaudeUpdate(false);
  }, []);

  const handleUpgradeClaude = useCallback(async () => {
    setUpgradingClaude(true); setUpgradeClaudeLog('');
    try {
      const res = await fetch(`${BASE}/init/upgrade-claude`, { method: 'POST', headers: { Accept: 'text/event-stream' } });
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
        method: 'POST', headers: { Accept: 'text/event-stream' },
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
    setInstallingClaude(true); setClaudeInstallLog('');
    try {
      const res = await fetch(`${BASE}/init/install-claude`, {
        method: 'POST', headers: { Accept: 'text/event-stream' },
      });
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        if (value) {
          buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try { const data = JSON.parse(line.slice(6)); if (data.text) setClaudeInstallLog(prev => prev + data.text); } catch {}
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
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ version: '3.14.1' }),
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
  }, [loadStatus]);

  const handleInstallEnv = useCallback(async (component) => {
    setInstallingEnv(component);
    setEnvProgress(prev => ({ ...prev, [component]: { pct: 5, text: '准备中...', checked: true } }));
    try {
      const res = await fetch(`${BASE}/init/install-env/${component}`, {
        method: 'POST', headers: { Accept: 'text/event-stream' },
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
    setInstallingEnv(null);
    // Refresh status and update card
    setTimeout(async () => {
      const res = await fetch(`${BASE}/init/status`).then(r => r.json());
      setStatus(res);
      // Update this component's card directly
      const envOk = component === 'buildtools'
        ? (res.env?.buildTools)
        : component === 'node' ? res.env?.node : res.env?.[component];
      setEnvProgress(prev => ({ ...prev, [component]: { pct: 100, checked: true, ok: envOk } }));
    }, 1000);
  }, []);

  const handleSaveConfig = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/init/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxyUrl: `${proxyUrl}:${proxyPort}`, proxyPort }),
      });
      const d = await res.json();
      if (d.ok) setStatus(prev => ({ ...prev, saved: true }));
    } catch {}
  }, [proxyUrl, proxyPort]);

  const handleTestProxy = useCallback(async () => {
    setTestResult(null);
    try {
      const res = await fetch(`${BASE}/init/test-proxy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `${proxyUrl}:${proxyPort}` }),
      });
      const d = await res.json();
      setTestResult(d.ok ? 'success' : 'fail');
    } catch { setTestResult('fail'); }
  }, [proxyUrl, proxyPort]);

  const env = status?.env || {};
  const envItems = [
    { key: 'node', label: 'Node.js', ok: env.node, value: env.nodeVersion || '未安装' },
    { key: 'npm', label: 'npm', ok: env.npm, value: env.npmVersion || '未安装' },
    { key: 'git', label: 'Git', ok: env.git, value: env.gitVersion || '未安装' },
    { key: 'buildtools', label: '编译工具', ok: env.buildTools, value: env.buildTools ? '已安装' : '未安装 (node-pty需要)' },
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
            <EnvCard key={item.key} item={item} checked={envChecked} installing={installingEnv === item.key} progress={envProgress[item.key]} onInstall={() => handleInstallEnv(item.key)} />
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
          {status.claudeInstalled && (
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
              <button className="init-btn init-btn-install" onClick={handleInstallCCSwitch} disabled={installingCcswitch}>{installingCcswitch ? '安装中...' : '安装 CC-Switch'}</button>
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
  const [ccRunning, setCcRunning] = useState(null);
  const [restarting, setRestarting] = useState(false);

  const loadConfig = () => {
    fetch(`${BASE}/init/ccswitch-config`).then(r => r.json()).then(d => { setConfig(d); setLoading(false); }).catch(() => setLoading(false));
  };

  useEffect(() => {
    loadConfig();
    fetch(`${BASE}/init/ccswitch-status`).then(r => r.json()).then(d => setCcRunning(d.running)).catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch(`${BASE}/init/ccswitch-config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(editProvider) });
      alert('保存成功，重启 CC-Switch 后生效');
      setEditProvider(null);
    } catch (err) { alert('保存失败: ' + err.message); }
    setSaving(false);
  };

  const handleRestartCCSwitch = async () => {
    setRestarting(true);
    try {
      const res = await fetch(`${BASE}/init/ccswitch-restart`, { method: 'POST' });
      const d = await res.json();
      if (d.ok) {
        setCcRunning(true);
        alert('CC-Switch 已启动，等待几秒后刷新配置');
        // Reload config after a delay (db may need time to be created)
        setTimeout(loadConfig, 3000);
      } else alert(d.error || '启动失败');
    } catch (err) { alert('启动失败: ' + err.message); }
    setRestarting(false);
  };

  if (loading) return <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>加载配置中...</div>;

  // Always show run status + start/restart button
  const statusBar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <span className={`init-status-badge ${ccRunning ? 'ok' : 'warn'}`} style={{ fontSize: 10 }}>
        {ccRunning === null ? '检测中' : ccRunning ? '● 运行中' : '○ 未运行'}
      </span>
      <button className="init-btn init-btn-install" onClick={handleRestartCCSwitch} disabled={restarting} style={{ fontSize: 11, padding: '5px 12px' }}>
        {restarting ? '启动中...' : ccRunning ? '重启 CC-Switch' : '启动 CC-Switch'}
      </button>
    </div>
  );

  // No DB or no provider: just show start hint
  if (!config || config.error || !(config.providers || []).find(p => p.id === 'default')) {
    return (
      <div className="init-ccswitch-config">
        <h4>🔧 Provider 配置</h4>
        {statusBar}
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {!ccRunning
            ? '请先点击"启动 CC-Switch"，首次启动会自动创建数据库和默认 Provider'
            : config?.error
              ? config.error
              : '未找到 Provider，请确认 CC-Switch 已正常启动'}
        </div>
      </div>
    );
  }

  const defaultProvider = config.providers.find(p => p.id === 'default');
  const cfg = defaultProvider.config || {};
  const env = cfg.env || {};
  const currentPricing = config.pricing || [];

  if (editProvider) {
    const edEnv = editProvider.config_json?.env || {};
    const edPricing = editProvider.pricing || currentPricing;
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
          <input type="text" value={edEnv.ANTHROPIC_MODEL || ''} onChange={e => {
            const newEnv = { ...edEnv, ANTHROPIC_MODEL: e.target.value };
            setEditProvider({ ...editProvider, config_json: { ...editProvider.config_json, env: newEnv } });
          }} style={{ flex: 1 }} />
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '8px 0' }}>Haiku / Sonnet / Opus 均映射到此模型</div>
        <h4 style={{ marginTop: 16 }}>📊 模型定价 (美元/百万token)</h4>
        <div className="init-pricing-grid">
          {edPricing.slice(0, 5).map(p => (
            <div key={p.model_id} className="init-pricing-item">
              <span className="init-pricing-name">{p.model_name || p.model_id}</span>
              <div className="init-pricing-inputs">
                <label>输入</label><input type="number" step="0.01" value={p.input_price || 0} onChange={e => {
                  const newPricing = edPricing.map(x => x.model_id === p.model_id ? { ...x, input_price: parseFloat(e.target.value) || 0 } : x);
                  setEditProvider({ ...editProvider, pricing: newPricing });
                }} />
                <label>输出</label><input type="number" step="0.01" value={p.output_price || 0} onChange={e => {
                  const newPricing = edPricing.map(x => x.model_id === p.model_id ? { ...x, output_price: parseFloat(e.target.value) || 0 } : x);
                  setEditProvider({ ...editProvider, pricing: newPricing });
                }} />
              </div>
            </div>
          ))}
        </div>
        <div className="init-config-actions" style={{ marginTop: 12 }}>
          <button className="init-btn init-btn-save" onClick={handleSave} disabled={saving}>{saving ? '保存中...' : '保存配置'}</button>
          <button className="init-btn init-btn-test" onClick={() => setEditProvider(null)}>取消</button>
        </div>
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
      <button className="init-btn init-btn-test" style={{ marginTop: 8 }} onClick={() => setEditProvider({ ...defaultProvider, config_json: cfg, pricing: currentPricing })}>
        编辑配置
      </button>
    </div>
  );
}

function EnvCard({ item, checked, installing, progress, onInstall }) {
  const pct = progress?.pct || 0;
  const itemChecked = checked && (progress?.checked || installing);
  const itemOk = progress?.ok !== undefined ? progress.ok : item.ok;
  const showPending = !itemChecked && !installing;
  const showInstalling = installing;
  const showOk = itemChecked && itemOk && !installing;
  const showWarn = itemChecked && !itemOk && !installing;
  const showChecking = checked && !itemChecked && !installing;

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
