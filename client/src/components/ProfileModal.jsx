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

  // 5 system default avatars — clean modern SVG designs
  const defaultAvatars = [
    { name: '星河', svg: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><radialGradient id="a" cx="40%" cy="35%"><stop offset="0%" stop-color="#a78bfa"/><stop offset="100%" stop-color="#4c1d95"/></radialGradient></defs><rect width="100" height="100" rx="22" fill="url(#a)"/><circle cx="55" cy="42" r="3" fill="#f5f3ff" opacity="0.9"/><circle cx="70" cy="55" r="2" fill="#ddd6fe" opacity="0.7"/><circle cx="38" cy="62" r="2.5" fill="#c4b5fd" opacity="0.8"/><circle cx="48" cy="30" r="1.5" fill="#ede9fe" opacity="0.6"/><circle cx="65" cy="25" r="2" fill="#ddd6fe" opacity="0.5"/><circle cx="30" cy="45" r="1.5" fill="#f5f3ff" opacity="0.7"/><circle cx="75" cy="68" r="1.5" fill="#c4b5fd" opacity="0.6"/></svg>') },
    { name: '山脉', svg: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#1e3a5f"/></linearGradient></defs><rect width="100" height="100" rx="22" fill="url(#b)"/><polygon points="10,80 35,38 50,55 62,30 90,80" fill="rgba(255,255,255,0.25)"/><polygon points="15,80 38,48 50,60 60,42 85,80" fill="rgba(255,255,255,0.15)"/></svg>') },
    { name: '极光', svg: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="c" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#2dd4bf"/><stop offset="50%" stop-color="#0d9488"/><stop offset="100%" stop-color="#134e4a"/></linearGradient></defs><rect width="100" height="100" rx="22" fill="url(#c)"/><path d="M5 50 Q25 20 50 45 Q75 25 95 50" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="2"/><path d="M5 58 Q25 35 50 52 Q75 38 95 58" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="1.5"/><path d="M5 66 Q25 48 50 59 Q75 50 95 66" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1"/></svg>') },
    { name: '日出', svg: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="d" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f97316"/><stop offset="60%" stop-color="#ea580c"/><stop offset="100%" stop-color="#7c2d12"/></linearGradient></defs><rect width="100" height="100" rx="22" fill="url(#d)"/><circle cx="50" cy="52" r="22" fill="rgba(255,255,255,0.12)"/><circle cx="50" cy="55" r="14" fill="rgba(255,255,255,0.2)"/><rect x="22" y="78" width="56" height="3" rx="1.5" fill="rgba(255,255,255,0.25)"/></svg>') },
    { name: '粒子', svg: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><radialGradient id="e" cx="50%" cy="50%"><stop offset="0%" stop-color="#818cf8"/><stop offset="100%" stop-color="#312e81"/></radialGradient></defs><rect width="100" height="100" rx="22" fill="url(#e)"/><circle cx="50" cy="50" r="5" fill="#fff" opacity="0.9"/><circle cx="50" cy="50" r="12" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="1.5"/><circle cx="50" cy="50" r="20" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1"/><circle cx="32" cy="52" r="2" fill="rgba(255,255,255,0.4)"/><circle cx="68" cy="48" r="2.5" fill="rgba(255,255,255,0.35)"/><circle cx="45" cy="38" r="1.5" fill="rgba(255,255,255,0.3)"/></svg>') },
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
