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

  app.use(express.json({ limit: '10mb' }));

  // Auth middleware
  const { authModeCheck, requireAuth, requireRole } = require('./middleware/auth');

  // Public routes (no auth required)
  app.use('/api', require('./routes/health'));
  app.use('/api', require('./routes/auth'));

  // Auth gate — applied to all remaining /api routes
  app.use('/api', (req, res, next) => {
    if (req.path === '/health' || req.path.startsWith('/auth')) return next();
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
    const adminPaths = ['/version', '/init'];
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
  app.use('/api', require('./routes/fs'));

  // Swagger docs
  try {
    const swaggerJsdoc = require('swagger-jsdoc');
    const swaggerUi = require('swagger-ui-express');
    const spec = swaggerJsdoc({
      definition: {
        openapi: '3.0.3',
        info: { title: 'claude-web-ui API', version: '2.0.0' },
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
      const dir = require('./config').LOG_DIR || '/tmp';
      require('fs').mkdirSync(dir, { recursive: true });
      require('fs').appendFileSync(`${dir}/crash.log`,
        `${new Date().toISOString()} ${label} ${err?.message || err}\n${err?.stack || ''}\n\n`);
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

  server.listen(port, '0.0.0.0', () => {
    console.log(`Claude Web UI v2 running at http://0.0.0.0:${port}`);
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

  return server;
}

module.exports = { createApp, startServer };
