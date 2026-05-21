import { useState } from 'react';
import { useApp } from '../context/AppContext';

const STATUS_ICON = { pending: '◻', in_progress: '⏳', completed: '✅' };
const STATUS_LABEL = { pending: '待处理', in_progress: '进行中', completed: '已完成' };

export default function TaskPanel() {
  const { tasks, isStreaming } = useApp();
  const [expanded, setExpanded] = useState(true);

  if (tasks.length === 0 && !isStreaming) return null;

  const doneCount = tasks.filter(t => t.status === 'completed').length;
  const inProgress = tasks.find(t => t.status === 'in_progress');

  return (
    <div className="task-panel">
      <div className="task-panel-header" onClick={() => setExpanded(!expanded)}>
        <span className="task-panel-title">
          📋 任务进度 ({doneCount}/{tasks.length})
        </span>
        {inProgress && (
          <span className="task-panel-current" title={inProgress.subject}>
            {inProgress.subject.slice(0, 20)}{inProgress.subject.length > 20 ? '…' : ''}
          </span>
        )}
        <span className="task-panel-toggle">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div className="task-panel-list">
          {tasks.map(t => (
            <div key={t.id} className={`task-item ${t.status}`}>
              <span className="task-item-status">{STATUS_ICON[t.status]}</span>
              <div className="task-item-body">
                <span className="task-item-subject">{t.subject}</span>
                {t.description && (
                  <span className="task-item-desc">{t.description.slice(0, 60)}{t.description.length > 60 ? '…' : ''}</span>
                )}
              </div>
              <span className="task-item-label">{STATUS_LABEL[t.status]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
