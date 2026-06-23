import { useRef, useEffect } from 'react';
import { useApp } from '../context/AppContext';

const STATUS_ICON = { pending: '◻️', in_progress: '⏳', completed: '✅' };
const STATUS_LABEL = { pending: '待处理', in_progress: '进行中', completed: '已完成' };

const StatusIcon = ({ status }) => {
  return <>{STATUS_ICON[status] || '#'}</>;
};

export default function TaskPanel() {
  const { tasks, mainTask } = useApp();
  const listRef = useRef(null);

  // Auto-scroll to the first in-progress/pending task when tasks update
  useEffect(() => {
    if (!listRef.current || tasks.length === 0) return;

    // Find the first non-completed task — prefer in_progress, then pending
    const activeIdx = tasks.findIndex(t => t.status !== 'completed');
    if (activeIdx === -1) {
      // All done — scroll to bottom
      listRef.current.scrollTop = listRef.current.scrollHeight;
      return;
    }

    // Scroll the active task into view, aligning to top for better context
    const items = listRef.current.querySelectorAll('.task-item.subtask');
    if (items[activeIdx]) {
      items[activeIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [tasks]);

  const doneCount = tasks.filter(t => t.status === 'completed').length;
  const hasSubtasks = tasks.length > 0;

  return (
    <div className="task-panel">
      <div className="task-panel-header">
        <span className="task-panel-title">
          📋 任务进度{hasSubtasks ? ` (${doneCount}/${tasks.length})` : ''}
        </span>
      </div>
      <div className="task-panel-list" ref={listRef}>
        {!mainTask && !hasSubtasks ? (
          <div className="panel-empty">暂无任务</div>
        ) : hasSubtasks ? (
          <>
            {mainTask && (
              <div className={`task-item main-task ${mainTask.status}`}>
                <span className="task-item-status"><StatusIcon status={mainTask.status}/></span>
                <div className="task-item-body">
                  <span className="task-item-subject">{mainTask.subject.slice(0, 80)}{mainTask.subject.length > 80 ? '…' : ''}</span>
                </div>
              </div>
            )}
            {tasks.map(t => (
              <div key={t.id} className={`task-item subtask ${t.status}`}>
                <span className="task-item-status"><StatusIcon status={t.status}/></span>
                <div className="task-item-body">
                  <span className="task-item-subject">{t.subject}</span>
                  {t.description && (
                    <span className="task-item-desc">{t.description.slice(0, 60)}{t.description.length > 60 ? '…' : ''}</span>
                  )}
                </div>
              </div>
            ))}
          </>
        ) : (
          <div className="task-item main-task-summary">
            <span className="task-item-status">📌</span>
            <div className="task-item-body">
              <span className="task-item-subject">{mainTask.subject}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
