import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { getUsers, createUser, deleteUser } from '../api';
import VersionCard from './VersionCard';

export default function SettingsPanel() {
  const { model, systemPrompt, permissionLevel, setSetting, projects, currentProjectId, user } = useApp();
  const isAdmin = user?.role === 'admin';
  const project = projects.find(p => p.id === currentProjectId);

  const [users, setUsers] = useState([]);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('user');
  const [mgmtError, setMgmtError] = useState('');
  const [mgmtLoading, setMgmtLoading] = useState(false);

  const loadUsers = () => { getUsers().then(d => setUsers(d.users)).catch(() => {}); };
  useEffect(() => { if (isAdmin) loadUsers(); }, [isAdmin]);

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

      {/* Card 1: 用户管理 */}
      {isAdmin && (
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
      )}

      {/* Card 2: 版本升级 */}
      <VersionCard />

      {/* Card 3: 对话设置 */}
      <div className="settings-card">
        <div className="settings-card-header">💬 对话设置</div>
        <div className="settings-card-body">
          <div className="settings-row">
            <label>模型</label>
            <select value={model} onChange={e => setSetting('model', e.target.value)}>
              <option value="claude-opus-4-7">Claude Opus 4.7</option>
              <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
              <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
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

      {/* Card 4: 系统信息 */}
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
            <span className="settings-info-value">v1.1.4</span>
          </div>
          <div className="settings-info-row">
            <span className="settings-info-label">数据存储</span>
            <span className="settings-info-value mono">~/.claude/projects/</span>
          </div>
        </div>
      </div>
    </div>
  );
}
