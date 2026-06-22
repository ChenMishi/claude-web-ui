import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { listSkills, deleteSkillApi, listMarketplaceSkills, installMarketplaceSkill } from '../api';
import SkillEditor from './SkillEditor';
import SkillDetailModal from './SkillDetailModal';
import { IconPuzzle, IconPackage, IconSettings, IconSearch } from './icons';

const CATEGORIES = ['全部', '开发', '运维', '文档', '安全', '其他'];

export default function SkillsPanel() {
  const { user, currentProjectId, projects } = useApp();
  const isAdmin = user?.role === 'admin';
  const project = projects.find(p => p.id === currentProjectId);
  const projectDir = project?.cwd || null;

  const [tab, setTab] = useState('my'); // 'my' | 'marketplace'
  const [skills, setSkills] = useState([]);
  const [marketSkills, setMarketSkills] = useState([]);
  const [marketCat, setMarketCat] = useState('全部');
  const [marketSearch, setMarketSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState(null);
  const [detailSkill, setDetailSkill] = useState(null);
  const [error, setError] = useState('');

  const loadSkills = useCallback(() => {
    setLoading(true);
    listSkills(projectDir)
      .then(d => setSkills(d.skills || []))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [projectDir]);

  const loadMarketplace = useCallback(() => {
    setLoading(true);
    listMarketplaceSkills()
      .then(d => setMarketSkills(d.skills || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadSkills(); }, [loadSkills]);
  useEffect(() => { if (tab === 'marketplace') loadMarketplace(); }, [tab, loadMarketplace]);

  const handleDelete = async (name) => {
    if (!confirm(`确定删除技能 "${name}"？`)) return;
    try {
      await deleteSkillApi(name, projectDir);
      loadSkills();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleEdit = (skill) => {
    setEditingSkill(skill);
    setEditorOpen(true);
  };

  const handleCreate = () => {
    setEditingSkill(null);
    setEditorOpen(true);
  };

  const handleEditorClose = (saved) => {
    setEditorOpen(false);
    setEditingSkill(null);
    if (saved) loadSkills();
  };

  const handleInstall = async (skill) => {
    try {
      setError('');
      // Official marketplace skills: install by name (server handles GitHub + builtin fallback)
      await installMarketplaceSkill({ skillName: skill.name, targetScope: isAdmin ? 'shared' : 'personal' });
      loadSkills();
    } catch (err) {
      setError(err.message);
    }
  };

  const installedNames = new Set(skills.map(s => s.name));

  const filteredMarket = marketSkills.filter(s => {
    if (marketCat !== '全部' && s.category !== marketCat) return false;
    if (marketSearch) {
      const q = marketSearch.toLowerCase();
      return (s.displayName || s.name).toLowerCase().includes(q) ||
             (s.description || '').toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div className="skills-panel">
      <div className="skills-panel-header">
        <h2><IconPuzzle/> 技能管理</h2>
        <div className="skills-panel-tabs">
          <button className={tab === 'my' ? 'active' : ''} onClick={() => setTab('my')}>我的技能</button>
          <button className={tab === 'marketplace' ? 'active' : ''} onClick={() => setTab('marketplace')}>技能市场</button>
        </div>
      </div>

      {error && <div className="skills-error">{error} <button onClick={() => setError('')}>✕</button></div>}

      {tab === 'my' && (
        <div className="skills-section">
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
              <p className="skills-empty-hint">点击「新建技能」创建自定义技能，或前往「技能市场」安装</p>
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
                    <button className="skills-card-btn skills-card-btn-edit" onClick={() => handleEdit(s)} title="编辑">⚙</button>
                    {s.editable && (
                      <button className="skills-card-btn skills-card-btn-del" onClick={() => handleDelete(s.name)} title="删除">✕</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'marketplace' && (
        <div className="skills-section">
          <div className="skills-marketplace-bar">
            <input
              type="text"
              className="skills-search-input"
              placeholder="搜索技能..."
              value={marketSearch}
              onChange={e => setMarketSearch(e.target.value)}
            />
            <div className="skills-cat-filter">
              {CATEGORIES.map(c => (
                <button
                  key={c}
                  className={marketCat === c ? 'active' : ''}
                  onClick={() => setMarketCat(c)}
                >{c}</button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="skills-loading">
              <div className="skills-loading-spinner" />
              加载中...
            </div>
          ) : filteredMarket.length === 0 ? (
            <div className="skills-empty">
              <div className="skills-empty-icon"><IconSearch/></div>
              <p>{marketSearch ? '没有匹配的技能' : '技能市场暂无内容'}</p>
            </div>
          ) : (
            <div className="skills-grid">
              {filteredMarket.map(s => {
                const installed = installedNames.has(s.name);
                return (
                  <div key={s.name}
                    className={`skills-card ${installed ? 'skills-card-installed' : ''}`}
                    onClick={() => !installed && setDetailSkill(s)}
                    style={!installed ? { cursor: 'pointer' } : {}}
                  >
                    <div className="skills-card-icon">{s.icon || '📦'}</div>
                    <div className="skills-card-body">
                      <div className="skills-card-name">{s.displayNameCN || s.displayName || s.name}</div>
                      <div className="skills-card-desc">{s.descriptionCN || s.description || ''}</div>
                      <div className="skills-card-meta">
                        {s.category && <span className="skills-card-cat">{s.category}</span>}
                        {s.author && <span className="skills-card-author">@{s.author}</span>}
                        {s.downloads > 0 && <span className="skills-card-downloads">{s.downloads} 安装</span>}
                      </div>
                    </div>
                    <div className="skills-card-actions" onClick={e => e.stopPropagation()}>
                      {installed ? (
                        <span className="skills-installed-badge">已安装</span>
                      ) : (
                        <button className="skills-card-btn skills-card-btn-install" onClick={() => handleInstall(s)}>安装</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {editorOpen && (
        <SkillEditor
          skill={editingSkill}
          projectDir={projectDir}
          onClose={handleEditorClose}
        />
      )}

      {detailSkill && (
        <SkillDetailModal
          skill={detailSkill}
          onClose={(installed) => {
            setDetailSkill(null);
            if (installed) loadSkills();
          }}
        />
      )}
    </div>
  );
}
