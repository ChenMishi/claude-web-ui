import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../context/AppContext';
import { authHeaders } from '../api';

export default function TimerDropdown() {
  const { scheduledTasks, setScheduledTasks, currentSessionId,
    addPendingTaskSession, markTaskSessionRead, notifyTaskOutput, appendMessage, sessions,
    addUnreadSession,
  } = useApp();
  const [show, setShow] = useState(false);
  const [tick, setTick] = useState(Date.now());
  const [confirmDel, setConfirmDel] = useState(null); // { id, name, x, y }
  const [confirmClear, setConfirmClear] = useState(null); // { x, y } or null
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCmd, setNewCmd] = useState('');
  const [newInterval, setNewInterval] = useState('');
  const [newMaxRuns, setNewMaxRuns] = useState('');
  const [newDuration, setNewDuration] = useState(''); // 执行时长(分钟)，自动换算 maxRuns
  const containerRef = useRef(null);
  const popupRef = useRef(null);
  const lastOutputRef = useRef({}); // taskId → outputVersion, for detecting new results
  const firstPollRef = useRef(true); // skip first poll to avoid false new-output detection
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
          // First poll: seed lastOutputRef so existing output isn't treated as new
          if (firstPollRef.current) {
            firstPollRef.current = false;
            for (const task of d.tasks || []) {
              if (task.lastOutput && task.outputVersion) {
                lastOutputRef.current[task.id] = task.outputVersion;
              }
            }
            // Still need to light up active-task yellow dots
            const activeSids = new Set();
            for (const task of d.tasks || []) {
              if (task.status !== 'stopped' && task.sessionId) activeSids.add(task.sessionId);
            }
            for (const sid of activeSids) addPendingTaskSession(sid);
            return; // skip new-output detection on first poll
          }
          for (const task of d.tasks || []) {
            // Only detect new output for ACTIVE tasks — completed ones stay quiet
            if (task.status === 'stopped') continue;
            if (task.lastOutput && task.sessionId) {
              const prevVer = lastOutputRef.current[task.id] || 0;
              if ((task.outputVersion || 0) > prevVer) {
                lastOutputRef.current[task.id] = task.outputVersion;
                if (task.sessionId === currentSessionId) {
                  appendMessage({ role: 'assistant', content: `⏰ [定时任务: ${task.name}]\n${task.lastOutput}`, timestamp: Date.now() });
                } else {
                  addUnreadSession(task.sessionId);
                }
              }
            }
          }
          // Light up all sessions that have active (non-stopped) tasks
          const activeSids = new Set();
          for (const task of d.tasks || []) {
            if (task.status !== 'stopped' && task.sessionId) {
              activeSids.add(task.sessionId);
            }
          }
          for (const sid of activeSids) {
            addPendingTaskSession(sid);
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

  const handleClearAll = async () => {
    setConfirmClear(null);
    for (const task of scheduledTasks) {
      try { await fetch(`/api/scheduled-tasks/${task.id}`, { method: 'DELETE', headers: authHeaders({}) }); } catch {}
    }
    setScheduledTasks([]);
  };

  const handleCreate = async () => {
    if (!newName.trim() || !newCmd.trim() || !newInterval) return;
    if (!currentSessionId || currentSessionId === 'new') {
      alert('请先发送一条消息创建会话，再创建定时任务');
      return;
    }
    const intervalMs = parseInt(newInterval) * 1000;
    let maxRuns = newMaxRuns ? parseInt(newMaxRuns) : undefined;
    // 如果填了执行时长，自动换算 maxRuns
    if (!maxRuns && newDuration) {
      maxRuns = Math.floor((parseInt(newDuration) * 60 * 1000) / intervalMs);
    }
    try {
      const r = await fetch('/api/scheduled-tasks', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          name: newName.trim(),
          sessionId: currentSessionId,
          command: newCmd.trim(),
          interval: parseInt(newInterval) * 1000,
          maxRuns: maxRuns || undefined,
        }),
      });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      setScheduledTasks(prev => [...prev, d.task]);
      setCreating(false);
      setNewName('');
      setNewCmd('');
      setNewInterval('');
      setNewMaxRuns('');
      setNewDuration('');
    } catch (err) {
      alert(`创建失败 (${err.message})`);
    }
  };

  const active = scheduledTasks.filter(t => t.status !== 'stopped').length;

  const fmtCd = (task) => {
    if (task.status === 'stopped') return '已完成';
    const diff = task.nextRun - tick;
    if (diff <= 0) return '执行中';
    const s = Math.floor(diff / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  };
  const getSessionName = (sid) => {
    const s = sessions.find(s => s.id === sid);
    return s?.title || sid?.slice(0, 8) || '';
  };
  const statusIcon = (status) => {
    if (status === 'stopped') return '✅';
    return status === 'active' ? '▶' : '⏸';
  };

  const handleRepeat = async (task) => {
    try {
      const r = await fetch(`/api/scheduled-tasks/${task.id}`, {
        method: 'PATCH',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ status: 'active', runCount: 0 }),
      });
      if (!r.ok) throw new Error(r.status);
      setScheduledTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: 'active', runCount: 0, nextRun: Date.now() + t.interval } : t));
    } catch (err) {
      alert(`重新执行失败 (${err.message})`);
    }
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
        <div className="skills-popup" ref={popupRef} style={{ minWidth: 380 }}>
          <div className="skills-popup-title">定时任务管理</div>
          <div className="timer-task-list">
            <button className="timer-create-btn" onClick={() => { setCreating(!creating); setNewName(''); setNewCmd(''); setNewInterval(''); setNewMaxRuns(''); setNewDuration(''); }}>
              {creating ? '取消创建' : '＋ 创建任务'}
            </button>
            {creating && (
              <div className="timer-create-form">
                <input className="timer-form-input" placeholder="任务名称" value={newName} onChange={e => setNewName(e.target.value)} />
                <input className="timer-form-input" placeholder="shell 命令" value={newCmd} onChange={e => setNewCmd(e.target.value)} />
                <div className="timer-form-row">
                  <input className="timer-form-input" type="number" placeholder="间隔(秒)" value={newInterval} onChange={e => setNewInterval(e.target.value)} style={{ width: 80 }} />
                  <input className="timer-form-input" type="number" placeholder="次数" value={newMaxRuns} onChange={e => setNewMaxRuns(e.target.value)} style={{ width: 60 }} />
                  <input className="timer-form-input" type="number" placeholder="时长(分)" value={newDuration} onChange={e => setNewDuration(e.target.value)} style={{ width: 70 }} />
                  <button className="timer-form-submit" onClick={handleCreate}>创建</button>
                </div>
              </div>
            )}
            {scheduledTasks.length === 0 ? (
              <div className="skills-popup-empty">暂无定时任务</div>
            ) : (
              scheduledTasks.map(task => (
                <div key={task.id} className={`timer-task-item ${task.status}`}>
                  <span className="timer-task-name">
                    <span className="timer-session-name" title={getSessionName(task.sessionId)}>{getSessionName(task.sessionId)}</span>
                    <span className="timer-task-label" title={task.name}>{task.name}</span>
                    {task.maxRuns ? <span className="timer-task-stats">({task.runCount || 0}/{task.maxRuns})</span> : null}
                    {task.source === 'cli' && <span className="timer-cli-badge">CLI</span>}
                  </span>
                  <span className="timer-task-cd">{task.source === 'cli' ? (task.cron || '—') : fmtCd(task)}</span>
                  <span className="timer-task-status">{statusIcon(task.status)}</span>
                  {task.source === 'cli' ? (
                    <span className="timer-task-btn" style={{ opacity: 0.3, cursor: 'default' }} title="CLI 任务不支持暂停">⏸</span>
                  ) : task.status === 'stopped' ? (
                    <button className="timer-task-btn" title="再次执行" onClick={() => handleRepeat(task)}>🔄</button>
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
          {scheduledTasks.length > 0 && (
            <button className="timer-clear-btn" onClick={(e) => { e.stopPropagation(); const rect = e.currentTarget.getBoundingClientRect(); setConfirmClear({ x: rect.left + rect.width / 2, y: rect.top }); }}>清空全部</button>
          )}
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
      {confirmClear && createPortal(
        <div className="confirm-popup-overlay" onClick={() => setConfirmClear(null)}>
          <div
            className="confirm-popup"
            style={{ left: confirmClear.x, top: confirmClear.y - 10 }}
            onClick={e => e.stopPropagation()}
          >
            <div className="confirm-popup-text">确定清空所有定时任务？此操作不可恢复。</div>
            <div className="confirm-popup-actions">
              <button className="confirm-popup-cancel" onClick={() => setConfirmClear(null)}>取消</button>
              <button className="confirm-popup-ok" onClick={handleClearAll}>确定</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
