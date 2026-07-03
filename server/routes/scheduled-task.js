/**
 * Scheduled Task Route — CRUD API for timed background tasks
 */
const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { requireAuth } = require('../middleware/auth');

const TASKS_FILE = path.join(os.homedir(), '.claude-web-ui', 'scheduled-tasks.json');
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const MAX_TASKS = 10;

// Collect CLI cron tasks from ~/.claude/ and all project working directories
function loadCliTasks() {
  const seen = new Set();
  const result = [];
  const paths = [path.join(CLAUDE_HOME, 'scheduled_tasks.json')];

  // Search project directories for their .claude/scheduled_tasks.json
  const projectsDir = path.join(CLAUDE_HOME, 'projects');
  try {
    if (fs.existsSync(projectsDir)) {
      for (const proj of fs.readdirSync(projectsDir)) {
        const projPath = path.join(projectsDir, proj);
        if (!fs.statSync(projPath).isDirectory()) continue;
        // Resolve symlinks to find the real session directory
        try {
          for (const f of fs.readdirSync(projPath)) {
            if (!f.endsWith('.jsonl')) continue;
            const jsonlPath = path.join(projPath, f);
            let realPath = jsonlPath;
            try {
              if (fs.lstatSync(jsonlPath).isSymbolicLink()) {
                realPath = fs.realpathSync(jsonlPath);
              }
            } catch {}
            // Go up from sessions dir to find .claude/scheduled_tasks.json
            const sessionsDir = path.dirname(realPath);
            const claudeDir = path.dirname(sessionsDir);
            if (path.basename(sessionsDir) === 'sessions' && path.basename(claudeDir) === '.claude') {
              const cliFile = path.join(claudeDir, 'scheduled_tasks.json');
              if (!paths.includes(cliFile)) paths.push(cliFile);
            }
            break; // one file per project is enough
          }
        } catch {}
      }
    }
  } catch {}

  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const ct of (data.tasks || [])) {
        if (seen.has(ct.id)) continue;
        seen.add(ct.id);
        result.push(ct);
      }
    } catch {}
  }
  return result;
}
// Same as loadCliTasks but returns file paths instead of task objects
function loadCliTaskPaths() {
  const paths = [path.join(CLAUDE_HOME, 'scheduled_tasks.json')];
  const projectsDir = path.join(CLAUDE_HOME, 'projects');
  try {
    if (fs.existsSync(projectsDir)) {
      for (const proj of fs.readdirSync(projectsDir)) {
        const projPath = path.join(projectsDir, proj);
        if (!fs.statSync(projPath).isDirectory()) continue;
        try {
          for (const f of fs.readdirSync(projPath)) {
            if (!f.endsWith('.jsonl')) continue;
            const jsonlPath = path.join(projPath, f);
            let realPath = jsonlPath;
            try { if (fs.lstatSync(jsonlPath).isSymbolicLink()) realPath = fs.realpathSync(jsonlPath); } catch {}
            const sessionsDir = path.dirname(realPath);
            const claudeDir = path.dirname(sessionsDir);
            if (path.basename(sessionsDir) === 'sessions' && path.basename(claudeDir) === '.claude') {
              const cliFile = path.join(claudeDir, 'scheduled_tasks.json');
              if (!paths.includes(cliFile)) paths.push(cliFile);
            }
            break;
          }
        } catch {}
      }
    }
  } catch {}
  return paths;
}

function loadTasks() {
  try {
    if (fs.existsSync(TASKS_FILE)) return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch {}
  return [];
}

function saveTasks(tasks) {
  const dir = path.dirname(TASKS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
}

// Share task list with scheduler (mutated in place)
let _tasks = loadTasks();
let _listeners = []; // callbacks when tasks change

function getTasks() { return _tasks; }
function onTasksChange(fn) { _listeners.push(fn); }
function notifyChange() { for (const fn of _listeners) fn(_tasks); }
function setTasks(arr) { _tasks = arr; saveTasks(arr); notifyChange(); }

const router = Router();

// GET /api/scheduled-tasks
router.get('/scheduled-tasks', requireAuth, (_req, res) => {
  const tasks = getTasks().map(t => ({
    id: t.id, name: t.name, sessionId: t.sessionId,
    interval: t.interval, nextRun: t.nextRun, status: t.status,
    lastOutput: t.lastOutput, command: t.command,
    createdAt: t.createdAt, updatedSessions: t.updatedSessions || [],
    runCount: t.runCount || 0, maxRuns: t.maxRuns || null,
    outputVersion: t.outputVersion || 0, source: 'webui',
  }));

  // Also include CLI cron tasks from all known locations
  try {
    for (const ct of loadCliTasks()) {
      tasks.push({
          id: 'cli-' + ct.id,
          name: 'CLI: ' + (ct.prompt || '').slice(0, 40) + (ct.prompt && ct.prompt.length > 40 ? '…' : ''),
          sessionId: ct.createdBySessionId || null,
          interval: null,
          nextRun: (ct.lastFiredAt || ct.createdAt || 0) + 60000, // rough estimate
          status: ct.recurring ? 'active' : 'stopped',
          lastOutput: null,
          command: ct.prompt || '',
          createdAt: ct.createdAt || 0,
          updatedSessions: [],
          runCount: 0,
          maxRuns: null,
          source: 'cli',
        });
      }
  } catch {}

  res.json({ tasks });
});

// POST /api/scheduled-tasks
router.post('/scheduled-tasks', requireAuth, (req, res) => {
  const { name, sessionId, command, interval } = req.body;
  if (!name || !sessionId || !command || !interval) {
    return res.status(400).json({ error: 'name, sessionId, command, interval are required' });
  }
  const tasks = getTasks();
  if (tasks.filter(t => t.status !== 'stopped').length >= MAX_TASKS) {
    return res.status(400).json({ error: `最多 ${MAX_TASKS} 个活跃任务` });
  }
  const id = require('crypto').randomUUID();
  const task = {
    id, name, sessionId, command, interval: Number(interval),
    nextRun: Date.now() + Number(interval), status: 'active',
    lastOutput: null, createdAt: Date.now(), updatedSessions: [],
    runCount: 0, maxRuns: req.body.maxRuns ? Number(req.body.maxRuns) : null,
  };
  tasks.push(task);
  setTasks(tasks);
  res.json({ ok: true, task });
});

// PATCH /api/scheduled-tasks/:id
router.patch('/scheduled-tasks/:id', requireAuth, (req, res) => {
  const tasks = getTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Task not found' });
  const allowed = ['status', 'name', 'interval', 'runCount'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) tasks[idx][key] = req.body[key];
  }
  // Reset nextRun when interval changes or resuming from paused
  if (req.body.interval || (req.body.status === 'active' && tasks[idx].status === 'paused')) {
    tasks[idx].nextRun = Date.now() + tasks[idx].interval;
  }
  setTasks(tasks);
  res.json({ ok: true, task: tasks[idx] });
});

// DELETE /api/scheduled-tasks/:id
router.delete('/scheduled-tasks/:id', requireAuth, (req, res) => {
  const id = req.params.id;

  // CLI cron task — delete from all known locations
  if (id.startsWith('cli-')) {
    const cliId = id.slice(4);
    const cliPaths = loadCliTaskPaths();
    for (const cliPath of cliPaths) {
      try {
        if (!fs.existsSync(cliPath)) continue;
        const data = JSON.parse(fs.readFileSync(cliPath, 'utf8'));
        const before = data.tasks.length;
        data.tasks = (data.tasks || []).filter(t => t.id !== cliId);
        if (data.tasks.length !== before) {
          fs.writeFileSync(cliPath, JSON.stringify(data, null, 2), 'utf8');
          return res.json({ ok: true });
        }
      } catch {}
    }
    return res.status(404).json({ error: 'CLI task not found' });
  }

  // Web UI task
  const tasks = getTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Task not found' });
  tasks.splice(idx, 1);
  setTasks(tasks);
  res.json({ ok: true });
});

module.exports = { router, getTasks, setTasks, onTasksChange };
