import { useState, useEffect, useCallback } from 'react';

const BASE = '/api';

export default function InitPanel() {
  const [status, setStatus] = useState(null);
  const [installing, setInstalling] = useState(null); // 'claude' | 'ccswitch'
  const [installLog, setInstallLog] = useState('');
  const [installDone, setInstallDone] = useState(false);
  const [proxyUrl, setProxyUrl] = useState('');
  const [proxyPort, setProxyPort] = useState('15721');
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    fetch(`${BASE}/init/status`).then(r => r.json()).then(d => {
      setStatus(d);
      setProxyUrl(d.claudeProxyUrl || d.proxyUrl || 'http://127.0.0.1:15721');
      setProxyPort(String(d.proxyPort || 15721));
    }).catch(() => {});
  }, []);

  const handleInstallCCSwitch = useCallback(async () => {
    setInstalling('ccswitch');
    setInstallLog('');
    setInstallDone(false);
    try {
      const res = await fetch(`${BASE}/init/install-ccswitch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ version: '3.14.1' }),
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.text) setInstallLog(prev => prev + data.text);
                if (data.success !== undefined) setInstallDone(data.success);
              } catch {}
            }
          }
        }
      }
    } catch (err) {
      setInstallLog(prev => prev + `\n错误: ${err.message}\n`);
    }
    setInstalling(null);
    // Refresh status
    setTimeout(() => fetch(`${BASE}/init/status`).then(r => r.json()).then(setStatus).catch(() => {}), 1000);
  }, []);

  const handleSaveConfig = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/init/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxyUrl: `${proxyUrl}:${proxyPort}`, proxyPort }),
      });
      const d = await res.json();
      if (d.ok) {
        setStatus(prev => ({ ...prev, saved: true }));
      }
    } catch {}
  }, [proxyUrl, proxyPort]);

  const handleTestProxy = useCallback(async () => {
    setTestResult(null);
    try {
      const res = await fetch(`${BASE}/init/test-proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `${proxyUrl}:${proxyPort}` }),
      });
      const d = await res.json();
      setTestResult(d.ok ? 'success' : 'fail');
    } catch { setTestResult('fail'); }
  }, [proxyUrl, proxyPort]);

  if (!status) return <div className="init-panel"><p>加载中...</p></div>;

  return (
    <div className="init-panel">
      <h2>🔧 初始化配置</h2>
      <p className="init-desc">新部署完成后，在此页面安装和配置所需组件</p>

      {/* ── Claude Code ── */}
      <div className="init-section">
        <div className="init-section-header">
          <h3>🤖 Claude Code</h3>
          <span className={`init-status-badge ${status.claudeInstalled ? 'ok' : 'warn'}`}>
            {status.claudeInstalled ? '已安装' : '未安装'}
          </span>
        </div>
        <div className="init-info-grid">
          <div className="init-info-item">
            <span className="init-info-label">状态</span>
            <span className="init-info-value">
              {status.claudeInstalled ? `已安装 (SDK v${status.sdkVersion})` : '未安装'}
            </span>
          </div>
          <div className="init-info-item">
            <span className="init-info-label">路径</span>
            <span className="init-info-value mono">{status.claudePath || '—'}</span>
          </div>
        </div>
        {!status.claudeInstalled && (
          <div className="init-note">
            Claude Code 通过 npm 安装 SDK 时自动部署，运行 <code>npm install</code> 即可
          </div>
        )}
      </div>

      {/* ── CC-Switch ── */}
      <div className="init-section">
        <div className="init-section-header">
          <h3>🔄 CC-Switch 代理</h3>
          <span className={`init-status-badge ${status.ccSwitchInstalled ? 'ok' : 'warn'}`}>
            {status.ccSwitchInstalled ? '已安装' : '未安装'}
          </span>
        </div>
        <div className="init-info-grid">
          <div className="init-info-item">
            <span className="init-info-label">状态</span>
            <span className="init-info-value">
              {status.ccSwitchInstalled ? `已安装 (${status.ccSwitchPath})` : '未安装'}
            </span>
          </div>
        </div>
        {!status.ccSwitchInstalled && (
          <div className="init-deploy-area">
            <button
              className="init-btn init-btn-install"
              onClick={handleInstallCCSwitch}
              disabled={installing === 'ccswitch'}
            >
              {installing === 'ccswitch' ? '安装中...' : '安装 CC-Switch'}
            </button>
            {installLog && (
              <div className="init-install-log">
                <pre>{installLog}</pre>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── 环境信息 ── */}
      <div className="init-section">
        <h3>📋 系统环境检测</h3>
        {status.env && (
          <div className="init-env-grid">
            <EnvItem label="操作系统" value={`${status.env.os} (${status.env.arch})`} ok={true} />
            <EnvItem label="Node.js" value={status.env.nodeVersion || '未安装'} ok={status.env.node} />
            <EnvItem label="npm" value={status.env.npmVersion || '未安装'} ok={status.env.npm} />
            <EnvItem label="git" value={status.env.gitVersion || '未安装'} ok={status.env.git} />
            <EnvItem label="编译工具" value={status.env.buildTools ? '已安装' : '未安装 (node-pty需要)'} ok={status.env.buildTools} />
            <EnvItem label="curl" value={status.env.curl ? '已安装' : '未安装'} ok={status.env.curl} />
            <EnvItem label="systemd" value={status.env.systemd ? '已安装' : '未安装'} ok={true} />
            <EnvItem label="用户目录" value={status.env.home} ok={true} />
          </div>
        )}
      </div>

      {/* ── 代理配置 ── */}
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
        {testResult && (
          <div className={`init-test-result ${testResult}`}>
            {testResult === 'success' ? '✅ 连接成功' : '❌ 连接失败'}
          </div>
        )}
      </div>

      {/* ── 环境信息 ── */}
      <div className="init-section">
        <h3>📋 当前环境信息</h3>
        <div className="init-info-grid">
          <div className="init-info-item">
            <span className="init-info-label">SDK 版本</span>
            <span className="init-info-value">v{status.sdkVersion}</span>
          </div>
          <div className="init-info-item">
            <span className="init-info-label">代理地址</span>
            <span className="init-info-value mono">{status.claudeProxyUrl}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function EnvItem({ label, value, ok }) {
  return (
    <div className="init-env-item">
      <span className={`init-env-dot ${ok ? 'ok' : 'warn'}`} />
      <span className="init-env-label">{label}</span>
      <span className="init-env-value">{value}</span>
    </div>
  );
}
