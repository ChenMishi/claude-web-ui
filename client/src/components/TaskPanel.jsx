import { useRef, useEffect } from 'react';
import { useApp } from '../context/AppContext';

const STATUS_ICON = { pending: '◻', in_progress: '⏳', completed: '✅' };
const STATUS_LABEL = { pending: '待处理', in_progress: '进行中', completed: '已完成' };

export default function TaskPanel() {
  const { tasks, isStreaming } = useApp();
  const listRef = useRef(null);

  // Auto-scroll to bottom when new tasks are added
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [tasks]);

  if (tasks.length === 0 && !isStreaming) return null;

  const doneCount = tasks.filter(t => t.status === 'completed').length;

  return (
    <div className="task-panel">
      <div className="task-panel-header">
        <span className="task-panel-title">
          任务进度 ({doneCount}/{tasks.length})
        </span>
      </div>
      <div className="task-panel-list" ref={listRef}>
        {tasks.map(t => (
          <div key={t.id} className={`task-item ${t.status}`}>
            <span className="task-item-status">{STATUS_ICON[t.status]}</span>
            <div className="task-item-body">
              <span className="task-item-subject">{t.subject}</span>
              {t.description && (
                <span className="task-item-desc">{t.description.slice(0, 60)}{t.description.length > 60 ? '…' : ''}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
