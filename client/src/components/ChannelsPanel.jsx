import { useState, useEffect, useCallback } from 'react';
import { getChannelTypes, getChannelStatus, saveChannel, toggleChannel, deleteChannel } from '../api';
import { IconZap } from './icons';

export default function ChannelsPanel() {
  const [types, setTypes] = useState([]);          // [{ type, label, configSchema }]
  const [channels, setChannels] = useState([]);    // [{ id, name, type, enabled, status }]
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);    // null | { type, id?, name, ...config }
  const [saveMsg, setSaveMsg] = useState('');
  const [confirmDel, setConfirmDel] = useState(null);

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
    try {
      await toggleChannel(id);
      load();
    } catch (err) {
      setSaveMsg('❌ ' + err.message);
      setTimeout(() => setSaveMsg(''), 3000);
    }
  };

  const handleDelete = async (id) => {
    setConfirmDel(null);
    try {
      await deleteChannel(id);
      load();
    } catch (err) {
      setSaveMsg('❌ ' + err.message);
      setTimeout(() => setSaveMsg(''), 3000);
    }
  };

  const typeLabel = (t) => {
    const found = types.find(tt => tt.type === t);
    return found?.label || t;
  };

  return (
    <div className="channels-panel">
      <h2><IconZap/> 消息渠道</h2>

      {/* ── Existing channels ── */}
      <div className="settings-group">
        <label>已配置的渠道</label>
        {loading ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>加载中...</div>
        ) : channels.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '12px 0' }}>
            暂无渠道，点击下方添加
          </div>
        ) : (
          channels.map(ch => (
            <div key={ch.id} className="channel-card">
              <div className="channel-card-info">
                <div className="channel-card-name">{ch.name}</div>
                <div className="channel-card-meta">
                  <span className="channel-card-type">{typeLabel(ch.type)}</span>
                  <span className={`channel-card-status ${ch.status}`}>
                    {ch.status === 'running' ? '● 运行中' : '○ 已停止'}
                  </span>
                </div>
              </div>
              <div className="channel-card-actions">
                <button
                  className={`channel-toggle ${ch.enabled ? 'on' : 'off'}`}
                  onClick={() => handleToggle(ch.id)}
                >
                  {ch.enabled ? '禁用' : '启用'}
                </button>
                <button className="channel-edit" onClick={() => {
                  const schema = (types.find(t => t.type === ch.type)?.configSchema || []);
                  const init = { id: ch.id, type: ch.type, name: ch.name, enabled: ch.enabled };
                  schema.forEach(f => { init[f.key] = ch[f.key] !== undefined ? ch[f.key] : (f.default || ''); });
                  setEditing(init);
                }}>编辑</button>
                <button className="channel-del" onClick={() => setConfirmDel(ch.id)}>删除</button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* ── Add new channel ── */}
      <div className="settings-group">
        <label>{editing?.id ? '编辑渠道' : '添加渠道'}</label>

        {!editing ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {types.map(t => (
              <button
                key={t.type}
                onClick={() => {
                  const init = { type: t.type, name: '', enabled: true };
                  t.configSchema.forEach(f => { init[f.key] = f.default || ''; });
                  setEditing(init);
                }}
                style={{
                  padding: '8px 14px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
                  background: 'var(--bg-secondary)', color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                }}
              >
                ＋ {t.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="channel-form">
            <div className="channel-form-row">
              <label>渠道名称</label>
              <input
                type="text"
                value={editing.name || ''}
                onChange={e => setEditing(prev => ({ ...prev, name: e.target.value }))}
                placeholder="如：我的企微Bot"
              />
            </div>

            {/* Render config schema fields */}
            {(types.find(t => t.type === editing.type)?.configSchema || []).map(f => (
              <div key={f.key} className="channel-form-row">
                <label>{f.label}{f.required ? ' *' : ''}</label>
                <input
                  type={f.secret ? 'password' : 'text'}
                  value={editing[f.key] || ''}
                  onChange={e => setEditing(prev => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder={f.placeholder || ''}
                />
              </div>
            ))}

            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                onClick={handleSave}
                style={{
                  padding: '6px 18px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
                  background: 'var(--accent)', color: '#fff', border: 'none',
                }}
              >
                保存
              </button>
              <button
                onClick={() => setEditing(null)}
                style={{
                  padding: '6px 18px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
                  background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border)',
                }}
              >
                取消
              </button>
              {saveMsg && (
                <span style={{ fontSize: 12, color: saveMsg.startsWith('✅') ? 'var(--success)' : 'var(--danger)', alignSelf: 'center' }}>
                  {saveMsg}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Delete confirmation ── */}
      {confirmDel && (
        <div style={{ marginTop: 8, padding: 10, borderRadius: 6, background: 'rgba(255,100,100,0.08)', border: '1px solid rgba(255,100,100,0.2)', fontSize: 12 }}>
          <div style={{ marginBottom: 8 }}>确定删除此渠道？</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => handleDelete(confirmDel)}
              style={{ padding: '4px 14px', fontSize: 12, borderRadius: 4, background: 'var(--danger)', color: '#fff', border: 'none', cursor: 'pointer' }}>
              确定
            </button>
            <button onClick={() => setConfirmDel(null)}
              style={{ padding: '4px 14px', fontSize: 12, borderRadius: 4, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-primary)', cursor: 'pointer' }}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* ── Usage guide ── */}
      <div className="settings-group" style={{ marginTop: 24 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.8 }}>
          <strong>企业微信接入指引：</strong><br />
          1. 企微客户端 → 工作台 → 智能机器人 → 手动创建<br />
          2. 选择 <strong>API 模式</strong>创建，连接方式选<strong>「使用长连接」</strong><br />
          3. 获取 <strong>Bot ID</strong> 和 <strong>Secret</strong>（Secret 仅显示一次）<br />
          4. 填入上方表单，保存并启用即可<br />
          5. 无需公网域名、HTTPS 证书或 CorpID
        </div>
      </div>
    </div>
  );
}
