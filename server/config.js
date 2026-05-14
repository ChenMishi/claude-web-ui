const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const PROXY_BASE = process.env.CLAUDE_PROXY || 'http://127.0.0.1:15721';
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const LOG_DIR = path.join(os.homedir(), '.claude-web-ui', 'logs');

module.exports = { PORT, PROXY_BASE, SESSIONS_DIR, CLAUDE_PROJECTS_DIR, LOG_DIR };
