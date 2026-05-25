import { useState } from 'react';
import { login, setTokens } from '../api';
import { useApp } from '../context/AppContext';

export default function LoginPage() {
  const { setUser } = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError('请输入用户名和密码');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const data = await login(username.trim(), password);
      setTokens(data.accessToken, data.refreshToken);
      setUser(data.user);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  return (
    <div className="login-overlay">
      {/* Decorative background */}
      <div className="login-bg-orb login-orb-1" />
      <div className="login-bg-orb login-orb-2" />

      <div className="login-card">
        {/* Logo area */}
        <div className="login-header">
          <div className="login-logo">CW</div>
          <h1>Claude Web UI</h1>
          <p>AI 驱动的智能工作助手</p>
        </div>

        {/* Divider */}
        <div className="login-divider">
          <span>账号登录</span>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="login-field">
            <span className="login-field-icon">👤</span>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="用户名"
              autoFocus
              autoComplete="username"
            />
          </div>
          <div className="login-field">
            <span className="login-field-icon">🔒</span>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="密码"
              autoComplete="current-password"
            />
          </div>

          {error && <div className="login-error">{error}</div>}

          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? '登录中...' : '登 录'}
          </button>
        </form>

        {/* Footer */}
        <div className="login-footer">
          <span>v1.1.2</span>
          <span>Secure · Private</span>
        </div>
      </div>
    </div>
  );
}
