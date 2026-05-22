import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { getUsers, createUser, deleteUser } from '../api';

export default function SettingsPanel() {
  const { model, systemPrompt, permissionLevel, setSetting, projects, currentProjectId, user } = useApp();
  const isAdmin = user?.role === 'admin';

  const project = projects.find(p => p.id === currentProjectId);

  // User management state (admin only)
  const [users, setUsers] = useState([]);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('user');
  const [mgmtError, setMgmtError] = useState('');
  const [mgmtLoading, setMgmtLoading] = useState(false);

  const loadUsers = () => {
    getUsers().then(d => setUsers(d.users)).catch(() => {});
  };

  useEffect(() => {
    if (isAdmin) loadUsers();
  }, [isAdmin]);

  const handleCreateUser = async () => {
    if (!newUsername.trim() || !newPassword.trim()) {
      setMgmtError('用户名和密码不能为空');
      return;
    }
    setMgmtError('');
    setMgmtLoading(true);
    try {
      await createUser(newUsername.trim(), newPassword, newRole);
      setNewUsername('');
      setNewPassword('');
      setNewRole('user');
      loadUsers();
    } catch (err) {
      setMgmtError(err.message);
    }
    setMgmtLoading(false);
  };

  const handleDeleteUser = async (id) => {
    if (!confirm('确定删除此用户？')) return;
    try {
      await deleteUser(id);
      loadUsers();
    } catch (err) {
      setMgmtError(err.message);
    }
  };

  return (
    <div className="settings-panel">
      <h2>设置</h2>

      <div className="settings-group">
        <label>模型</label>
        <select value={model} onChange={e => setSetting('model', e.target.value)}>
          <option value="claude-opus-4-7">Claude Opus 4.7</option>
          <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
          <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
        </select>
      </div>

      <div className="settings-group">
        <label>工具权限</label>
        <select value={permissionLevel} onChange={e => setSetting('permissionLevel', e.target.value)}>
          <option value="auto">无需确认 — 所有操作自动执行</option>
          <option value="confirm-dangerous">部分确认 — Bash / 写入 / 编辑需确认</option>
          <option value="confirm-all">每步确认 — 所有工具操作需确认</option>
        </select>
      </div>

      <div className="settings-group">
        <label>System Prompt</label>
        <textarea
          value={systemPrompt}
          onChange={e => setSetting('systemPrompt', e.target.value)}
          placeholder="自定义 system prompt（留空使用默认）"
        />
      </div>

      <div className="settings-group">
        <label>当前项目</label>
        <div style={{ fontSize: 14, color: 'var(--text-muted)', wordBreak: 'break-all' }}>
          {project ? `${project.cwd} (${project.sessionCount} 个会话)` : '未选择'}
        </div>
      </div>

      <div className="settings-group">
        <label>Claude 代理地址</label>
        <div style={{ fontSize: 14, color: 'var(--text-muted)' }}>
          http://127.0.0.1:15721
        </div>
      </div>

      <div className="settings-group">
        <label>版本</label>
        <div style={{ fontSize: 14, color: 'var(--text-muted)' }}>
          claude-web-ui v2.0.0
        </div>
      </div>

      <div className="settings-group">
        <label>数据存储</label>
        <div style={{ fontSize: 14, color: 'var(--text-muted)', wordBreak: 'break-all' }}>
          ~/.claude/projects/
        </div>
      </div>

      {isAdmin && (
        <div className="user-mgmt">
          <h3>用户管理</h3>
          {users.length > 0 && (
            <table className="user-mgmt-table">
              <thead>
                <tr>
                  <th>用户名</th>
                  <th>角色</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td>{u.username}</td>
                    <td>{u.role === 'admin' ? '管理员' : '用户'}</td>
                    <td>{u.createdAt ? new Date(u.createdAt).toLocaleDateString('zh-CN') : '-'}</td>
                    <td>
                      {u.id !== user?.id && (
                        <button className="user-mgmt-del-btn" onClick={() => handleDeleteUser(u.id)}>
                          删除
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="user-mgmt-add">
            <input
              type="text"
              placeholder="用户名"
              value={newUsername}
              onChange={e => setNewUsername(e.target.value)}
            />
            <input
              type="password"
              placeholder="密码"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
            />
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
      )}
    </div>
  );
}
