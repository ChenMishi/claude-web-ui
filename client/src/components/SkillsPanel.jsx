import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../context/AppContext';
import { listSkills, deleteSkillApi, installPlugin, uninstallPlugin as uninstallPluginApi, getPluginInfo, getPluginStatus, toggleKarpathySkills, toggleSuperpowers, authHeaders } from '../api';
import SkillEditor from './SkillEditor';
import { IconPuzzle, IconPackage } from './icons';

const STORAGE_KEY = 'claude-web-ui-plugins';

// Superpowers skills are plugin-managed — hide from skill lists.
// dispatching-parallel-agents and subagent-driven-development excluded: they use
// background Agent dispatch which doesn't work in the Web UI SDK context.
const _spSkills = new Set(['brainstorming','executing-plans','finishing-a-development-branch','receiving-code-review','requesting-code-review','systematic-debugging','test-driven-development','using-git-worktrees','using-superpowers','verification-before-completion','writing-plans','writing-skills']);

// ── Built-in plugins (always present in card list) ──
const BUILTIN_PLUGINS = [
  {
    id: 'superpowers',
    name: 'Superpowers',
    displayName: 'Superpowers',
    description: 'AI 编程工作流技能库，强制 TDD + 头脑风暴 + 代码审查流程，让 Claude 像资深工程师一样干活。支持 Claude Code / Codex / Cursor / Gemini CLI 等 10+ 工具。',
    icon: '⚡',
    author: 'Jesse Vincent (obra)',
    githubUrl: 'https://github.com/obra/superpowers',
    builtin: true,
  },
  {
    id: 'agency-agents-zh',
    name: 'Agency Agents ZH',
    displayName: 'Agency Agents 中文版',
    description: '266 个即插即用的 AI 专家角色，覆盖工程/设计/营销/产品等 20 个部门。含 50 个中国市场原创角色（小红书/抖音/飞书/钉钉等），配套编排器支持 DAG 自动协作。',
    icon: '🎭',
    author: 'jnMetaCode',
    githubUrl: 'https://github.com/jnMetaCode/agency-agents-zh',
    builtin: true,
  },
  {
    id: 'andrej-karpathy-skills',
    name: 'Karpathy Skills',
    displayName: 'Karpathy 编码规范',
    description: 'Andrej Karpathy 总结的 AI Agent 编码行为准则，4 条核心原则：先想再写、简洁优先、手术式修改、目标驱动执行。启用后自动追加到项目 CLAUDE.md。',
    icon: '🧠',
    author: 'Andrej Karpathy / multica-ai',
    githubUrl: 'https://github.com/multica-ai/andrej-karpathy-skills',
    builtin: true,
    karpathy: true,  // special toggle: append/remove CLAUDE.md section
  },
];

// ── Load plugin state from localStorage ──
function loadPluginState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch { return {}; }
}

function savePluginState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

export default function SkillsPanel() {
  const { user, currentProjectId, projects } = useApp();
  const isAdmin = user?.role === 'admin';
  const project = projects.find(p => p.id === currentProjectId);
  const projectDir = project?.cwd || null;

  const [tab, setTab] = useState('my'); // 'my' | 'plugins'
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState(null);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);

  // ── Plugin state ──
  const [pluginState, setPluginState] = useState(() => loadPluginState());
  const [pluginDiskStatus, setPluginDiskStatus] = useState({}); // {superpowers: true/false, ...}
  const [pluginInstallLoading, setPluginInstallLoading] = useState({});
  const [showAddPlugin, setShowAddPlugin] = useState(false);
  const [newPluginUrl, setNewPluginUrl] = useState('');
  const [addingPlugin, setAddingPlugin] = useState(false);
  const [pluginDetail, setPluginDetail] = useState(null);

  // Check actual disk installation status of builtin plugins
  useEffect(() => {
    getPluginStatus().then(d => setPluginDiskStatus(d.plugins || {})).catch(() => {});
  }, []);

  // Merge builtin plugins + user plugins + state
  // Disk status overrides default only when user has NOT explicitly set state in localStorage
  const allPlugins = (() => {
    const map = new Map();
    for (const bp of BUILTIN_PLUGINS) {
      const state = pluginState[bp.id];
      const hasExplicitState = state && ('installed' in state);
      const diskInstalled = pluginDiskStatus[bp.id];
      // Use disk status only when: no explicit state AND disk status is available
      const defaultInstalled = diskInstalled !== undefined ? diskInstalled : true;
      map.set(bp.id, {
        ...bp,
        installed: hasExplicitState ? !!state.installed : defaultInstalled,
        enabled: hasExplicitState ? (state.enabled !== false) : defaultInstalled,
      });
    }
    // User-added plugins
    for (const [id, st] of Object.entries(pluginState)) {
      if (!map.has(id) && st.userAdded) {
        map.set(id, {
          id,
          name: st.name || id,
          displayName: st.displayName || st.name || id,
          description: st.description || '',
          icon: st.icon || '📦',
          author: st.author || '',
          githubUrl: st.githubUrl || '',
          installed: !!st.installed,
          enabled: st.enabled !== false,
          builtin: false,
          userAdded: true,
        });
      }
    }
    return Array.from(map.values());
  })();

  // ── Persist plugin state to localStorage ──
  const persistPlugins = useCallback((update) => {
    setPluginState(prev => {
      const next = { ...prev, ...update };
      savePluginState(next);
      return next;
    });
  }, []);

  const loadSkills = useCallback(() => {
    setLoading(true);
    listSkills(projectDir)
      .then(d => setSkills((d.skills || []).filter(s => !_spSkills.has(s.name))))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [projectDir]);

  useEffect(() => { loadSkills(); }, [loadSkills]);

  // ── Skill handlers ──
  const handleDelete = (e, name) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setConfirmDelete({ type: 'skill', name, x: rect.left + rect.width / 2, y: rect.top });
  };

  const handleConfirmDelete = async () => {
    const item = confirmDelete;
    if (!item) return;
    setConfirmDelete(null);
    if (item.type === 'skill') {
      try { await deleteSkillApi(item.name, projectDir); loadSkills(); }
      catch (err) { setError(err.message); }
    } else if (item.type === 'plugin') {
      const updated = { ...pluginState };
      delete updated[item.id];
      savePluginState(updated);
      setPluginState(updated);
    }
  };

  const handleEdit = (skill) => { setEditingSkill(skill); setEditorOpen(true); };
  const handleCreate = () => { setEditingSkill(null); setEditorOpen(true); };

  const handleEditorClose = (saved) => {
    setEditorOpen(false); setEditingSkill(null);
    if (saved) loadSkills();
  };

  const handleExport = async (skill) => {
    const r = await fetch(`/api/skills/${encodeURIComponent(skill.name)}/export`, { headers: authHeaders({}) });
    if (!r.ok) { alert('导出失败'); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${skill.name}.md`; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Plugin handlers ──
  const handleInstallPlugin = async (plugin) => {
    setPluginInstallLoading(prev => ({ ...prev, [plugin.id]: true }));
    setError('');
    try {
      await installPlugin(plugin.githubUrl, plugin.id);
      persistPlugins({ [plugin.id]: { ...pluginState[plugin.id], installed: true, enabled: true } });
    } catch (err) {
      setError(err.message);
    } finally {
      setPluginInstallLoading(prev => ({ ...prev, [plugin.id]: false }));
    }
  };

  const handleTogglePlugin = async (plugin) => {
    const newEnabled = !plugin.enabled;

    // Karpathy: toggle appends/removes guidelines from project CLAUDE.md
    if (plugin.karpathy) {
      setError('');
      try {
        await toggleKarpathySkills(newEnabled);
      } catch (err) {
        setError(err.message);
        return;
      }
    }

    // Superpowers: toggle registers/unregisters with Claude Code plugins dir
    if (plugin.id === 'superpowers') {
      setError('');
      try {
        await toggleSuperpowers(newEnabled);
      } catch (err) {
        setError(err.message);
        return;
      }
    }

    persistPlugins({ [plugin.id]: { ...pluginState[plugin.id], installed: plugin.installed, enabled: newEnabled, userAdded: plugin.userAdded || undefined, name: plugin.userAdded ? plugin.name : undefined, displayName: plugin.userAdded ? plugin.displayName : undefined, description: plugin.userAdded ? plugin.description : undefined, icon: plugin.userAdded ? plugin.icon : undefined, author: plugin.userAdded ? plugin.author : undefined, githubUrl: plugin.userAdded ? plugin.githubUrl : undefined } });
  };

  const handleUninstallPlugin = async (plugin) => {
    setPluginInstallLoading(prev => ({ ...prev, [plugin.id]: true }));
    setError('');
    try {
      await uninstallPluginApi(plugin.id);
      persistPlugins({ [plugin.id]: { ...pluginState[plugin.id], installed: false, enabled: false, userAdded: plugin.userAdded || undefined, name: plugin.userAdded ? plugin.name : undefined, displayName: plugin.userAdded ? plugin.displayName : undefined, description: plugin.userAdded ? plugin.description : undefined, icon: plugin.userAdded ? plugin.icon : undefined, author: plugin.userAdded ? plugin.author : undefined, githubUrl: plugin.userAdded ? plugin.githubUrl : undefined } });
    } catch (err) {
      setError(err.message);
    } finally {
      setPluginInstallLoading(prev => ({ ...prev, [plugin.id]: false }));
    }
  };

  const handleDeletePlugin = (e, plugin) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setConfirmDelete({ type: 'plugin', name: plugin.displayName, id: plugin.id, x: rect.left + rect.width / 2, y: rect.top });
  };

  const handleAddPlugin = async () => {
    const url = newPluginUrl.trim();
    if (!url) return;
    if (!url.includes('github.com')) {
      setError('请输入有效的 GitHub 仓库地址');
      return;
    }
    setAddingPlugin(true);
    setError('');
    try {
      // Extract plugin id from GitHub URL
      const match = url.match(/github\.com[/:]([^/]+)\/([^/\s#?.]+)/);
      if (!match) throw new Error('无法解析 GitHub URL');
      const pluginId = match[2].toLowerCase().replace(/\.git$/, '');

      // Check if already exists
      if (allPlugins.find(p => p.id === pluginId)) {
        throw new Error(`插件 "${pluginId}" 已存在`);
      }

      // Fetch plugin info from GitHub
      let info = {};
      try {
        const resp = await getPluginInfo(url);
        if (resp.ok && resp.info) {
          info = resp.info;
        }
      } catch {}

      const id = info.name || pluginId;
      persistPlugins({
        [id]: {
          installed: false,
          enabled: false,
          userAdded: true,
          name: id,
          displayName: info.name || pluginId,
          description: info.readmeExcerpt || info.description || '',
          icon: getTopicIcon(info.topics || []),
          author: info.fullName?.split('/')[0] || '',
          githubUrl: url,
        },
      });
      setNewPluginUrl('');
      setShowAddPlugin(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setAddingPlugin(false);
    }
  };

  // ── Plugin Detail Modal ──
  const PluginDetailModal = pluginDetail ? (() => {
    const p = pluginDetail;
    return createPortal(
      <div className="dialog-overlay" onClick={() => setPluginDetail(null)}>
        <div className="skill-detail-modal" onClick={e => e.stopPropagation()}>
          <div className="skill-detail-scroll">
            <div className="skill-detail-header">
              <div className="skill-detail-icon">{p.icon}</div>
              <div>
                <h3>{p.displayName}</h3>
                <span className="skill-detail-name-en">{p.name}{p.author ? ` · ${p.author}` : ''}</span>
              </div>
              <button className="skill-detail-close" onClick={() => setPluginDetail(null)}>✕</button>
            </div>
            <div className="skill-detail-body">
              <div className="skill-detail-section">
                <div className="skill-detail-label">简介</div>
                <p>{p.description || '暂无介绍'}</p>
              </div>
              <div className="skill-detail-info">
                <div className="skill-detail-info-item">
                  <span className="skill-detail-info-label">标识符</span>
                  <span className="skill-detail-info-value mono">{p.name}</span>
                </div>
                <div className="skill-detail-info-item">
                  <span className="skill-detail-info-label">来源</span>
                  <span className="skill-detail-info-value">{p.builtin ? '内置' : '用户添加'}</span>
                </div>
                {p.githubUrl && (
                  <div className="skill-detail-info-item" style={{ gridColumn: '1 / -1' }}>
                    <span className="skill-detail-info-label">GitHub</span>
                    <a className="skill-detail-info-value mono" href={p.githubUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>{p.githubUrl}</a>
                  </div>
                )}
                <div className="skill-detail-info-item">
                  <span className="skill-detail-info-label">状态</span>
                  <span className="skill-detail-info-value">
                    {p.installed ? (p.enabled ? '✅ 已安装 · 已启用' : '📦 已安装 · 已禁用') : '⬇️ 未安装'}
                  </span>
                </div>
              </div>
            </div>
            <div className="skill-detail-footer">
              {!p.installed ? (
                <button className="skill-detail-install" onClick={() => { setPluginDetail(null); handleInstallPlugin(p); }} disabled={pluginInstallLoading[p.id]}>
                  {pluginInstallLoading[p.id] ? '安装中…' : '安装插件'}
                </button>
              ) : (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="skill-detail-install" onClick={() => { setPluginDetail(null); handleTogglePlugin(p); }}>
                    {p.enabled ? '禁用' : '启用'}
                  </button>
                  <button className="skill-detail-install" style={{ background: 'var(--danger)', color: '#fff' }} onClick={() => { setPluginDetail(null); handleUninstallPlugin(p); }} disabled={pluginInstallLoading[p.id]}>
                    卸载
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>,
      document.body
    );
  })() : null;

  return (
    <div className="skills-panel">
      <div className="skills-panel-header">
        <h2><IconPuzzle/> 技能和插件管理</h2>
      </div>

      {error && <div className="skills-error">{error} <button onClick={() => setError('')}>✕</button></div>}

      {/* ── Unified card with tabs inside (same pattern as settings) ── */}
      <div className="skills-section">
        <div className="skills-section-tabs">
          <button className={tab === 'my' ? 'active' : ''} onClick={() => setTab('my')}>我的技能</button>
          <button className={tab === 'plugins' ? 'active' : ''} onClick={() => setTab('plugins')}>插件管理</button>
        </div>

        {tab === 'my' && (
          <div className="skills-section-body">
          <div className="skills-section-actions">
            <button className="skills-create-btn" onClick={handleCreate}>+ 新建技能</button>
          </div>

          {loading ? (
            <div className="skills-loading">
              <div className="skills-loading-spinner" />
              加载中...
            </div>
          ) : skills.length === 0 ? (
            <div className="skills-empty">
              <div className="skills-empty-icon"><IconPackage/></div>
              <p>暂无技能</p>
              <p className="skills-empty-hint">点击「新建技能」创建自定义技能，或前往「插件管理」安装</p>
            </div>
          ) : (
            <div className="skills-grid">
              {skills.map(s => (
                <div key={s.name} className={`skills-card ${s.source === 'builtin' ? 'skills-card-builtin' : ''}`}>
                  <div className="skills-card-icon">{s.icon || '🔧'}</div>
                  <div className="skills-card-body">
                    <div className="skills-card-name">{s.displayName || s.name}</div>
                    <div className="skills-card-desc">{s.description || ''}</div>
                    <div className="skills-card-meta">
                      <span className={`skills-card-source source-${s.source}`}>
                        {s.source === 'builtin' ? '内置' : s.source === 'shared' ? '共享' : s.source === 'project' ? '项目' : '个人'}
                      </span>
                      {s.category && <span className="skills-card-cat">{s.category}</span>}
                      {s.version && <span className="skills-card-ver">v{s.version}</span>}
                    </div>
                  </div>
                  <div className="skills-card-actions">
                    <button className="skills-card-btn skills-card-btn-export" onClick={() => handleExport(s)} title="导出 Markdown">📥</button>
                    <button className="skills-card-btn skills-card-btn-edit" onClick={() => handleEdit(s)} title="编辑">⚙</button>
                    {s.editable && (
                      <button className="skills-card-btn skills-card-btn-del" onClick={(e) => handleDelete(e, s.name)} title="删除">✕</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          </div>
        )}

        {tab === 'plugins' && (
          <div className="skills-section-body">
          <div className="skills-section-actions">
            <button className="skills-create-btn" onClick={() => { setShowAddPlugin(v => !v); setNewPluginUrl(''); }}>+ 添加插件</button>
          </div>

          {showAddPlugin && (
            <div className="plugin-add-bar">
              <input
                type="text"
                className="skills-search-input"
                placeholder="输入 GitHub 仓库地址，如 https://github.com/obra/superpowers"
                value={newPluginUrl}
                onChange={e => setNewPluginUrl(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAddPlugin(); }}
              />
              <div className="plugin-add-actions">
                <button className="skills-create-btn" onClick={handleAddPlugin} disabled={addingPlugin || !newPluginUrl.trim()}>
                  {addingPlugin ? '获取中…' : '添加'}
                </button>
                <button className="plugin-add-cancel" onClick={() => { setShowAddPlugin(false); setNewPluginUrl(''); }}>取消</button>
              </div>
            </div>
          )}

          {allPlugins.length === 0 ? (
            <div className="skills-empty">
              <div className="skills-empty-icon"><IconPackage/></div>
              <p>暂无插件</p>
            </div>
          ) : (
            <div className="skills-grid">
              {allPlugins.map(p => {
                const isLoading = pluginInstallLoading[p.id];
                return (
                  <div key={p.id}
                    className={`skills-card ${p.builtin ? 'skills-card-builtin' : ''} ${p.installed && p.enabled ? 'skills-card-installed' : ''}`}
                    onClick={() => setPluginDetail(p)}
                    style={{ cursor: 'pointer' }}
                  >
                    <div className="skills-card-icon">{p.icon}</div>
                    <div className="skills-card-body">
                      <div className="skills-card-name">{p.displayName}</div>
                      <div className="skills-card-desc">{p.description || ''}</div>
                      <div className="skills-card-meta">
                        <span className="plugin-status-badge" data-status={p.installed ? (p.enabled ? 'active' : 'disabled') : 'none'}>
                          {p.installed ? (p.enabled ? '已安装·已启用' : '已安装·已禁用') : '未安装'}
                        </span>
                        {p.author && <span className="skills-card-author">@{p.author}</span>}
                        {p.builtin && <span className="skills-card-source source-builtin">内置</span>}
                      </div>
                    </div>
                    <div className="skills-card-actions" onClick={e => e.stopPropagation()}>
                      {!p.installed ? (
                        <>
                          <button className="skills-card-btn skills-card-btn-install" onClick={() => handleInstallPlugin(p)} disabled={isLoading}>
                            {isLoading ? '安装中…' : '安装'}
                          </button>
                          {!p.builtin && (
                            <button className="skills-card-btn skills-card-btn-del" onClick={(e) => handleDeletePlugin(e, p)} title="删除卡片" style={{ color: 'var(--danger)' }}>✕</button>
                          )}
                        </>
                      ) : (
                        <>
                          <button className="skills-card-btn" onClick={() => handleTogglePlugin(p)} title={p.enabled ? '禁用' : '启用'}>
                            {p.enabled ? '⏸' : '▶'}
                          </button>
                          <button className="skills-card-btn skills-card-btn-del" onClick={() => handleUninstallPlugin(p)} title="卸载" disabled={isLoading}>
                            🗑
                          </button>
                          {!p.builtin && (
                            <button className="skills-card-btn skills-card-btn-del" onClick={(e) => handleDeletePlugin(e, p)} title="删除卡片" style={{ color: 'var(--danger)' }}>
                              ✕
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          </div>
        )}
      </div>

      {editorOpen && (
        <SkillEditor
          skill={editingSkill}
          projectDir={projectDir}
          onClose={handleEditorClose}
        />
      )}

      {PluginDetailModal}

      {/* Inline confirmation popup */}
      {confirmDelete && createPortal(
        <div className="confirm-popup-overlay" onClick={() => setConfirmDelete(null)}>
          <div
            className="confirm-popup"
            style={{ left: confirmDelete.x, top: confirmDelete.y - 10 }}
            onClick={e => e.stopPropagation()}
          >
            <div className="confirm-popup-text">确定删除{confirmDelete.type === 'plugin' ? '插件' : '技能'} "{confirmDelete.name}"？</div>
            <div className="confirm-popup-actions">
              <button className="confirm-popup-cancel" onClick={() => setConfirmDelete(null)}>取消</button>
              <button className="confirm-popup-ok" onClick={handleConfirmDelete}>确定</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ── Helper: pick an icon based on GitHub topics ──
function getTopicIcon(topics) {
  const map = {
    'claude-code': '🤖',
    'ai': '🧠',
    'agent': '🕵️',
    'coding': '💻',
    'developer-tools': '🛠️',
    'automation': '⚡',
    'skills': '🔧',
    'plugin': '🧩',
    'vscode': '📝',
    'terminal': '⬛',
    'python': '🐍',
    'javascript': '🟨',
    'typescript': '🔷',
    'go': '🔵',
    'rust': '🦀',
  };
  for (const t of topics) {
    if (map[t.toLowerCase()]) return map[t.toLowerCase()];
  }
  return '📦';
}
