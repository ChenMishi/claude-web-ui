import { useApp } from '../context/AppContext';

const THEMES = [
  { key: 'dark', label: '深色', icon: '🌙', desc: '深蓝紫暗色主题' },
  { key: 'light', label: '白色', icon: '☀️', desc: '明亮白底主题' },
  { key: 'warm', label: '暖色', icon: '🍂', desc: '柔和暖色调主题' },
];

export default function SettingsPanel() {
  const { model, systemPrompt, theme, setSetting, projects, currentProjectId } = useApp();

  const project = projects.find(p => p.id === currentProjectId);

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
        <label>System Prompt</label>
        <textarea
          value={systemPrompt}
          onChange={e => setSetting('systemPrompt', e.target.value)}
          placeholder="自定义 system prompt（留空使用默认）"
        />
      </div>

      {/* ── Theme Switcher ── */}
      <div className="settings-group">
        <label>主题</label>
        <div className="theme-switcher">
          {THEMES.map(t => (
            <button
              key={t.key}
              className={`theme-btn ${theme === t.key ? 'active' : ''}`}
              onClick={() => setSetting('theme', t.key)}
              title={t.desc}
            >
              <span className="theme-btn-icon">{t.icon}</span>
              <span className="theme-btn-label">{t.label}</span>
            </button>
          ))}
        </div>
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
    </div>
  );
}
