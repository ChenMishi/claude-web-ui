import { useApp } from '../context/AppContext';
import { installMarketplaceSkill } from '../api';

export default function SkillDetailModal({ skill, onClose }) {
  const { user } = useApp();
  const isAdmin = user?.role === 'admin';

  const handleInstall = async () => {
    try {
      await installMarketplaceSkill({ skillName: skill.name, targetScope: isAdmin ? 'shared' : 'personal' });
      onClose(true);
    } catch (err) {
      alert(err.message);
    }
  };

  return (
    <div className="dialog-overlay" onClick={() => onClose(false)}>
      <div className="skill-detail-modal" onClick={e => e.stopPropagation()}>
        <div className="skill-detail-scroll">
        <div className="skill-detail-header">
          <div className="skill-detail-icon">{skill.icon || '📦'}</div>
          <div>
            <h3>{skill.displayNameCN || skill.displayName || skill.name}</h3>
            <span className="skill-detail-name-en">{skill.displayName || skill.name}</span>
          </div>
          <button className="skill-detail-close" onClick={() => onClose(false)}>✕</button>
        </div>

        <div className="skill-detail-body">
          <div className="skill-detail-section">
            <div className="skill-detail-label">简介</div>
            <p>{skill.descriptionCN || skill.description || '暂无介绍'}</p>
          </div>

          {skill.description && skill.description !== (skill.descriptionCN || '') && (
            <div className="skill-detail-section">
              <div className="skill-detail-label">英文原文</div>
              <p className="skill-detail-text-en">{skill.description}</p>
            </div>
          )}

          <div className="skill-detail-info">
            <div className="skill-detail-info-item">
              <span className="skill-detail-info-label">标识符</span>
              <span className="skill-detail-info-value mono">{skill.name}</span>
            </div>
            {skill.category && (
              <div className="skill-detail-info-item">
                <span className="skill-detail-info-label">分类</span>
                <span className="skill-detail-info-value">{skill.category}</span>
              </div>
            )}
            <div className="skill-detail-info-item">
              <span className="skill-detail-info-label">作者</span>
              <span className="skill-detail-info-value">{skill.author || 'Anthropic'}</span>
            </div>
            {skill.version && (
              <div className="skill-detail-info-item">
                <span className="skill-detail-info-label">版本</span>
                <span className="skill-detail-info-value mono">v{skill.version}</span>
              </div>
            )}
          </div>
        </div>

        <div className="skill-detail-footer">
          <button className="skill-detail-install" onClick={handleInstall}>
            安装技能
          </button>
        </div>
        </div>
      </div>
    </div>
  );
}
