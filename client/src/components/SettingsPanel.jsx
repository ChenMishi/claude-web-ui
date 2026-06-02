import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { getUsers, createUser, deleteUser, getPricing, savePricing } from '../api';
import VersionCard from './VersionCard';
import ClaudeCodeCard from './ClaudeCodeCard';
import InitPanel from './InitPanel';
import LogPanel from './LogPanel';
import StatsPanel from './StatsPanel';
import BackupCard from './BackupCard';

export default function SettingsPanel() {
  const { model, systemPrompt, permissionLevel, setSetting, projects, currentProjectId, user,
    availableModels, currentModel, switchCurrentModel } = useApp();
  const isAdmin = user?.role === 'admin';
  const project = projects.find(p => p.id === currentProjectId);
  const [settingsTab, setSettingsTab] = useState('general'); // 'general' | 'users' | 'init' | 'logs' | 'upgrade'

  const [users, setUsers] = useState([]);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('user');
  const [mgmtError, setMgmtError] = useState('');
  const [mgmtLoading, setMgmtLoading] = useState(false);

  const loadUsers = () => { getUsers().then(d => setUsers(d.users)).catch(() => {}); };
  useEffect(() => { if (isAdmin) loadUsers(); }, [isAdmin]);

  // Pricing config
  const [pricingModels, setPricingModels] = useState({});
  const [pricingSaveMsg, setPricingSaveMsg] = useState('');
  useEffect(() => { getPricing().then(d => setPricingModels(d.models || {})).catch(() => {}); }, []);

  const handlePricingChange = (model, field, value) => {
    setPricingModels(prev => ({
      ...prev,
      [model]: { ...(prev[model] || {}), [field]: value === '' ? '' : parseFloat(value) || 0 },
    }));
  };

  const handleSavePricing = async () => {
    setPricingSaveMsg('');
    try {
      // Clean empty values
      const cleaned = {};
      for (const [model, prices] of Object.entries(pricingModels)) {
        const p = {};
        if (prices.input || prices.input === 0) p.input = prices.input;
        if (prices.output || prices.output === 0) p.output = prices.output;
        if (prices.cacheInput || prices.cacheInput === 0) p.cacheInput = prices.cacheInput;
        if (prices.cacheOutput || prices.cacheOutput === 0) p.cacheOutput = prices.cacheOutput;
        if (Object.keys(p).length > 0) cleaned[model] = p;
      }
      await savePricing(cleaned);
      setPricingSaveMsg('✅ 定价已保存');
      setTimeout(() => setPricingSaveMsg(''), 3000);
    } catch (err) {
      setPricingSaveMsg(`❌ 保存失败: ${err.message}`);
    }
  };

  const handleCreateUser = async () => {
    if (!newUsername.trim() || !newPassword.trim()) { setMgmtError('用户名和密码不能为空'); return; }
    setMgmtError(''); setMgmtLoading(true);
    try { await createUser(newUsername.trim(), newPassword, newRole); setNewUsername(''); setNewPassword(''); setNewRole('user'); loadUsers(); }
    catch (err) { setMgmtError(err.message); }
    setMgmtLoading(false);
  };

  const handleDeleteUser = async (id) => {
    if (!confirm('确定删除此用户？')) return;
    try { await deleteUser(id); loadUsers(); }
    catch (err) { setMgmtError(err.message); }
  };

  return (
    <div className="settings-panel">
      <h2>⚙ 设置</h2>

      <div className="settings-tabs">
        <button className={settingsTab === 'general' ? 'active' : ''} onClick={() => setSettingsTab('general')}>⚙ 常规设置</button>
        {isAdmin && (
          <button className={settingsTab === 'users' ? 'active' : ''} onClick={() => setSettingsTab('users')}>👥 用户管理</button>
        )}
        <button className={settingsTab === 'init' ? 'active' : ''} onClick={() => setSettingsTab('init')}>⚡ 初始化</button>
        <button className={settingsTab === 'logs' ? 'active' : ''} onClick={() => setSettingsTab('logs')}>📋 日志</button>
        <button className={settingsTab === 'stats' ? 'active' : ''} onClick={() => setSettingsTab('stats')}>📊 统计</button>
        <button className={settingsTab === 'upgrade' ? 'active' : ''} onClick={() => setSettingsTab('upgrade')}>🔄 升级</button>
      </div>

      {settingsTab === 'general' ? (
        <>
          {/* Card: 对话设置 */}
          <div className="settings-card">
            <div className="settings-card-header">💬 对话设置</div>
            <div className="settings-card-body">
              <div className="settings-row">
                <label>模型</label>
                <select value={currentModel || model} onChange={e => switchCurrentModel(e.target.value)}>
                  {availableModels.length > 0 ? (
                    availableModels.map(m => <option key={m} value={m}>{m}</option>)
                  ) : (
                    <>
                      <option value="claude-opus-4-7">Claude Opus 4.7</option>
                      <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
                      <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
                    </>
                  )}
                </select>
              </div>
              <div className="settings-row">
                <label>工具权限</label>
                <select value={permissionLevel} onChange={e => setSetting('permissionLevel', e.target.value)}>
                  <option value="auto">自动执行</option>
                  <option value="confirm-dangerous">写入确认</option>
                  <option value="confirm-all">全部确认</option>
                </select>
              </div>
              <div className="settings-row">
                <label>System Prompt</label>
                <textarea value={systemPrompt} onChange={e => setSetting('systemPrompt', e.target.value)}
                  placeholder="自定义 system prompt（留空使用默认）" />
              </div>
            </div>
          </div>

          {/* Card: Token 定价 */}
          <div className="settings-card">
            <div className="settings-card-header">💰 Token 定价</div>
            <div className="settings-card-body">
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>单位：元 / 百万 tokens</div>
              {availableModels.length > 0 ? (
                <table className="pricing-table">
                  <thead>
                    <tr>
                      <th style={{ width: '35%' }}>模型</th>
                      <th>输入价格</th>
                      <th>输出价格</th>
                      <th>缓存输入</th>
                      <th>缓存输出</th>
                    </tr>
                  </thead>
                  <tbody>
                    {availableModels.map(m => (
                      <tr key={m}>
                        <td className="pricing-model-name" title={m}>{m}</td>
                        <td>
                          <input type="number" step="0.00001" min="0" placeholder="—"
                            value={pricingModels[m]?.input ?? ''}
                            onChange={e => handlePricingChange(m, 'input', e.target.value)}
                            className="pricing-input" />
                        </td>
                        <td>
                          <input type="number" step="0.00001" min="0" placeholder="—"
                            value={pricingModels[m]?.output ?? ''}
                            onChange={e => handlePricingChange(m, 'output', e.target.value)}
                            className="pricing-input" />
                        </td>
                        <td>
                          <input type="number" step="0.00001" min="0" placeholder="—"
                            value={pricingModels[m]?.cacheInput ?? ''}
                            onChange={e => handlePricingChange(m, 'cacheInput', e.target.value)}
                            className="pricing-input" />
                        </td>
                        <td>
                          <input type="number" step="0.00001" min="0" placeholder="—"
                            value={pricingModels[m]?.cacheOutput ?? ''}
                            onChange={e => handlePricingChange(m, 'cacheOutput', e.target.value)}
                            className="pricing-input" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>暂无可用模型，请先在 🔧 初始化中配置 Provider 并拉取模型列表</div>
              )}
              <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="init-btn init-btn-save" onClick={handleSavePricing}>保存定价</button>
                {pricingSaveMsg && (
                  <span style={{ fontSize: 12, color: pricingSaveMsg.includes('✅') ? 'var(--success)' : 'var(--danger)' }}>{pricingSaveMsg}</span>
                )}
              </div>
            </div>
          </div>

          {/* Card: 备份还原 (admin only) */}
          {isAdmin && <BackupCard />}

          {/* Card: 系统信息 */}
          <div className="settings-card">
            <div className="settings-card-header">📊 系统信息</div>
            <div className="settings-card-body">
              <div className="settings-info-row">
                <span className="settings-info-label">当前项目</span>
                <span className="settings-info-value">{project ? `${project.cwd} (${project.sessionCount} 个会话)` : '未选择'}</span>
              </div>
              <div className="settings-info-row">
                <span className="settings-info-label">代理地址</span>
                <span className="settings-info-value">http://127.0.0.1:15721</span>
              </div>
              <div className="settings-info-row">
                <span className="settings-info-label">版本</span>
                <span className="settings-info-value">v2.0.6</span>
              </div>
              <div className="settings-info-row">
                <span className="settings-info-label">数据存储</span>
                <span className="settings-info-value mono">~/.claude/projects/</span>
              </div>
            </div>
          </div>
        </>
      ) : settingsTab === 'users' ? (
        <div className="settings-card">
          <div className="settings-card-header">👥 用户管理</div>
          <div className="settings-card-body">
            {users.length > 0 && (
              <table className="settings-table">
                <thead><tr><th>用户名</th><th>角色</th><th>创建时间</th><th>操作</th></tr></thead>
                <tbody>
                  {users.map(u => (
                    <tr key={u.id}>
                      <td>{u.username}</td>
                      <td>{u.role === 'admin' ? '管理员' : '用户'}</td>
                      <td>{u.createdAt ? new Date(u.createdAt).toLocaleDateString('zh-CN') : '-'}</td>
                      <td>{u.id !== user?.id && <button className="user-mgmt-del-btn" onClick={() => handleDeleteUser(u.id)}>删除</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="settings-add-user">
              <input type="text" placeholder="用户名" value={newUsername} onChange={e => setNewUsername(e.target.value)} />
              <input type="password" placeholder="密码" value={newPassword} onChange={e => setNewPassword(e.target.value)} />
              <select value={newRole} onChange={e => setNewRole(e.target.value)}>
                <option value="user">普通用户</option>
                <option value="admin">管理员</option>
              </select>
              <button className="user-mgmt-add-btn" onClick={handleCreateUser} disabled={mgmtLoading}>
                {mgmtLoading ? '创建中...' : '创建用户'}
              </button>
            </div>
            {mgmtError && <div className="user-mgmt-error">{mgmtError}</div>}
          </div>
        </div>
      ) : settingsTab === 'init' ? (
        <InitPanel />
      ) : settingsTab === 'upgrade' ? (
        <>
          <VersionCard />
          <ClaudeCodeCard />
        </>
      ) : settingsTab === 'stats' ? (
        <StatsPanel />
      ) : (
        <LogPanel />
      )}
    </div>
  );
}