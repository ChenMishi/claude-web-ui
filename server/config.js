const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const PROXY_BASE = process.env.CLAUDE_PROXY || 'http://127.0.0.1:15721';
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const LOG_DIR = path.join(os.homedir(), '.claude-web-ui', 'logs');

// Auth config
const AUTH_MODE = process.env.AUTH_MODE || 'optional'; // 'optional' | 'required' | 'disabled'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
const USERS_FILE = path.join(os.homedir(), '.claude-web-ui', 'users.json');
const JWT_SECRET_FILE = path.join(os.homedir(), '.claude-web-ui', '.jwt-secret');
const OLD_AUTH_TOKEN = process.env.AUTH_TOKEN || '';

module.exports = {
  PORT, PROXY_BASE, SESSIONS_DIR, CLAUDE_PROJECTS_DIR, LOG_DIR,
  AUTH_MODE, ADMIN_PASSWORD, JWT_SECRET, USERS_FILE, JWT_SECRET_FILE, OLD_AUTH_TOKEN,
};
