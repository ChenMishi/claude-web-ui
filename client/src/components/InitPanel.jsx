import { useState, useEffect, useCallback, useRef } from 'react';
import { authHeaders, getInitStatus, saveInitConfig, testProxy, checkClaudeUpdate, checkSdkUpdate,
         getProviderConfig, saveProviderConfig, fetchModels } from '../api';
import { useApp } from '../context/AppContext';
import { IconSettings, IconClipboard, IconPackage, IconBot, IconImage, IconRefresh, IconGlobe, IconSave, IconPin } from './icons';

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
  const [checkingSdkUpdate, setCheckingSdkUpdate] = useState(false);
  const [sdkUpdateInfo, setSdkUpdateInfo] = useState(null);
  const [sdkVersions, setSdkVersions] = useState([]); // available versions for rollback
  const [upgradingSDK, setUpgradingSDK] = useState(false);
  const [upgradeSdkLog, setUpgradeSdkLog] = useState('');
  const [claudeInstallLog, setClaudeInstallLog] = useState('');
  const [claudeInstallPct, setClaudeInstallPct] = useState(0);
  const [installingVision, setInstallingVision] = useState(false);
  const [visionInstallLog, setVisionInstallLog] = useState('');
  const [visionInstallPct, setVisionInstallPct] = useState(0);
  const [editProxyHost, setEditProxyHost] = useState('127.0.0.1');
  const [editProxyPort, setEditProxyPort] = useState('15721');
  const [testResult, setTestResult] = useState(null);
  const [installingEnv, setInstallingEnv] = useState(null);
  const [envProgress, setEnvProgress] = useState({});
  const [saveMsg, setSaveMsg] = useState('');
  const envQueueRef = useRef([]);

  // Provider config state
  const [providerConfig, setProviderConfig] = useState(null);
  const [providerLoading, setProviderLoading] = useState(true);
  const [providers, setProviders] = useState([]); // [{id, name, apiKey, baseUrl, chatUrl}]
  const [providerModels, setProviderModels] = useState({}); // id → {available:[], selected:[]}
  const [fetchingModels, setFetchingModels] = useState(false);
  const [providerToast, setProviderToast] = useState(null);

  // Toggle model selection for a provider
  const toggleModel = (providerId, model) => {
    setProviderModels(prev => {
      const entry = prev[providerId] || { available: [], selected: [] };
      const sel = entry.selected.includes(model)
        ? entry.selected.filter(m => m !== model)
        : [...entry.selected, model];
      return { ...prev, [providerId]: { ...entry, selected: sel } };
    });
  };
  const [savingIdx, setSavingIdx] = useState(-1); // which card just saved (-1 = none)

  const { loadAvailableModels, setNeedInit } = useApp();

  const loadStatus = useCallback(() => {
    getInitStatus().then(d => {
      setStatus(d);
      setEditProxyHost(d.proxyHost || '127.0.0.1');
      setEditProxyPort(String(d.proxyPort || '15721'));
    }).catch(() => {});
  }, []);

  const loadProviderConfig = useCallback(() => {
    setProviderLoading(true);
    getProviderConfig().then(d => {
      setProviderConfig(d);
      const ps = d.providers || [];
      if (ps.length === 0) ps.push({ id: '', name: '', apiKey: '', baseUrl: '', chatUrl: '' });
      setProviders(ps);
      setProviderModels(d.providerModels || {});
      setProviderLoading(false);
    }).catch(() => setProviderLoading(false));
  }, []);

  const handleStartCheck = useCallback(async () => {
    setEnvChecked(false);
    setEnvProgress({});
    const res = await getInitStatus();
    setStatus(res);
    setEditProxyHost(res.proxyHost || '127.0.0.1');
    setEditProxyPort(String(res.proxyPort || '15721'));
    setEnvChecked(true);

    // Cache detection result so it persists across page refreshes
    try { localStorage.setItem('claude-ui:envStatus', JSON.stringify({ status: res, time: Date.now() })); } catch {}

    const items = ['node', 'npm', 'git', 'buildtools', 'curl', 'tesseract', 'os'];
    for (let i = 0; i < items.length; i++) {
      await new Promise(r => setTimeout(r, 700));
      setEnvProgress(prev => ({ ...prev, [items[i]]: { checked: true } }));
    }
  }, []);

  // Auto-load status on mount — restore cached env detection if available
  useEffect(() => {
    try {
      const cached = localStorage.getItem('claude-ui:envStatus');
      if (cached) {
        const parsed = JSON.parse(cached);
        setStatus(parsed.status);
        setEnvChecked(true);
        // Restore env progress as all-checked
        const items = ['node', 'npm', 'git', 'buildtools', 'curl', 'tesseract', 'os'];
        const progress = {};
        items.forEach(k => { progress[k] = { checked: true }; });
        setEnvProgress(progress);
        setEditProxyHost(parsed.status?.proxyHost || '127.0.0.1');
        setEditProxyPort(String(parsed.status?.proxyPort || '15721'));
      }
    } catch {}
    loadStatus(); loadProviderConfig();
  }, [loadStatus, loadProviderConfig]);

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

  const handleCheckSdkUpdate = useCallback(async () => {
    setCheckingSdkUpdate(true); setSdkUpdateInfo(null);
    try { const res = await checkSdkUpdate(); setSdkUpdateInfo(res); setSdkVersions(res.versions || []); } catch {}
    setCheckingSdkUpdate(false);
  }, []);

  const handleUpgradeSDK = useCallback(async (version) => {
    const target = version || 'latest';
    setUpgradingSDK(true); setUpgradeSdkLog('');
    try {
      const res = await fetch(`${BASE}/init/upgrade-sdk`, {
        method: 'POST', headers: authHeaders({ Accept: 'text/event-stream', 'Content-Type': 'application/json' }),
        body: JSON.stringify({ version: target }),
      });
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        if (value) {
          buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try { const d = JSON.parse(line.slice(6)); if (d.text) setUpgradeSdkLog(prev => prev + d.text); } catch {}
            }
          }
        }
      }
    } catch {}
    setUpgradingSDK(false);
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

  const handleInstallVision = useCallback(async () => {
    setInstallingVision(true); setVisionInstallLog(''); setVisionInstallPct(0);
    try {
      const res = await fetch(`${BASE}/init/install-vision`, {
        method: 'POST', headers: authHeaders({ Accept: 'text/event-stream' }),
      });
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        if (value) {
          buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try { const d = JSON.parse(line.slice(6)); if (d.pct !== undefined) setVisionInstallPct(d.pct); if (d.text) setVisionInstallLog(prev => prev + d.text + '\n'); } catch {}
            }
          }
        }
      }
    } catch {}
    setInstallingVision(false);
    // Refresh status to update visionInstalled flag
    setTimeout(() => {
      loadStatus();
      // Also refresh the vision status directly
      try { getInitStatus().then(d => { setStatus(d); }); } catch {}
    }, 1500);
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
        : component === 'tesseract' ? res.env?.tesseract
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

  // ── Provider card helpers ──
  const updateProvider = (idx, field, value) => {
    setProviders(prev => prev.map((p, i) => i === idx ? { ...p, [field]: value } : p));
  };
  const addProvider = () => {
    setProviders(prev => [...prev, { id: '', name: '', apiKey: '', baseUrl: '', chatUrl: '' }]);
  };
  const removeProvider = async (idx) => {
    const p = providers[idx];
    if (p.id) {
      try { await authHeaders({}); fetch(`/api/init/provider-config/${p.id}`, { method: 'DELETE', headers: authHeaders({}) }); } catch {}
    }
    setProviders(prev => prev.filter((_, i) => i !== idx));
  };

  // ── Save Provider config only ──
  const handleSaveProvider = async (idx) => {
    const p = providers[idx];
    if (!p) return;
    try {
      const body = { ...p, model: '' };
      const d = await saveProviderConfig(body);
      if (d.provider?.id) {
        // Save models with new provider ID (models may still be keyed by old temp id)
        const models = providerModels[d.provider.id]?.selected || providerModels[p.id]?.selected;
        if (models?.length > 0) {
          await fetch('/api/init/provider-models', {
            method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ providerId: d.provider.id, selected: models }),
          });
        }
        // Migrate key from old temp id to new id
        if (p.id !== d.provider.id && providerModels[p.id]) {
          setProviderModels(prev => {
            const updated = { ...prev };
            updated[d.provider.id] = { ...prev[p.id] };
            delete updated[p.id];
            return updated;
          });
        }
        updateProvider(idx, 'id', d.provider.id);
      }
      setSavingIdx(idx);
      setTimeout(() => setSavingIdx(-1), 2500);
      loadAvailableModels();
    } catch (err) {
      setSaveMsg(`❌ 保存失败: ${err.message}`);
    }
  };

  // ── Save Proxy config ──
  const handleSaveProxy = async () => {
    setSaveMsg('');

    // Save proxy address
    const proxyUrl = `http://${editProxyHost}:${editProxyPort}`;
    try {
      const d = await saveInitConfig({ proxyUrl, proxyHost: editProxyHost, proxyPort: parseInt(editProxyPort) || 15721 });
      if (d.ok) {
        setStatus(prev => ({ ...prev, saved: true }));
        setSaveMsg('✅ 代理配置已保存，代理已重启');
        setNeedInit(false);
      }
    } catch (err) {
      setSaveMsg(`❌ 保存失败: ${err.message}`);
      return;
    }

    // Refresh
    loadProviderConfig();
    loadAvailableModels();
    setTimeout(() => loadStatus(), 1500);
    setTimeout(() => setSaveMsg(''), 3000);
  };

  const handleTestProxy = useCallback(async () => {
    setTestResult(null);
    try {
      const d = await testProxy({ url: `http://${editProxyHost}:${editProxyPort}` });
      setTestResult(d.ok ? 'success' : 'fail');
    } catch { setTestResult('fail'); }
  }, [editProxyHost, editProxyPort]);

  // ── Pull models from all providers ──
  const handlePullModels = async () => {
    const active = providers.filter(p => p.baseUrl && p.apiKey);
    if (active.length === 0) { setProviderToast({ type: 'error', msg: '请先填写至少一个 Provider 的 API Key 和 Base URL' }); return; }
    setFetchingModels(true);
    try {
      const d = await fetchModels(null, null); // null → use server-side providers
      if (d.ok) {
        setProviderModels(d.providerModels || {});
        setProviderToast({ type: 'success', msg: '模型已更新' });
        setTimeout(() => setProviderToast(null), 3000);
      } else {
        setProviderToast({ type: 'error', msg: d.error || '拉取失败' });
      }
    } catch (err) {
      setProviderToast({ type: 'error', msg: err.message });
    }
    setFetchingModels(false);
  };

  const env = status?.env || {};
  const envItems = [
    { key: 'node', label: 'Node.js', ok: env.node, value: env.nodeVersion || '未安装' },
    { key: 'npm', label: 'npm', ok: env.npm, value: env.npmVersion || '未安装' },
    { key: 'git', label: 'Git', ok: env.git, value: env.gitVersion || '未安装' },
    { key: 'buildtools', label: '编译工具', ok: env.buildTools, value: env.buildTools ? '已安装' : '未安装 (node-pty需要)' },
    { key: 'curl', label: 'curl', ok: env.curl, value: env.curl ? '已安装' : '未安装' },
    { key: 'tesseract', label: 'Tesseract OCR', ok: env.tesseract, value: env.tesseractVersion || '未安装 (图片文字识别需要)' },
  ];
  if (env.os) envItems.push({ key: 'os', label: '操作系统', ok: true, value: `${env.os} (${env.arch})` });

  const proxyRunning = status?.proxyRunning;

  return (
    <div className="init-panel">

      {/* ── 系统环境 ── */}
      <div className="init-section">
        <div className="init-section-header">
          <h3><IconClipboard/> 系统环境检测</h3>
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
            <h3><IconPackage/> Agent SDK (工具调用引擎)</h3>
            <span className={`init-status-badge ${status.sdkInstalled ? 'ok' : 'warn'}`}>{status.sdkInstalled ? '已安装' : '未安装'}</span>
          </div>
          <div className="init-info-grid">
            <div className="init-info-item"><span className="init-info-label">状态</span><span className="init-info-value">{status.sdkInstalled ? `已安装 (v${status.sdkVersion})` : '未安装 — 发消息会报错'}</span></div>
            <div className="init-info-item"><span className="init-info-label">路径</span><span className="init-info-value mono">{status.sdkPath || '—'}</span></div>
          </div>
          {!status.sdkInstalled ? (
            <div className="init-deploy-area">
              <button className="init-btn init-btn-install" onClick={handleInstallSDK} disabled={installingSDK}>
                {installingSDK ? '安装中...' : '安装 SDK'}
              </button>
              {sdkInstallLog && <div className="init-install-log"><div className="init-install-scroll"><pre>{sdkInstallLog}</pre></div></div>}
            </div>
          ) : (
            <div className="init-deploy-area" style={{ marginTop: 10 }}>
              <button className="init-btn init-btn-test" onClick={handleCheckSdkUpdate} disabled={checkingSdkUpdate} style={{ marginRight: 8 }}>
                {checkingSdkUpdate ? '检查中...' : '检查更新'}
              </button>
              {sdkUpdateInfo && sdkUpdateInfo.hasUpdate && (
                <button className="init-btn init-btn-install" onClick={() => handleUpgradeSDK(sdkUpdateInfo.latest)} disabled={upgradingSDK}>
                  {upgradingSDK ? '切换中...' : `升级到 v${sdkUpdateInfo.latest}`}
                </button>
              )}
              {sdkUpdateInfo && !sdkUpdateInfo.hasUpdate && sdkUpdateInfo.current && (
                <span style={{ fontSize: 12, color: 'var(--success)' }}>已是最新 v{sdkUpdateInfo.current}</span>
              )}
              {sdkVersions.length > 0 && (
                <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
                  <select onChange={(e) => e.target.value && handleUpgradeSDK(e.target.value)}
                    style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border-color)', background: 'var(--input-bg)', color: 'var(--text-primary)' }}>
                    <option value="">— 选择版本 —</option>
                    {sdkVersions.map(v => <option key={v} value={v}>{v}{sdkUpdateInfo?.current === v ? ' (当前)' : ''}</option>)}
                  </select>
                </div>
              )}
              {upgradeSdkLog && <div className="init-install-log"><div className="init-install-scroll"><pre>{upgradeSdkLog}</pre></div></div>}
            </div>
          )}
        </div>
      )}

      {/* ── Claude Code ── */}
      {status && (
        <div className="init-section">
          <div className="init-section-header">
            <h3><IconBot/> Claude Code</h3>
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
              {claudeInstallLog && <div className="init-install-log"><div className="init-install-scroll"><pre>{claudeInstallLog}</pre></div></div>}
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
              {upgradeClaudeLog && <div className="init-install-log"><div className="init-install-scroll"><pre>{upgradeClaudeLog}</pre></div></div>}
            </div>
          )}
        </div>
      )}

      {/* ── 图像识别模型 (Florence-2) ── */}
      {status && (
        <div className="init-section">
          <div className="init-section-header">
            <h3><IconImage/> 图像识别模型</h3>
            <span className={`init-status-badge ${status.visionInstalled ? 'ok' : 'warn'}`}>
              {status.visionInstalled ? '已安装' : '未安装'}
            </span>
          </div>
          <div className="init-info-grid">
            <div className="init-info-item">
              <span className="init-info-label">模型</span>
              <span className="init-info-value">Florence-2-base (Microsoft)</span>
            </div>
            <div className="init-info-item">
              <span className="init-info-label">功能</span>
              <span className="init-info-value">画面描述 + OCR 文字识别</span>
            </div>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0' }}>
            <IconPin/> 即使不安装此模型，系统已支持通过 Tesseract OCR 对图片进行基础文字识别。
            安装后新增<strong>画面描述</strong>能力，可理解照片中的人物、动物、景物、颜色等视觉信息。
          </p>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 12px' }}>
            <IconSave/> 磁盘占用：~300MB（模型文件） | 内存占用：~1GB（推理时）
          </p>
          {!status.visionInstalled ? (
            <div className="init-deploy-area">
              <button className="init-btn init-btn-install" onClick={handleInstallVision} disabled={installingVision}>
                {installingVision ? `安装中 ${visionInstallPct}%...` : '安装图像识别模型'}
              </button>
              {installingVision && (
                <div className="init-progress-bar" style={{ marginTop: 8, height: 6, borderRadius: 3, background: 'var(--input-bg)', overflow: 'hidden' }}>
                  <div style={{ width: `${visionInstallPct}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.3s' }} />
                </div>
              )}
              {visionInstallLog && <div className="init-install-log"><div className="init-install-scroll"><pre>{visionInstallLog}</pre></div></div>}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--success)', marginTop: 8 }}>✅ 已安装 — 上传图片时将自动进行画面描述和 OCR 文字识别</div>
          )}
        </div>
      )}

      {/* ── API 代理配置 ── */}
      {status && (
        <div className="init-section">
          <div className="init-section-header">
            <h3><IconRefresh/> API 代理配置</h3>
            <span className={`init-status-badge ${proxyRunning ? 'ok' : 'warn'}`}>
              {proxyRunning ? '● 代理运行中' : '○ 代理未运行'}
            </span>
          </div>

          {/* ── Provider 配置 ── */}
          <div className="init-sub-header"><IconSettings/> Provider 配置</div>

          {providers.map((p, idx) => (
            <div key={idx} className="provider-card">
              <div className="provider-card-header">
                <input
                  type="text" value={p.name} onChange={e => updateProvider(idx, 'name', e.target.value)}
                  placeholder="配置名称（如：生产环境）"
                  className="provider-card-name"
                />
                <button onClick={() => removeProvider(idx)} title="删除此配置"
                  className="provider-card-del">✕</button>
              </div>
              <div className="init-config-row">
                <label>API Key</label>
                <input type="text" value={p.apiKey} onChange={e => updateProvider(idx, 'apiKey', e.target.value)}
                  placeholder="sk-..." style={{ flex: 1, fontSize: 13 }} />
              </div>
              <div className="init-config-row">
                <label>Base URL</label>
                <input type="text" value={p.baseUrl} onChange={e => updateProvider(idx, 'baseUrl', e.target.value)}
                  placeholder="https://api.anthropic.com" style={{ flex: 1, fontSize: 13 }} />
              </div>
              <details className="init-advanced" style={{ marginBottom: 4 }}>
                <summary style={{ fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
                  高级选项 {p.chatUrl ? '(已配置)' : ''}
                </summary>
                <div className="init-config-row" style={{ marginTop: 8 }}>
                  <label>聊天地址</label>
                  <input type="text" value={p.chatUrl} onChange={e => updateProvider(idx, 'chatUrl', e.target.value)}
                    placeholder="留空则跟随 Base URL" style={{ flex: 1, fontSize: 13 }} />
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                  部分厂商（如 DeepSeek）模型列表和聊天 API 路径不同，需在此填写完整地址
                </div>
              </details>

              {/* ── 选取模型 ── */}
              <div style={{ marginTop: 6 }}>
                <button className="init-btn init-btn-test" onClick={handlePullModels} disabled={fetchingModels}
                  style={{ fontSize: 11, padding: '3px 8px', marginBottom: 4 }}>
                  {fetchingModels ? '拉取中...' : '拉取模型列表'}
                </button>
                {providerModels[p.id]?.available?.length > 0 && (
                  <div className="provider-model-list" style={{ maxHeight: 150, overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 6, padding: '4px 8px', marginBottom: 6 }}>
                    {providerModels[p.id].available.map(m => {
                      const isSel = (providerModels[p.id].selected || []).includes(m);
                      return (
                        <label key={m} className="provider-model-item" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', cursor: 'pointer', fontSize: 12 }}>
                          <input type="checkbox" checked={isSel} onChange={() => toggleModel(p.id, m)}
                            style={{ accentColor: 'var(--accent)' }} />
                          <span>{m}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 4 }}>
                {savingIdx === idx && <span style={{ fontSize: 11, color: 'var(--success)' }}>✅ 已保存</span>}
                <button className="init-btn init-btn-save" onClick={() => handleSaveProvider(idx)} style={{ fontSize: 12 }}>保存配置</button>
              </div>
            </div>
          ))}
          <button onClick={addProvider} className="init-btn" style={{ width: '100%', marginBottom: 10, border: '1px dashed var(--text-muted)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, padding: '6px' }}>
            ＋ 添加 API 配置
          </button>

          {/* ── 代理地址 ── */}
          <div className="init-sub-header" style={{ marginTop: 16 }}><IconGlobe/> 代理地址</div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>IP地址</span>
                <input type="text" value={editProxyHost} onChange={e => setEditProxyHost(e.target.value)}
                  placeholder="127.0.0.1" style={{ width: 140, fontSize: 13 }} />
              </div>
              <span style={{ fontSize: 13, color: 'var(--text-muted)', paddingBottom: 4 }}>:</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>端口</span>
                <input type="text" value={editProxyPort} onChange={e => setEditProxyPort(e.target.value.replace(/\D/g, ''))}
                  placeholder="15721" style={{ width: 80, fontSize: 13 }} maxLength={5} />
              </div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '8px 0' }}>
            代理将 SDK 请求转发到上游 API 并自动注入 Key。修改代理地址后会自动重启，Provider 配置始终生效。
          </div>

          <div className="init-config-actions" style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="init-btn init-btn-save" onClick={handleSaveProxy}>保存代理配置</button>
            <button className="init-btn init-btn-test" onClick={handleTestProxy}>测试连接</button>
          </div>
          {testResult && <div className={`init-test-result ${testResult}`} style={{ marginTop: 8 }}>{testResult === 'success' ? '✅ 代理连接成功' : '❌ 代理连接失败'}</div>}
          {saveMsg && <div className="init-test-result" style={{ color: saveMsg.includes('✅') ? 'var(--success)' : 'var(--danger)', marginTop: 8 }}>{saveMsg}</div>}

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

      {/* ── 环境信息 ── */}
      {status && (
        <div className="init-section">
          <h3><IconClipboard/> 当前环境信息</h3>
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
