import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../context/AppContext';
import { changePassword, updateAvatar } from '../api';

export default function ProfileModal({ onClose }) {
  const { user, setUser } = useApp();
  const [tab, setTab] = useState('avatar');
  const [avatarMsg, setAvatarMsg] = useState('');
  const [pwMsg, setPwMsg] = useState('');
  const [pwError, setPwError] = useState('');
  const [loading, setLoading] = useState(false);
  const fileRef = useRef(null);

  // Password form
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');

  const handleAvatarUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setAvatarMsg('图片不能超过5MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      setLoading(true);
      try {
        await updateAvatar(reader.result);
        setUser({ ...user, avatar: reader.result });
        setAvatarMsg('头像更新成功');
      } catch (err) {
        setAvatarMsg(err.message);
      }
      setLoading(false);
    };
    reader.readAsDataURL(file);
  };

  const handlePassword = async (e) => {
    e.preventDefault();
    setPwError('');
    setPwMsg('');
    if (newPw.length < 6) {
      setPwError('新密码至少6位');
      return;
    }
    if (newPw !== confirmPw) {
      setPwError('两次输入的新密码不一致');
      return;
    }
    setLoading(true);
    try {
      await changePassword(oldPw, newPw);
      setPwMsg('密码修改成功');
      setOldPw(''); setNewPw(''); setConfirmPw('');
    } catch (err) {
      setPwError(err.message);
    }
    setLoading(false);
  };

  const initials = (user?.username || 'U').slice(0, 2).toUpperCase();

  // 5 system default AI-themed avatars (SVG data URIs)
  const defaultAvatars = [
    { name: '机器人', svg: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#6c63ff"/><circle cx="35" cy="40" r="7" fill="#fff"/><circle cx="65" cy="40" r="7" fill="#fff"/><rect x="30" y="55" width="40" height="5" rx="2" fill="#fff"/><rect x="25" y="68" width="50" height="12" rx="4" fill="rgba(255,255,255,0.3)"/><rect x="40" y="15" width="20" height="8" rx="4" fill="rgba(255,255,255,0.2)"/><circle cx="50" cy="10" r="4" fill="#00e5ff"/></svg>') },
    { name: '大脑', svg: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#2563eb"/><path d="M50 25 C35 25 20 38 20 50 C20 62 35 75 50 75 C65 75 80 62 80 50 C80 38 65 25 50 25Z" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="3"/><path d="M35 45 Q50 30 65 45" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="2"/><path d="M35 55 Q50 70 65 55" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="2"/><circle cx="30" cy="50" r="3" fill="#fff"/><circle cx="70" cy="50" r="3" fill="#fff"/><circle cx="50" cy="35" r="5" fill="rgba(255,255,255,0.5)"/></svg>') },
    { name: '星光', svg: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#0d9488"/><polygon points="50,15 56,38 50,35 44,38" fill="#fff"/><polygon points="50,35 56,38 65,42 56,46 50,50 44,46 35,42 44,38" fill="rgba(255,255,255,0.6)"/><circle cx="25" cy="30" r="2" fill="rgba(255,255,255,0.4)"/><circle cx="75" cy="25" r="2" fill="rgba(255,255,255,0.4)"/><circle cx="20" cy="65" r="2" fill="rgba(255,255,255,0.4)"/><circle cx="80" cy="70" r="2" fill="rgba(255,255,255,0.4)"/><circle cx="50" cy="80" r="2" fill="rgba(255,255,255,0.4)"/><circle cx="30" cy="80" r="1.5" fill="rgba(255,255,255,0.3)"/><circle cx="70" cy="80" r="1.5" fill="rgba(255,255,255,0.3)"/></svg>') },
    { name: '芯片', svg: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#7c3aed"/><rect x="25" y="25" width="50" height="50" rx="6" fill="rgba(255,255,255,0.15)" stroke="rgba(255,255,255,0.3)" stroke-width="2"/><rect x="35" y="35" width="12" height="12" rx="3" fill="rgba(255,255,255,0.2)"/><rect x="53" y="35" width="12" height="12" rx="3" fill="rgba(255,255,255,0.2)"/><rect x="35" y="53" width="12" height="12" rx="3" fill="rgba(255,255,255,0.2)"/><rect x="53" y="53" width="12" height="12" rx="3" fill="rgba(255,255,255,0.2)"/><line x1="40" y1="15" x2="40" y2="25" stroke="rgba(255,255,255,0.3)" stroke-width="2"/><line x1="60" y1="15" x2="60" y2="25" stroke="rgba(255,255,255,0.3)" stroke-width="2"/><line x1="40" y1="75" x2="40" y2="85" stroke="rgba(255,255,255,0.3)" stroke-width="2"/><line x1="60" y1="75" x2="60" y2="85" stroke="rgba(255,255,255,0.3)" stroke-width="2"/><line x1="15" y1="40" x2="25" y2="40" stroke="rgba(255,255,255,0.3)" stroke-width="2"/><line x1="75" y1="40" x2="85" y2="40" stroke="rgba(255,255,255,0.3)" stroke-width="2"/></svg>') },
    { name: '网络', svg: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#0ea5e9"/><circle cx="50" cy="50" r="8" fill="#fff"/><circle cx="50" cy="25" r="5" fill="rgba(255,255,255,0.7)"/><circle cx="75" cy="40" r="5" fill="rgba(255,255,255,0.6)"/><circle cx="72" cy="65" r="5" fill="rgba(255,255,255,0.5)"/><circle cx="28" cy="65" r="5" fill="rgba(255,255,255,0.5)"/><circle cx="25" cy="35" r="5" fill="rgba(255,255,255,0.6)"/><line x1="50" y1="45" x2="50" y2="30" stroke="rgba(255,255,255,0.3)" stroke-width="2"/><line x1="55" y1="47" x2="70" y2="43" stroke="rgba(255,255,255,0.3)" stroke-width="2"/><line x1="55" y1="53" x2="68" y2="62" stroke="rgba(255,255,255,0.3)" stroke-width="2"/><line x1="45" y1="53" x2="32" y2="62" stroke="rgba(255,255,255,0.3)" stroke-width="2"/><line x1="45" y1="47" x2="30" y2="38" stroke="rgba(255,255,255,0.3)" stroke-width="2"/></svg>') },
  ];

  const handleSetDefaultAvatar = async (svg) => {
    setLoading(true);
    try {
      await updateAvatar(svg);
      setUser({ ...user, avatar: svg });
      setAvatarMsg('头像更新成功');
    } catch (err) {
      setAvatarMsg(err.message);
    }
    setLoading(false);
  };

  return createPortal(
    <div className="profile-backdrop" onClick={onClose}>
      <div className="profile-modal" onClick={e => e.stopPropagation()}>
        <div className="profile-modal-header">
          <h3>个人设置</h3>
          <button className="profile-close-btn" onClick={onClose}>✕</button>
        </div>

      <div className="profile-tabs">
        <button className={`profile-tab ${tab === 'avatar' ? 'active' : ''}`} onClick={() => setTab('avatar')}>
          头像
        </button>
        <button className={`profile-tab ${tab === 'password' ? 'active' : ''}`} onClick={() => setTab('password')}>
          修改密码
        </button>
      </div>

      {tab === 'avatar' && (
        <div className="profile-section">
          <div className="profile-avatar-area">
            {user?.avatar ? (
              <img src={user.avatar} alt="头像" className="profile-avatar-img" />
            ) : (
              <div className="profile-avatar-placeholder">{initials}</div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleAvatarUpload}
            />
            <button
              className="profile-avatar-upload-btn"
              onClick={() => fileRef.current?.click()}
              disabled={loading}
            >
              {loading ? '上传中...' : '选择图片上传'}
            </button>
            <p className="profile-hint">支持 JPG/PNG/GIF，不超过 5MB</p>

            <div className="profile-default-avatars">
              <p className="profile-hint">系统默认头像</p>
              <div className="profile-avatar-grid">
                {defaultAvatars.map((a, i) => (
                  <img key={i} src={a.svg} alt={a.name} title={a.name}
                    className="profile-default-avatar-item"
                    onClick={() => handleSetDefaultAvatar(a.svg)} />
                ))}
              </div>
            </div>
          </div>
          {avatarMsg && <div className={`profile-msg ${avatarMsg.includes('成功') ? 'success' : 'error'}`}>{avatarMsg}</div>}
        </div>
      )}

      {tab === 'password' && (
        <form className="profile-section" onSubmit={handlePassword}>
          <div className="profile-field">
            <label>旧密码</label>
            <input
              type="password"
              value={oldPw}
              onChange={e => setOldPw(e.target.value)}
              placeholder="请输入旧密码"
              autoComplete="current-password"
            />
          </div>
          <div className="profile-field">
            <label>新密码</label>
            <input
              type="password"
              value={newPw}
              onChange={e => setNewPw(e.target.value)}
              placeholder="至少6位"
              autoComplete="new-password"
            />
          </div>
          <div className="profile-field">
            <label>确认新密码</label>
            <input
              type="password"
              value={confirmPw}
              onChange={e => setConfirmPw(e.target.value)}
              placeholder="再次输入新密码"
              autoComplete="new-password"
            />
          </div>
          {pwError && <div className="profile-msg error">{pwError}</div>}
          {pwMsg && <div className="profile-msg success">{pwMsg}</div>}
          <button type="submit" className="profile-save-btn" disabled={loading}>
            {loading ? '保存中...' : '修改密码'}
          </button>
        </form>
      )}
    </div>
    </div>,
    document.body
  );
}
