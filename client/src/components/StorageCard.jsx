import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { getStorageInfo, cleanStorage } from '../api';
import { IconFolder, IconChevronDown, IconChevronRight } from './icons';

function fmtSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

export default function StorageCard() {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [otherExpanded, setOtherExpanded] = useState(false);
  const [cleaning, setCleaning] = useState(null); // key or 'all-artifacts'

  // Password modal state
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const passwordRef = useRef(null);

  const loadInfo = useCallback(async () => {
    setLoading(true); setError('');
    try { const d = await getStorageInfo(); setInfo(d); } catch (err) { setError(err.message); }
    setLoading(false);
  }, []);

  useEffect(() => { loadInfo(); }, [loadInfo]);

  const handleClean = async (targets, label, pwd) => {
    setCleaning(label);
    setError('');
    try { await cleanStorage(targets, pwd); await loadInfo(); } catch (err) { setError(err.message); }
    setCleaning(null);
  };

  const handleChatRecordsClean = () => {
    setPassword('');
    setPasswordError('');
    setShowPasswordModal(true);
    setTimeout(() => passwordRef.current?.focus(), 100);
  };

  const confirmChatRecordsClean = () => {
    if (!password.trim()) {
      setPasswordError('请输入管理员密码');
      return;
    }
    setShowPasswordModal(false);
    handleClean(['chat-records'], 'chat-records', password);
  };

  const handlePasswordKeyDown = (e) => {
    if (e.key === 'Enter') confirmChatRecordsClean();
    if (e.key === 'Escape') setShowPasswordModal(false);
  };

  if (!info && !loading) {
    return (
      <div className="settings-card">
        <div className="settings-card-header"><IconFolder/> 存储管理</div>
        <div className="settings-card-body">
          {error && <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 8 }}>{error}</div>}
          <button className="init-btn init-btn-test" onClick={loadInfo} style={{ padding: '6px 14px', fontSize: 12, borderRadius: 6 }}>加载存储信息</button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <IconFolder/> 存储管理
        {info && <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>总计 {fmtSize(info.total)}</span>}
      </div>
      <div className="settings-card-body">
        {error && <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 8 }}>{error}</div>}

        {loading && !info && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>加载中...</div>}

        {info && (
          <div className="storage-list">
            {/* ── 聊天记录 ── */}
            <div className="storage-row">
              <span className="storage-icon">💬</span>
              <span className="storage-label">聊天记录</span>
              <span className="storage-desc">会话历史，清理需验证管理员密码</span>
              <span className="storage-size">{fmtSize(info.chatRecords.size)}</span>
              <button
                className="init-btn init-btn-install storage-clean-btn"
                disabled={cleaning === 'chat-records' || info.chatRecords.size === 0}
                onClick={handleChatRecordsClean}
              >
                {cleaning === 'chat-records' ? '清理中...' : '清理'}
              </button>
            </div>

            {/* ── 产物文件 ── */}
            <div className="storage-row">
              <span className="storage-icon">📦</span>
              <span className="storage-label">产物文件</span>
              <span className="storage-desc">工具生成的临时产物 (tool-results, subagents)</span>
              <span className="storage-size">{fmtSize(info.artifacts.size)}</span>
              <button
                className="init-btn init-btn-install storage-clean-btn"
                disabled={cleaning === 'artifacts' || info.artifacts.size === 0}
                onClick={() => handleClean(['tool-results', 'subagents'], 'artifacts')}
              >
                {cleaning === 'artifacts' ? '清理中...' : '清理'}
              </button>
            </div>

            {/* ── 其它文件缓存 ── */}
            <div className="storage-category">
              <div className="storage-row storage-row-clickable" onClick={() => setOtherExpanded(!otherExpanded)}>
                <span className="storage-icon">{otherExpanded ? <IconChevronDown size={12}/> : <IconChevronRight size={12}/>}</span>
                <span className="storage-label">其它文件缓存</span>
                <span className="storage-desc">遥测、日志、快照等临时缓存</span>
                <span className="storage-size">{fmtSize(info.otherCache.size)}</span>
                <button
                  className="init-btn init-btn-install storage-clean-btn"
                  disabled={cleaning === 'other' || info.otherCache.size === 0}
                  onClick={(e) => { e.stopPropagation(); handleClean(info.otherCache.items.map(i => i.key), 'other'); }}
                >
                  {cleaning === 'other' ? '清理中...' : '全部清理'}
                </button>
              </div>

              {otherExpanded && info.otherCache.items.length > 0 && (
                <div className="storage-detail-list">
                  {info.otherCache.items.map(item => (
                    <div key={item.key} className="storage-detail-row">
                      <span className="storage-detail-label">{item.label}</span>
                      <span className="storage-detail-path" title={item.path}>{item.path}</span>
                      <span className="storage-detail-size">{fmtSize(item.size)}</span>
                      <button
                        className="init-btn init-btn-test storage-clean-btn-small"
                        disabled={cleaning === item.key}
                        onClick={() => handleClean([item.key], item.key)}
                      >
                        {cleaning === item.key ? '...' : '清理'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {info && (
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className="init-btn init-btn-test" onClick={loadInfo} style={{ padding: '6px 14px', fontSize: 12, borderRadius: 6 }}>
              {loading ? '刷新中...' : '刷新'}
            </button>
          </div>
        )}
      </div>

      {/* ── 密码验证弹窗 (Portal 到 body，避免受卡片 CSS 影响) ── */}
      {showPasswordModal && createPortal(
        <div className="storage-password-overlay" onClick={() => setShowPasswordModal(false)}>
          <div className="storage-password-modal" onClick={e => e.stopPropagation()}>
            <div className="storage-password-title">验证管理员密码</div>
            <div className="storage-password-desc">清理聊天记录需要验证管理员身份，请输入当前管理员密码。</div>
            <input
              ref={passwordRef}
              type="password"
              className="storage-password-input"
              placeholder="请输入管理员密码"
              autoComplete="off"
              value={password}
              onChange={e => { setPassword(e.target.value); setPasswordError(''); }}
              onKeyDown={handlePasswordKeyDown}
            />
            {passwordError && <div className="storage-password-error">{passwordError}</div>}
            <div className="storage-password-actions">
              <button className="init-btn init-btn-test" onClick={() => setShowPasswordModal(false)}>取消</button>
              <button className="init-btn init-btn-install" onClick={confirmChatRecordsClean}>确认清理</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
