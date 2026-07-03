import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../context/AppContext';
import { authHeaders } from '../api';

export default function TimerDropdown() {
  const { scheduledTasks, setScheduledTasks, currentSessionId,
    addPendingTaskSession, markTaskSessionRead, notifyTaskOutput } = useApp();
  const [show, setShow] = useState(false);
  const [tick, setTick] = useState(Date.now());
  const [confirmDel, setConfirmDel] = useState(null); // { id, name, x, y }
  const containerRef = useRef(null);
  const popupRef = useRef(null);
  const lastOutputRef = useRef({}); // taskId → lastOutput hash, for detecting new results
  const clickFlag = useRef(false);    // true when mousedown happened inside this component
  // Clean up stale references when tasks are deleted
  useEffect(() => {
    const ids = new Set(scheduledTasks.map(t => t.id));
    for (const key of Object.keys(lastOutputRef.current)) {
      if (!ids.has(key)) delete lastOutputRef.current[key];
    }
  }, [scheduledTasks]);

  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const poll = () => {
      fetch('/api/scheduled-tasks', { headers: authHeaders({}) })
        .then(r => r.json()).then(d => {
          setScheduledTasks(d.tasks || []);
          if (currentSessionId) markTaskSessionRead(currentSessionId);
          for (const task of d.tasks || []) {
            const updates = task.updatedSessions || [];
            const last = updates[updates.length - 1];
            // Only light up for active/paused tasks in other sessions
            if (last && task.status !== 'stopped' && task.sessionId !== currentSessionId) {
              addPendingTaskSession(task.sessionId);
            }
            // Detect new output for the current session → notify ChatView to refresh
            if (task.lastOutput && task.sessionId === currentSessionId) {
              const prev = lastOutputRef.current[task.id];
              if (task.lastOutput !== prev) {
                lastOutputRef.current[task.id] = task.lastOutput;
                notifyTaskOutput();
              }
            }
          }
        }).catch(() => {});
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, [currentSessionId]);

  // Click-outside-to-close: capture mousedown internally, then check in document click
  useEffect(() => {
    if (!show) return;
    const h = () => {
      if (clickFlag.current) { clickFlag.current = false; return; }
      setShow(false);
    };
    document.addEventListener('click', h);
    return () => document.removeEventListener('click', h);
  }, [show]);

  const handleDelClick = (e, task) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setConfirmDel({ id: task.id, name: task.name, x: rect.left + rect.width / 2, y: rect.top });
  };

  const handleDelete = async () => {
    const id = confirmDel?.id;
    if (!id) return;
    try {
      const r = await fetch(`/api/scheduled-tasks/${id}`, { method: 'DELETE', headers: authHeaders({}) });
      if (!r.ok) throw new Error(r.status);
      setScheduledTasks(prev => prev.filter(t => t.id !== id));
    } catch (err) {
      alert(`删除失败 (${err.message})`);
    }
    setConfirmDel(null);
  };

  const active = scheduledTasks.filter(t => t.status !== 'stopped').length;

  const fmtCd = (nextRun) => {
    const diff = nextRun - tick;
    if (diff <= 0) return '执行中';
    const s = Math.floor(diff / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  };

  return (
    <div className="input-select-group" style={{ position: 'relative' }} ref={containerRef}
      onMouseDownCapture={() => { clickFlag.current = true; }}>
      <span className="input-select-icon" title="定时任务">⏱️</span>
      <button
        className="input-select input-select-skill"
        onClick={() => { setShow(!show); }}
        style={{ background: 'transparent', border: 'none', color: show || active > 0 ? 'var(--accent)' : 'var(--text-primary)', cursor: 'pointer', fontSize: 12, padding: '4px 2px', whiteSpace: 'nowrap' }}
      >{active > 0 ? `定时任务(${active})` : '定时任务'}</button>
      {show && (
        <div className="skills-popup" ref={popupRef} style={{ minWidth: 320 }}>
          <div className="skills-popup-title">定时任务管理</div>
          <div className="timer-task-list">
            {scheduledTasks.length === 0 ? (
              <div className="skills-popup-empty">暂无定时任务</div>
            ) : (
              scheduledTasks.map(task => (
                <div key={task.id} className={`timer-task-item ${task.status}`}>
                  <span className="timer-task-name" title={task.name}>
                    {task.name}
                    {task.maxRuns ? ` (${task.runCount || 0}/${task.maxRuns})` : ''}
                    {task.source === 'cli' && <span className="timer-cli-badge">CLI</span>}
                  </span>
                  <span className="timer-task-cd">{task.source === 'cli' ? (task.cron || '—') : fmtCd(task.nextRun)}</span>
                  <span className="timer-task-status">{task.status === 'active' ? '▶' : '⏸'}</span>
                  {task.source === 'cli' ? (
                    <span className="timer-task-btn" style={{ opacity: 0.3, cursor: 'default' }} title="CLI 任务不支持暂停">⏸</span>
                  ) : (
                    <button className="timer-task-btn" onClick={() => {
                      const ns = task.status === 'active' ? 'paused' : 'active';
                      fetch(`/api/scheduled-tasks/${task.id}`, { method: 'PATCH', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ status: ns }) })
                        .then(r => { if (!r.ok) throw new Error(r.status); })
                        .then(() => setScheduledTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: ns } : t)))
                        .catch(err => alert(`操作失败 (${err.message})`));
                    }}>{task.status === 'active' ? '⏸' : '▶'}</button>
                  )}
                  <button className="timer-task-btn danger" onClick={(e) => handleDelClick(e, task)}>✕</button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {confirmDel && createPortal(
        <div className="confirm-popup-overlay" onClick={() => setConfirmDel(null)}>
          <div
            className="confirm-popup"
            style={{ left: confirmDel.x, top: confirmDel.y - 10 }}
            onClick={e => e.stopPropagation()}
          >
            <div className="confirm-popup-text">确定删除定时任务「{confirmDel.name}」？</div>
            <div className="confirm-popup-actions">
              <button className="confirm-popup-cancel" onClick={() => setConfirmDel(null)}>取消</button>
              <button className="confirm-popup-ok" onClick={handleDelete}>确定</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
