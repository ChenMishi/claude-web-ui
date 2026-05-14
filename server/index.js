const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PORT } = require('./config');

let pty = null;
let WebSocket = null;
try { pty = require('node-pty'); } catch {}
try { WebSocket = require('ws'); } catch {}

function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // Mount API routes
  app.use('/api', require('./routes/health'));
  app.use('/api', require('./routes/chat'));
  app.use('/api', require('./routes/project'));
  app.use('/api', require('./routes/session'));
  app.use('/api', require('./routes/terminal'));

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

  // Serve static frontend (Vite build output)
  const publicDir = path.join(__dirname, '..', 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.get('*', (_req, res) => {
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

  // WebSocket terminal
  if (WebSocket && pty) {
    const wss = new WebSocket.Server({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      if (!req.url.startsWith('/api/terminal')) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const cwd = url.searchParams.get('cwd') || os.homedir();
        const shell = process.env.SHELL || 'bash';
        console.log(`Terminal: cwd=${cwd}, shell=${shell}`);

        let proc;
        try {
          proc = pty.spawn(shell, [], {
            name: 'xterm-256color', cols: 120, rows: 30, cwd, env: process.env,
          });
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

  server.listen(port, '0.0.0.0', () => {
    console.log(`Claude Web UI v2 running at http://0.0.0.0:${port}`);
    console.log(`API docs at http://localhost:${port}/docs`);
  });

  return server;
}

module.exports = { createApp, startServer };
