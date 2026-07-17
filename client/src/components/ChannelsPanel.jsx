import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { getChannelTypes, getChannelStatus, saveChannel, toggleChannel, deleteChannel } from '../api';
import { IconPuzzle } from './icons';

export default function ChannelsPanel() {
  const [types, setTypes] = useState([]);
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [saveMsg, setSaveMsg] = useState('');
  const [confirmDel, setConfirmDel] = useState(null); // { id, x, y }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, c] = await Promise.all([
        getChannelTypes().catch(() => ({ types: [] })),
        getChannelStatus().catch(() => ({ channels: [] })),
      ]);
      setTypes(t.types || []);
      setChannels(c.channels || []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    if (!editing) return;
    try {
      const d = await saveChannel(editing);
      if (d.ok) {
        setSaveMsg('✅ 已保存');
        setTimeout(() => setSaveMsg(''), 2500);
        setEditing(null);
        load();
      } else {
        setSaveMsg('❌ ' + (d.error || '保存失败'));
      }
    } catch (err) {
      setSaveMsg('❌ ' + err.message);
    }
  };

  const handleToggle = async (id) => {
    try { await toggleChannel(id); load(); }
    catch (err) { setSaveMsg('❌ ' + err.message); setTimeout(() => setSaveMsg(''), 3000); }
  };

  const handleDelete = async (id) => {
    setConfirmDel(null);
    try { await deleteChannel(id); load(); }
    catch (err) { setSaveMsg('❌ ' + err.message); setTimeout(() => setSaveMsg(''), 3000); }
  };

  const typeLabel = (t) => (types.find(tt => tt.type === t) || {}).label || t;

  return (
    <div className="channels-panel">
      <h2><IconPuzzle/> 消息渠道</h2>

      {/* ── 已配置的渠道 ── */}
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 10, marginTop: 4 }}><IconPuzzle/> 已配置的渠道</div>
      {loading
        ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>加载中...</div>
        : channels.length === 0
        ? <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '12px 0' }}>暂无渠道，点击下方添加</div>
        : channels.map(ch => (
            <div key={ch.id} className="settings-card channel-item-card" style={{ marginBottom: 8 }}>
              <div className="settings-card-body" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                <div style={{ textAlign: 'left' }}>
                  <div className="channel-card-name">{ch.name}</div>
                  <div className="channel-card-meta">
                    <span className="channel-card-type">{typeLabel(ch.type)}</span>
                    <span className={`channel-card-status ${ch.status}`}>
                      {ch.status === 'running' ? '● 运行中' : ch.status === 'connecting' ? '◎ 连接中' : ch.status === 'error' ? '✕ 连接失败' : '○ 已停止'}
                    </span>
                  </div>
                </div>
                <div className="channel-card-actions" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                  <button className={`channel-toggle ${ch.enabled ? 'on' : 'off'}`} onClick={() => handleToggle(ch.id)}>
                    {ch.enabled ? '禁用' : '启用'}
                  </button>
                  <button className="channel-edit" onClick={() => {
                    const schema = (types.find(t => t.type === ch.type)?.configSchema || []);
                    const init = { id: ch.id, type: ch.type, name: ch.name, enabled: ch.enabled };
                    schema.forEach(f => { init[f.key] = ch[f.key] !== undefined ? ch[f.key] : (f.default || ''); });
                    setEditing(init);
                  }}>编辑</button>
                  <button className="channel-del" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setConfirmDel({ id: ch.id, x: r.left + r.width / 2, y: r.top }); }}>删除</button>
                </div>
              </div>
            </div>
          ))}

      {/* ── Card: 添加/编辑渠道 ── */}
      <div className="settings-card">
        <div className="settings-card-header"><IconPuzzle/> {editing?.id ? '编辑渠道' : '添加渠道'}</div>
        <div className="settings-card-body">
          {!editing ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {types.map(t => (
                <button key={t.type} onClick={() => {
                  const init = { type: t.type, name: '', enabled: true };
                  t.configSchema.forEach(f => { init[f.key] = f.default || ''; });
                  setEditing(init);
                }} style={{
                  padding: '8px 16px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
                  background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)',
                }}>＋ {t.label}</button>
              ))}
            </div>
          ) : (
            <div className="channel-form">
              <div className="settings-row">
                <label>渠道名称</label>
                <input type="text" value={editing.name || ''} onChange={e => setEditing(prev => ({ ...prev, name: e.target.value }))} placeholder="如：我的企微Bot" />
              </div>
              {(types.find(t => t.type === editing.type)?.configSchema || []).map(f => (
                <div key={f.key} className="settings-row">
                  <label>{f.label}{f.required ? ' *' : ''}</label>
                  <input type={f.secret ? 'password' : 'text'} value={editing[f.key] || ''} onChange={e => setEditing(prev => ({ ...prev, [f.key]: e.target.value }))} placeholder={f.placeholder || ''} />
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                <button onClick={handleSave} className="init-btn init-btn-save" style={{ fontSize: 12 }}>保存</button>
                <button onClick={() => setEditing(null)} className="init-btn" style={{ fontSize: 12 }}>取消</button>
                {saveMsg && <span style={{ fontSize: 12, color: saveMsg.startsWith('✅') ? 'var(--success)' : 'var(--danger)' }}>{saveMsg}</span>}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── 接入指引 ── */}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.8, marginTop: 16 }}>
        <strong>企业微信接入指引：</strong><br />
        1. 企微客户端 → 工作台 → 智能机器人 → 手动创建<br />
        2. 选择 <strong>API 模式</strong>创建，连接方式选<strong>「使用长连接」</strong><br />
        3. 获取 <strong>Bot ID</strong> 和 <strong>Secret</strong>（Secret 仅显示一次）<br />
        4. 填入上方表单，保存并启用即可<br />
        5. 无需公网域名、HTTPS 证书或 CorpID
      </div>

      {/* Inline confirmation popup */}
      {confirmDel && createPortal(
        <div className="confirm-popup-overlay" onClick={() => setConfirmDel(null)}>
          <div className="confirm-popup" style={{ left: confirmDel.x, top: confirmDel.y - 10 }} onClick={e => e.stopPropagation()}>
            <div className="confirm-popup-text">确定删除此渠道？</div>
            <div className="confirm-popup-actions">
              <button className="confirm-popup-cancel" onClick={() => setConfirmDel(null)}>取消</button>
              <button className="confirm-popup-ok" onClick={() => handleDelete(confirmDel.id)}>确定</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
