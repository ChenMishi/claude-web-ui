const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const PROXY_PORT = 15721; // 内置代理端口
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const LOG_DIR = path.join(os.homedir(), '.claude-web-ui', 'logs');
const STATS_DIR = path.join(os.homedir(), '.claude-web-ui', 'stats');

// Auth config
const AUTH_MODE = process.env.AUTH_MODE || 'optional'; // 'optional' | 'required' | 'disabled'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
const USERS_FILE = path.join(os.homedir(), '.claude-web-ui', 'users.json');
const JWT_SECRET_FILE = path.join(os.homedir(), '.claude-web-ui', '.jwt-secret');
const OLD_AUTH_TOKEN = process.env.AUTH_TOKEN || '';

// Resolve user-specific data directory (non-admin users get ~/.claude-web-ui in their homeDir)
function getUserDataDir(authUser) {
  if (!authUser || authUser.role === 'admin') {
    return { projects: CLAUDE_PROJECTS_DIR, sessions: SESSIONS_DIR };
  }
  const base = authUser.homeDir || `/home/${authUser.username}`;
  return {
    projects: path.join(base, '.claude-web-ui', 'projects'),
    sessions: path.join(base, '.claude-web-ui', 'sessions'),
  };
}

module.exports = {
  PORT, PROXY_PORT, SESSIONS_DIR, CLAUDE_PROJECTS_DIR, LOG_DIR, STATS_DIR,
  AUTH_MODE, ADMIN_PASSWORD, JWT_SECRET, USERS_FILE, JWT_SECRET_FILE, OLD_AUTH_TOKEN,
  getUserDataDir,
};
