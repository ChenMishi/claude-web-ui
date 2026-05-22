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
