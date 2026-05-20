import { useState, useEffect, useCallback, useRef } from 'react';

const BASE = '/api';

export default function InitPanel() {
  const [status, setStatus] = useState(null);
  const [envChecked, setEnvChecked] = useState(false);
  const [installingCcswitch, setInstallingCcswitch] = useState(false);
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

  // Auto-load status on mount
  useEffect(() => { loadStatus(); }, [loadStatus]);

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
    setEnvProgress(prev => ({ ...prev, [component]: { pct: 5, text: '准备中...' } }));
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
    setTimeout(() => loadStatus(), 1000);
  }, [loadStatus]);

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
          {!envChecked && (
            <button className="init-btn init-btn-check" onClick={() => { loadStatus(); setEnvChecked(true); }}>开始检测</button>
          )}
        </div>
        {envChecked && status && (
          <div className="init-env-grid">
            {envItems.map(item => (
              <EnvCard key={item.key} item={item} installing={installingEnv === item.key} progress={envProgress[item.key]} onInstall={() => handleInstallEnv(item.key)} />
            ))}
          </div>
        )}
      </div>

      {/* ── Claude Code ── */}
      {status && (
        <div className="init-section">
          <div className="init-section-header">
            <h3>🤖 Claude Code</h3>
            <span className={`init-status-badge ${status.claudeInstalled ? 'ok' : 'warn'}`}>{status.claudeInstalled ? '已安装' : '未安装'}</span>
          </div>
          <div className="init-info-grid">
            <div className="init-info-item"><span className="init-info-label">状态</span><span className="init-info-value">{status.claudeInstalled ? `已安装 (SDK v${status.sdkVersion})` : '未安装'}</span></div>
            <div className="init-info-item"><span className="init-info-label">路径</span><span className="init-info-value mono">{status.claudePath || '—'}</span></div>
          </div>
          {!status.claudeInstalled && <div className="init-note">Claude Code 通过 npm 安装 SDK 时自动部署，运行 <code>npm install</code> 即可</div>}
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

function EnvCard({ item, installing, progress, onInstall }) {
  const pct = progress?.pct || 0;
  return (
    <div className={`init-env-card ${installing ? 'installing' : ''}`}>
      {installing && <div className="init-env-card-fill" style={{ width: `${pct}%` }} />}
      <div className="init-env-card-content">
        <span className={`init-env-dot ${item.ok ? 'ok' : 'warn'}`} />
        <span className="init-env-label">{item.label}</span>
        {installing ? (
          <span className="init-env-pct">{pct}%</span>
        ) : item.ok ? (
          <span className="init-env-value">{item.value}</span>
        ) : (
          <button className="init-env-install-btn" onClick={onInstall}>安装</button>
        )}
      </div>
    </div>
  );
}
