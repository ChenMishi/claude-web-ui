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
      <div className="login-card">
        {/* Logo area */}
        <div className="login-header">
          <img src="/logo.svg" alt="Logo" className="login-logo" />
          <h1>AI IntelliWork Hub</h1>
          <p>AI 驱动的智能工作助手</p>
        </div>

        {/* Divider */}
        <div className="login-divider">
          <span>账号登录</span>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="login-field">
            <svg className="login-field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
            </svg>
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
            <svg className="login-field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
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
          <span>v2.0.8</span>
          <span>Secure · Private</span>
        </div>
      </div>
    </div>
  );
}
