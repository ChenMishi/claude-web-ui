import { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { getSkill, createSkill, updateSkill, listModels, parseSkillMd, importSkillFile } from '../api';

const TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'NotebookEdit'];
const CATEGORIES = ['开发', '运维', '文档', '安全', '其他'];
const ICONS = ['🔍', '📄', '🧪', '🚀', '🐳', '📋', '🎯', '🔒', '📊', '🛠', '📝', '💡', '🔧', '⚡', '🎨'];
const PERM_MODES = [
  { value: 'acceptEdits', label: '仅编辑需确认' },
  { value: 'bypassPermissions', label: '全部自动执行' },
  { value: 'default', label: '全部需确认' },
];

export default function SkillEditor({ skill, projectDir, onClose }) {
  const { user } = useApp();
  const isAdmin = user?.role === 'admin';
  const isEdit = !!skill;

  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('🔧');
  const [category, setCategory] = useState('其他');
  const [model, setModel] = useState('');
  const [allowedTools, setAllowedTools] = useState([]);
  const [deniedTools, setDeniedTools] = useState([]);
  const [permissionMode, setPermissionMode] = useState('acceptEdits');
  const [body, setBody] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [author, setAuthor] = useState('');
  const [targetScope, setTargetScope] = useState('personal');
  const [availableModels, setAvailableModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [importMsg, setImportMsg] = useState('');
  const fileInputRef = useRef(null);

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportMsg('');
    setError('');
    try {
      const ext = file.name.split('.').pop().toLowerCase();
      let result;
      if (ext === 'md') {
        const text = await file.text();
        result = await parseSkillMd(text);
      } else if (['zip', 'gz', 'tgz', 'tar'].includes(ext)) {
        setImportMsg('正在解压并解析...');
        result = await importSkillFile(file);
      } else {
        setError(`不支持的文件格式: .${ext}，请上传 .md / .zip / .tar.gz`);
        e.target.value = '';
        return;
      }
      const meta = result.meta || {};
      if (meta.name) setName(meta.name);
      if (meta.displayName) setDisplayName(meta.displayName);
      if (meta.description) setDescription(meta.description);
      if (meta.icon) setIcon(meta.icon);
      if (meta.category) setCategory(meta.category);
      if (meta.model) setModel(meta.model);
      if (Array.isArray(meta.allowedTools)) setAllowedTools(meta.allowedTools);
      if (Array.isArray(meta.deniedTools)) setDeniedTools(meta.deniedTools);
      if (meta.permissionMode) setPermissionMode(meta.permissionMode);
      if (meta.version) setVersion(meta.version);
      if (meta.author) setAuthor(meta.author);
      if (result.body) setBody(result.body);
      setImportMsg(`✅ 已导入: ${meta.displayName || meta.name || file.name}`);
      setTimeout(() => setImportMsg(''), 4000);
    } catch (err) {
      setError(`导入失败: ${err.message}`);
    }
    // Reset file input so same file can be re-imported
    e.target.value = '';
  };

  useEffect(() => {
    // Load available models
    listModels().then(d => setAvailableModels(d.models || [])).catch(() => {});

    if (skill) {
      setLoading(true);
      getSkill(skill.name, projectDir)
        .then(d => {
          const s = d.skill;
          setName(s.name || '');
          setDisplayName(s.displayName || '');
          setDescription(s.description || '');
          setIcon(s.icon || '🔧');
          setCategory(s.category || '其他');
          setModel(s.model || '');
          setAllowedTools(s.allowedTools || []);
          setDeniedTools(s.deniedTools || []);
          setPermissionMode(s.permissionMode || 'acceptEdits');
          setBody(s.body || '');
          setVersion(s.version || '1.0.0');
          setAuthor(s.author || '');
        })
        .catch(err => setError(err.message))
        .finally(() => setLoading(false));
    }
  }, [skill, projectDir]);

  const toggleTool = (tool, setter) => {
    setter(prev =>
      prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]
    );
  };

  const handleSave = async () => {
    if (!name.trim() || !displayName.trim() || !body.trim()) {
      setError('名称、显示名称和技能内容不能为空');
      return;
    }

    const meta = {
      name: name.trim(),
      displayName: displayName.trim(),
      description: description.trim(),
      icon,
      category,
      model: model || null,
      allowedTools,
      deniedTools,
      permissionMode,
      version,
      author: author || user?.username || 'unknown',
    };

    setSaving(true);
    setError('');
    try {
      if (isEdit) {
        await updateSkill(skill.name, { ...meta, body }, projectDir);
      } else {
        await createSkill({ ...meta, body, targetScope });
      }
      onClose(true);
    } catch (err) {
      setError(err.message);
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="dialog-overlay">
        <div className="skills-editor-modal" onClick={e => e.stopPropagation()}>
          <div className="skills-loading">加载中...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="dialog-overlay">
      <div className="skills-editor-modal" onClick={e => e.stopPropagation()}>
        <div className="skills-editor-header">
          <h3>{isEdit ? '编辑技能' : '新建技能'}</h3>
          <input type="file" ref={fileInputRef} accept=".md,.zip,.tar.gz,.tgz,.tar" style={{ display: 'none' }} onChange={handleImportFile} />
          <button className="skills-editor-close" onClick={() => onClose(false)}>✕</button>
        </div>

        {!isEdit && (
          <div style={{ padding: '0 24px 12px' }}>
            <button className="skills-editor-import-btn"
              onClick={() => fileInputRef.current?.click()}
              title="从 .md / .zip / .tar.gz 文件导入技能配置">
              📥 从文件导入（支持 .md / .zip / .tar.gz）
            </button>
          </div>
        )}

        {importMsg && <div className="skills-editor-msg success">{importMsg}</div>}

        <div className="skills-editor-body">
          <div className="skills-editor-row">
            <div className="skills-editor-field">
              <label>名称</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)}
                placeholder="英文标识，如 code-review" disabled={isEdit} />
            </div>
            <div className="skills-editor-field">
              <label>显示名称</label>
              <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)}
                placeholder="中文名称，如 代码审查" />
            </div>
          </div>

          <div className="skills-editor-row">
            <div className="skills-editor-field">
              <label>描述</label>
              <input type="text" value={description} onChange={e => setDescription(e.target.value)}
                placeholder="简短描述这个技能的作用" />
            </div>
          </div>

          <div className="skills-editor-row">
            <div className="skills-editor-field">
              <label>图标</label>
              <div className="skills-icon-picker">
                {ICONS.map(i => (
                  <button key={i} className={icon === i ? 'active' : ''} onClick={() => setIcon(i)}>{i}</button>
                ))}
              </div>
            </div>
          </div>

          <div className="skills-editor-row">
            <div className="skills-editor-field">
              <label>分类</label>
              <select value={category} onChange={e => setCategory(e.target.value)}>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="skills-editor-field">
              <label>权限模式</label>
              <select value={permissionMode} onChange={e => setPermissionMode(e.target.value)}>
                {PERM_MODES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div className="skills-editor-field">
              <label>推荐模型</label>
              <select value={model} onChange={e => setModel(e.target.value)}>
                <option value="">使用当前模型</option>
                {availableModels.length > 0 ? (
                  availableModels.map(m => <option key={m} value={m}>{m}</option>)
                ) : (
                  <>
                    <option value="claude-opus-4-7">Claude Opus 4.7</option>
                    <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
                    <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
                  </>
                )}
                {model && !availableModels.includes(model) && availableModels.length > 0 && (
                  <option value={model}>{model} (当前技能设定)</option>
                )}
              </select>
            </div>
          </div>

          <div className="skills-editor-field">
            <label>允许使用的工具（白名单，不选则不做限制）</label>
            <div className="skills-tool-grid">
              {TOOLS.map(t => (
                <button
                  key={t}
                  className={`skills-tool-chip ${allowedTools.includes(t) ? 'active' : ''}`}
                  onClick={() => toggleTool(t, setAllowedTools)}
                >{t}</button>
              ))}
            </div>
          </div>

          <div className="skills-editor-field">
            <label>禁止使用的工具（黑名单）</label>
            <div className="skills-tool-grid">
              {TOOLS.map(t => (
                <button
                  key={t}
                  className={`skills-tool-chip deny ${deniedTools.includes(t) ? 'active' : ''}`}
                  onClick={() => toggleTool(t, setDeniedTools)}
                >{t}</button>
              ))}
            </div>
          </div>

          <div className="skills-editor-field">
            <label>技能 System Prompt（核心内容，定义 Claude 的行为规则）</label>
            <textarea
              className="skills-body-editor"
              value={body}
              onChange={e => setBody(e.target.value)}
              placeholder="在此编写技能的 system prompt。激活此技能后，这段内容将作为 Claude 的系统提示词。&#10;&#10;示例：&#10;你是一名资深代码审查员。你的任务是...&#10;&#10;审查清单：&#10;1. 安全漏洞&#10;2. 性能问题&#10;3. 代码规范"
              rows={12}
            />
          </div>

          {!isEdit && isAdmin && (
            <div className="skills-editor-field">
              <label>安装到</label>
              <select value={targetScope} onChange={e => setTargetScope(e.target.value)}>
                <option value="personal">个人技能</option>
                <option value="shared">共享技能（所有用户可用）</option>
              </select>
            </div>
          )}

          {isEdit && (
            <div className="skills-editor-row">
              <div className="skills-editor-field">
                <label>版本号</label>
                <input type="text" value={version} onChange={e => setVersion(e.target.value)} placeholder="1.0.0" />
              </div>
              <div className="skills-editor-field">
                <label>作者</label>
                <input type="text" value={author} disabled />
              </div>
            </div>
          )}
        </div>

        {error && <div className="skills-editor-error">{error}</div>}

        <div className="skills-editor-footer">
          <button className="skills-editor-cancel" onClick={() => onClose(false)}>取消</button>
          <button className="skills-editor-save" onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
