const logTs = () => new Date().toLocaleString("sv-SE");
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PORT, CLAUDE_PROJECTS_DIR } = require('./config');

let pty = null;
let WebSocket = null;
try { pty = require('node-pty'); } catch(e) { console.error('[终端] node-pty 加载失败:', e.message); }
try { WebSocket = require('ws'); } catch(e) { console.error('[终端] ws 加载失败:', e.message); }

function createApp() {
  const app = express();

  // Request logger for debugging — logs all requests (first 100 chars of path)
  app.use((req, _res, next) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const logDir = path.resolve(__dirname, 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, 'access.log'),
        `${logTs()} ${req.method} ${req.originalUrl.slice(0, 120)} ${req.headers['user-agent']?.slice(0, 60) || '-'}\n`);
    } catch {}
    next();
  });

  // CORS: allow localhost, Vite dev server, and any private-network origin
  app.use(cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // server-to-server, curl, etc.
      try {
        const host = new URL(origin).hostname;
        // Localhost
        if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return cb(null, true);
        // Private / LAN addresses (10.x, 172.16-31.x, 192.168.x)
        const ip = host.replace(/^\[|\]$/g, '');
        const parts = ip.split('.');
        if (parts.length === 4) {
          const [a, b] = [parseInt(parts[0]), parseInt(parts[1])];
          if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
            return cb(null, true);
          }
        }
      } catch {}
      cb(null, false);
    },
    credentials: true,
  }));

  app.use(express.json({ limit: '50mb' }));

  // Auth middleware
  const { authModeCheck, requireAuth, requireRole } = require('./middleware/auth');

  // Public routes (no auth required)
  app.use('/api', require('./routes/health'));
  app.use('/api', require('./routes/auth'));

  // Auth gate — applied to all remaining /api routes
  app.use('/api', (req, res, next) => {
    if (req.path === '/health' || req.path.startsWith('/auth') || req.path.startsWith('/channels')) return next();
    // Bot internal requests bypass auth with shared token
    if (req.headers['x-internal-token']) {
      try {
        const expected = require('./channels/bot-handler').getInternalToken();
        if (req.headers['x-internal-token'] === expected) {
          req.user = { userId: 'bot', username: 'bot', role: 'admin' };
          return next();
        }
      } catch {}
    }
    // authModeCheck handles disabled/optional/required decision
    const enabled = require('./middleware/auth').isAuthEnabled();
    if (!enabled) return next();

    // In enabled mode, try authModeCheck first (handles legacy token)
    authModeCheck(req, res, () => {
      // Then require JWT
      requireAuth(req, res, next);
    });
  });

  // Admin-only routes (must come before general routes)
  app.use('/api', (req, res, next) => {
    const adminPaths = ['/version', '/init', '/backup'];
    const isAdminPath = adminPaths.some(p => req.path === p || req.path.startsWith(p + '/'));
    if (isAdminPath) {
      return requireRole('admin')(req, res, next);
    }
    next();
  });

  // Mount API routes
  app.use('/api', require('./routes/chat'));
  app.use('/api', require('./routes/project'));
  app.use('/api', require('./routes/session'));
  app.use('/api', require('./routes/terminal'));
  app.use('/api', require('./routes/version'));
  app.use('/api', require('./routes/init'));
  app.use('/api', require('./routes/skills'));
  app.use('/api', require('./routes/plugins'));
  app.use('/api', require('./routes/fs'));
  app.use('/api', require('./routes/stats'));
app.use('/api', require('./routes/backup'));
app.use('/api', require('./routes/storage'));
app.use('/api', require('./routes/scheduled-task').router);
app.use('/api', require('./routes/channels'));

  // Swagger docs
  try {
    const swaggerJsdoc = require('swagger-jsdoc');
    const swaggerUi = require('swagger-ui-express');
    const spec = swaggerJsdoc({
      definition: {
        openapi: '3.0.3',
        info: { title: 'claude-web-ui API', version: '1.1.8' },
      },
      apis: [path.join(__dirname, 'routes', '*.js')],
    });
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));
    app.get('/api-docs.json', (_req, res) => res.json(spec));
  } catch {}

  // Serve static frontend (Vite build output) — disable caching for SPA
  const publicDir = path.join(__dirname, '..', 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir, {
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      },
    }));
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  }

  return app;
}

function startServer(opts = {}) {
  const port = opts.port || PORT;
  const app = createApp();
  const server = http.createServer(app);

  // Disable timeouts for SSE streaming (long-running Agent SDK sessions)
  server.timeout = 0;
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;

  // Prevent server crashes from uncaught errors — log to disk and keep running
  const crashLog = (label, err) => {
    try {
      const dir = path.resolve(__dirname, 'logs');
      require('fs').mkdirSync(dir, { recursive: true });
      require('fs').appendFileSync(`${dir}/crash.log`,
        `${logTs()} ${label} ${err?.message || err}\n${err?.stack || ''}\n\n`);
    } catch {}
  };
  process.on('uncaughtException', (err) => {
    crashLog('uncaughtException', err);
    console.error('[FATAL] uncaughtException:', err.message);
  });
  process.on('unhandledRejection', (reason) => {
    crashLog('unhandledRejection', reason);
    console.error('[FATAL] unhandledRejection:', reason);
  });

  // Clean up stale/orphaned claude processes left behind by previous crashes
  try {
    const { execSync } = require('child_process');
    const out = execSync('ps -eo pid,stat,etime,cmd --no-headers', { encoding: 'utf8', timeout: 5000 });
    const now = Date.now();
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const [pid, stat, elapsed, ...cmdParts] = parts;
      const cmd = cmdParts.join(' ');
      if (!cmd.includes('claude') || cmd.includes('claude.js') || cmd.includes('claude-code')) continue;
      if (pid === String(process.pid)) continue;
      if (stat.includes('T')) {
        try { process.kill(parseInt(pid), 'SIGKILL'); console.log(`Cleaned up stopped claude process PID ${pid}`); } catch {}
      }
    }
  } catch {}

  // WebSocket terminal
  if (WebSocket && pty) {
    const { verifyToken } = require('./auth/jwt');
    const { findUserById } = require('./auth/users');
    const { isAuthEnabled } = require('./middleware/auth');

    const wss = new WebSocket.Server({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      if (!req.url.startsWith('/api/terminal')) {
        socket.destroy();
        return;
      }

      let wsUser = null;

      // Authenticate WebSocket via token query param
      if (isAuthEnabled()) {
        try {
          const url = new URL(req.url, `http://localhost`);
          const token = url.searchParams.get('token');
          if (!token) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          const decoded = verifyToken(token);
          const userRecord = findUserById(decoded.userId);
          if (!userRecord) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          wsUser = { ...decoded, ...userRecord };
        } catch {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        const url = new URL(req.url, `http://localhost`);
        let cwd = url.searchParams.get('cwd') || os.homedir();

        // For regular users, force cwd to their home directory
        if (wsUser && wsUser.role === 'user') {
          cwd = wsUser.homeDir || `/home/${wsUser.username}`;
        } else {
          // Validate cwd: must exist on disk, no traversal
          const resolved = path.resolve(cwd);
          if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            console.warn(`Terminal: cwd=${cwd} 不存在，回退到主目录`);
            cwd = os.homedir();
          } else {
            cwd = resolved;
          }
        }

        const shell = process.env.SHELL || 'bash';
        console.log(`Terminal: cwd=${cwd}, user=${wsUser?.username || 'unauthenticated'}, shell=${shell}`);

        let proc;
        try {
          const spawnOpts = {
            name: 'xterm-256color', cols: 120, rows: 30, cwd,
            env: { ...process.env },
          };

          // Spawn as regular user's OS identity
          if (wsUser && wsUser.role === 'user' && wsUser.osUid > 0) {
            spawnOpts.uid = wsUser.osUid;
            spawnOpts.gid = wsUser.osGid;
            spawnOpts.env.HOME = wsUser.homeDir || cwd;
            spawnOpts.env.USER = wsUser.username;
            spawnOpts.env.LOGNAME = wsUser.username;
          }

          proc = pty.spawn(shell, [], spawnOpts);
          proc.onData((data) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(data);
          });
          proc.onExit(() => {
            if (ws.readyState === WebSocket.OPEN) ws.close();
          });
        } catch (err) {
          console.error('Terminal spawn error:', err);
          ws.close();
          return;
        }

        ws.on('message', (msg) => {
          try {
            const parsed = JSON.parse(msg.toString());
            if (parsed?.type === 'resize') {
              proc.resize(parsed.cols, parsed.rows);
            } else {
              proc.write(msg.toString());
            }
          } catch {
            proc.write(msg.toString());
          }
        });
        ws.on('close', () => { proc.kill(); });
      });
    });
  }

  // Initialize default admin user on startup
  try {
    const { ensureDefaultAdmin } = require('./auth/users');
    ensureDefaultAdmin().then(admin => {
      if (admin) console.log(`[AUTH] Default admin user created: ${admin.username}`);
    }).catch(() => {});
  } catch {}

  // Reset any stale runtime states from previous server instance
  try { require('./store').resetAllRuntimes(); } catch {}

  // Ensure pyjwt is available for scheduled task creation
  try {
    require('child_process').exec('python3 -c "import jwt" 2>/dev/null || pip install pyjwt', (err) => {
      if (err) console.log('[pyjwt] install failed:', err.message);
      else console.log('[pyjwt] ready');
    });
  } catch {}

  // Start scheduled task scheduler
  try { require('./scheduler').start(); } catch (err) { console.log('[scheduler] start failed:', err.message); }

  // Start message channels (WeChat, etc.)
  try {
    const { getChannelManager } = require('./channels');
    const mgr = getChannelManager();
    const { botMessage } = require('./channels/bot-handler');

    // Auto-init bot-current-project.json on startup
    try {
      const f = path.join(os.homedir(), '.claude-web-ui', 'bot-current-project.json');
      if (!fs.existsSync(f)) {
        // Scan projects for the most recently active cwd
        const projDir = path.join(os.homedir(), '.claude', 'projects');
        let bestCwd = os.homedir(), bestTs = 0;
        if (fs.existsSync(projDir)) {
          for (const e of fs.readdirSync(projDir, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const cf = path.join(projDir, e.name, '.cwd');
            let cwd = '';
            try { if (fs.existsSync(cf)) cwd = fs.readFileSync(cf, 'utf8').trim(); } catch {}
            if (!cwd) continue;
            for (const ff of fs.readdirSync(path.join(projDir, e.name))) {
              if (!ff.endsWith('.jsonl')) continue;
              try {
                const ts = fs.statSync(path.join(projDir, e.name, ff)).mtimeMs;
                if (ts > bestTs) { bestTs = ts; bestCwd = cwd; }
              } catch {}
            }
          }
        }
        const d = path.dirname(f);
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(f, JSON.stringify({ cwd: bestCwd, ts: Date.now() }), 'utf8');
        console.log('[channels] Auto-init bot cwd:', bestCwd);
      }
    } catch {}

    mgr.messageHandler = async (userId, text, channelId) => {
      try {
        const cfg = mgr.loadConfig();
        const channelCfg = (cfg.channels || []).find(c => c.id === channelId) || {};
        const channelType = channelCfg.type || 'wechat';
        return await botMessage(channelType, userId, text, channelCfg);
      } catch (err) {
        console.error('[channels] Handler error:', err.message);
        return '处理请求时出错，请稍后重试';
      }
    };
    mgr.startAll().catch(err => console.log('[channels] startAll error:', err.message));
  } catch (err) { console.log('[channels] start failed:', err.message); }

  // Sync Claude global memory rules to ALL human users (auto-installs on every startup)
  try {
    const src = path.join(__dirname, '..', 'MEMORY.md');
    if (fs.existsSync(src)) {
      const srcContent = fs.readFileSync(src, 'utf8');
      const homes = new Set();
      // Scan all human users via getent
      try {
        const { execSync } = require('child_process');
        const passwd = execSync('getent passwd 2>/dev/null || cat /etc/passwd', { encoding: 'utf8' });
        for (const line of passwd.split('\n')) {
          const parts = line.split(':');
          if (parts.length < 6) continue;
          const uid = parseInt(parts[2]);
          const home = parts[5];
          // root + human users (uid >= 1000, max 60000)
          if (home && home !== '/' && (uid === 0 || (uid >= 1000 && uid < 60000))) {
            homes.add(home);
          }
        }
      } catch {}
      // Always include current process owner
      homes.add(os.homedir());
      for (const home of homes) {
        const destDir = path.join(home, '.claude', 'projects', '-root', 'memory');
        const dest = path.join(destDir, 'MEMORY.md');
        let needWrite = true;
        try {
          if (fs.existsSync(dest)) {
            const destContent = fs.readFileSync(dest, 'utf8');
            if (destContent === srcContent) needWrite = false;
          }
        } catch {}
        if (needWrite) {
          try {
            fs.mkdirSync(destDir, { recursive: true });
            fs.writeFileSync(dest, srcContent, 'utf8');
            console.log('[MEMORY] Synced for', home);
          } catch {}
        }
      }
    }
  } catch (e) { console.log('[MEMORY] sync failed:', e.message); }

  // Migrate old SDK convention project directories (- separator) to web UI convention (_ separator).
// SDK binary replaced all non-alphanumeric chars with -, web UI only replaces / with _.
// Must use .cwd file + getProjectDirName(cwd) for precision, because simple -→_ can't
// distinguish hyphens in the original path from path separators (e.g. /data/my-project).
  // SDK binary uses - as path separator (e.g. -root, -data-temp), web UI uses _ (e.g. _root, _data_temp).
  // After migration, - prefixed names become symlinks → _ prefixed dirs, so both conventions work.
  // This ensures the SDK's resume parameter can find sessions stored by the web UI.
  try {
    const { CLAUDE_PROJECTS_DIR: cfgProjectsDir } = require('./config');
    const { getProjectDirName } = require('./store');
    const dirsToCheck = [cfgProjectsDir];

    // Collect user-specific projects directories
    try {
      const { loadUsers } = require('./auth/users');
      const { users } = loadUsers();
      for (const user of users) {
        if (user.role !== 'admin' && user.homeDir) {
          const userDir = path.join(user.homeDir, '.claude-web-ui', 'projects');
          if (!dirsToCheck.includes(userDir)) dirsToCheck.push(userDir);
        }
      }
    } catch {}

    for (const projectsDir of dirsToCheck) {
      if (!fs.existsSync(projectsDir)) continue;
      let entries;
      try { entries = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { continue; }

      for (const entry of entries) {
        // Only process real directories (not symlinks)
        if (!entry.isDirectory()) continue;
        if (entry.isSymbolicLink && entry.isSymbolicLink()) continue;
        const oldName = entry.name;
        if (oldName.startsWith('_')) continue; // already new convention

        // Determine the correct new name — prefer .cwd file for precision
        let newName = null;
        try {
          const cwdFile = path.join(projectsDir, oldName, '.cwd');
          if (fs.existsSync(cwdFile)) {
            newName = getProjectDirName(fs.readFileSync(cwdFile, 'utf8').trim());
          }
        } catch {}
        // Fallback 1: extract cwd from .jsonl files (SDK convention stores cwd in first record)
        if (!newName) {
          try {
            for (const f of fs.readdirSync(oldPath)) {
              if (!f.endsWith('.jsonl')) continue;
              const firstLine = fs.readFileSync(path.join(oldPath, f), 'utf8').split('\n').find(l => l.includes('"cwd"'));
              if (firstLine) {
                const obj = JSON.parse(firstLine);
                if (typeof obj.cwd === 'string') { newName = getProjectDirName(obj.cwd); break; }
              }
            }
          } catch {}
        }
        // Fallback 2: old convention = replace all non-alnum with -, new = replace only / with _
        // For paths without hyphens: -data-temp → _data_temp (replace all - with _)
        // For paths with hyphens:  -data-my-project → _data_my_project (best effort, .cwd preferred)
        if (!newName && oldName.startsWith('-')) {
          newName = oldName.replace(/-/g, '_');
        }
        if (!newName || newName === oldName) continue;

        const oldPath = path.join(projectsDir, oldName);
        const newPath = path.join(projectsDir, newName);

        if (fs.existsSync(newPath)) {
          // _ convention dir already exists — merge any unique files from - dir
          let sessionFiles;
          try { sessionFiles = fs.readdirSync(oldPath); } catch { continue; }
          for (const f of sessionFiles) {
            const src = path.join(oldPath, f);
            const dst = path.join(newPath, f);
            if (fs.existsSync(dst)) continue;
            try {
              // Try hard link first (zero extra disk on same filesystem)
              fs.linkSync(src, dst);
              console.log(`[migrate] 已链接: ${oldName}/${f} → ${newName}/${f}`);
            } catch (linkErr) {
              if (linkErr.code === 'EXDEV') {
                try { fs.copyFileSync(src, dst); console.log(`[migrate] 已复制: ${oldName}/${f} → ${newName}/${f}`); } catch {}
              }
            }
          }
          // Remove - convention dir and replace with symlink
          try { fs.rmSync(oldPath, { recursive: true, force: true }); } catch {}
          try { fs.symlinkSync(newName, oldPath); console.log(`[migrate] 已创建符号链接: ${oldName} → ${newName}`); } catch {}
        } else {
          // _ convention dir doesn't exist — rename - dir to _, then symlink - → _
          try {
            fs.renameSync(oldPath, newPath);
            fs.symlinkSync(newName, oldPath);
            console.log(`[migrate] 已迁移: ${oldName} → ${newName} (含符号链接)`);
          } catch (err) {
            console.log(`[migrate] 迁移失败 ${oldName}: ${err.message}`);
          }
        }
      }
    }
  } catch (err) {
    console.log('[migrate] 项目目录迁移出错:', err.message);
  }

  server.listen(port, '0.0.0.0', () => {
    const pkg = require('../package.json');
    console.log(`AI IntelliWork Hub v${pkg.version} running at http://0.0.0.0:${port}`);
    console.log(`API docs at http://localhost:${port}/docs`);

    // Start built-in proxy — read address from saved config
    try {
      const { startProxy } = require('./proxy');
      const fs = require('fs');
      const path = require('path');
      const configFile = path.join(__dirname, '..', 'init-config.json');
      let proxyHost = '127.0.0.1';
      let proxyPort = 15721;
      try {
        if (fs.existsSync(configFile)) {
          const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
          if (cfg.proxyUrl) {
            const u = new URL(cfg.proxyUrl);
            proxyHost = u.hostname || '127.0.0.1';
            proxyPort = parseInt(u.port) || 15721;
          } else if (cfg.proxyPort) {
            proxyPort = cfg.proxyPort;
          }
        }
      } catch {}

      startProxy(proxyHost, proxyPort).then((proxyServer) => {
        if (proxyServer) {
          console.log(`[proxy] 内置代理已启动 http://${proxyHost}:${proxyPort}`);
        }
      }).catch(err => {
        console.warn('[proxy] 代理启动失败:', err.message);
      });
    } catch (err) {
      console.warn('[proxy] 代理模块加载失败:', err.message);
    }
  });

  // Auto-backup scheduler
  try {
    const backup = require('./routes/backup');
    const lastBackupFile = path.join(os.homedir(), '.claude-web-ui', '.last-backup');

    // Read persisted last-backup timestamp to survive restarts
    let lastHour, lastDay, lastWeek;
    try {
      if (fs.existsSync(lastBackupFile)) {
        const lastDate = new Date(parseInt(fs.readFileSync(lastBackupFile, 'utf8')));
        if (!isNaN(lastDate.getTime())) {
          lastHour = lastDate.getHours();
          lastDay = lastDate.getDate();
          lastWeek = lastDate.getDay();
        } else {
          throw new Error('invalid timestamp');
        }
      } else {
        throw new Error('no persisted state');
      }
    } catch {
      // No persisted state — use current time to avoid immediate backup on startup
      const now = new Date();
      lastHour = now.getHours();
      lastDay = now.getDate();
      lastWeek = now.getDay();
    }

    setInterval(() => {
      try {
        const cfg = backup.readBackupConfig();
        if (!cfg.frequency || cfg.frequency === 'manual') return;
        const now = new Date();
        let shouldBackup = false;
        if (cfg.frequency === 'hourly' && now.getHours() !== lastHour) { lastHour = now.getHours(); shouldBackup = true; }
        else if (cfg.frequency === 'daily' && now.getDate() !== lastDay) { lastDay = now.getDate(); shouldBackup = true; }
        else if (cfg.frequency === 'weekly' && now.getDay() !== lastWeek) { lastWeek = now.getDay(); shouldBackup = true; }
        if (shouldBackup) {
          backup.createBackup();
          // Persist last backup timestamp so next restart knows when we last backed up
          try { fs.writeFileSync(lastBackupFile, String(Date.now())); } catch {}
          console.log(`[backup] 自动备份完成 (${cfg.frequency})`);
        }
      } catch (err) {
        console.warn('[backup] 自动备份失败:', err.message);
      }
    }, 60000); // check every minute
  } catch {}

  return server;
}

module.exports = { createApp, startServer };
