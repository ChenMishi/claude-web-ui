/**
 * Scheduled Task Scheduler — runs every second, executes due tasks
 */
const { getTasks, setTasks, onTasksChange } = require('./routes/scheduled-task');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

let timer = null;
const EXEC_TIMEOUT = 30000; // 30s max per execution

// Track last-run timestamps to avoid double-execution at startup
const lastRun = new Map();

function appendResult(task, output) {
  try {
    // Find the session JSONL file
    const projectsDir = path.join(require('os').homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return;
    for (const proj of fs.readdirSync(projectsDir)) {
      const projPath = path.join(projectsDir, proj);
      if (!fs.statSync(projPath).isDirectory()) continue;
      const jsonlPath = path.join(projPath, `${task.sessionId}.jsonl`);
      if (!fs.existsSync(jsonlPath)) continue;

      const record = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `[定时任务: ${task.name}]\n${output}` }],
        },
      });
      // Resolve symlink to write to real file
      let realPath = jsonlPath;
      try {
        if (fs.lstatSync(jsonlPath).isSymbolicLink()) {
          realPath = fs.realpathSync(jsonlPath);
        }
      } catch {}
      fs.appendFileSync(realPath, record + '\n', 'utf8');
      return true;
    }
  } catch (err) {
    console.error(`[scheduler] appendResult error:`, err.message);
  }
  return false;
}

function executeTask(task) {
  const now = Date.now();
  if (task.status !== 'active') return;
  if (task.nextRun > now) return;

  // Prevent double-execution within 2s
  const prev = lastRun.get(task.id) || 0;
  if (now - prev < 2000) return;
  lastRun.set(task.id, now);

  // Check maxRuns BEFORE dispatching exec (prevent race condition overshoot)
  if (task.maxRuns && (task.runCount || 0) >= task.maxRuns) {
    task.status = 'stopped';
    console.log(`[scheduler] Task "${task.name}" reached maxRuns (${task.maxRuns}), stopped`);
    return;
  }
  // Optimistic increment to prevent concurrent overshoot
  task.runCount = (task.runCount || 0) + 1;

  console.log(`[scheduler] Executing: ${task.name} (run ${task.runCount}/${task.maxRuns || '∞'})`);

  exec(task.command, { timeout: EXEC_TIMEOUT, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    const output = (stdout || '') + (stderr ? '\n[stderr]\n' + stderr : '') + (err ? '\n[error] ' + err.message : '');

    // Update task and persist
    const tasks = getTasks();
    const t = tasks.find(t => t.id === task.id);
    if (t) {
      t.lastOutput = output.slice(0, 500);
      t.nextRun = Date.now() + t.interval;
      appendResult(t, output.slice(0, 5000));
      // Track that this session has new results
      if (!t.updatedSessions) t.updatedSessions = [];
      t.updatedSessions.push(Date.now());
      if (t.updatedSessions.length > 20) t.updatedSessions = t.updatedSessions.slice(-20);
      setTasks(tasks);
    }
  });
}

function start() {
  if (timer) return;
  console.log('[scheduler] Started');
  timer = setInterval(() => {
    const tasks = getTasks();
    for (const task of tasks) {
      executeTask(task);
    }
  }, 1000);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop };
