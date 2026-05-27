const { Router } = require('express');
const { signAccessToken, signRefreshToken, verifyToken } = require('../auth/jwt');
const { findUserByUsername, findUserById, createUser, deleteUser, verifyPassword, loadUsers } = require('../auth/users');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = Router();

// Rate limiting: simple in-memory store for login attempts
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW = 15 * 60 * 1000; // 15 minutes

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return true;
  if (now - entry.firstAttempt > ATTEMPT_WINDOW) {
    loginAttempts.delete(ip);
    return true;
  }
  if (entry.count >= MAX_ATTEMPTS) return false;
  return true;
}

function recordAttempt(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.firstAttempt > ATTEMPT_WINDOW) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
  } else {
    entry.count++;
  }
}

// POST /api/auth/login
router.post('/auth/login', async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: '登录尝试次数过多，请15分钟后再试' });
  }

  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  const user = findUserByUsername(username.toLowerCase());
  if (!user) {
    recordAttempt(ip);
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const valid = await verifyPassword(user, password);
  if (!valid) {
    recordAttempt(ip);
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  loginAttempts.delete(ip);

  const payload = { userId: user.id, username: user.username, role: user.role };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);

  res.json({
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      avatar: user.avatar || null,
      homeDir: user.homeDir || `/home/${user.username}`,
    },
  });
});

// POST /api/auth/refresh
router.post('/auth/refresh', (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken 不能为空' });

  try {
    const decoded = verifyToken(refreshToken);
    const payload = { userId: decoded.userId, username: decoded.username, role: decoded.role };
    const newAccess = signAccessToken(payload);
    const newRefresh = signRefreshToken(payload);
    res.json({ accessToken: newAccess, refreshToken: newRefresh });
  } catch {
    res.status(401).json({ error: 'refreshToken 无效或已过期' });
  }
});

// GET /api/auth/me
router.get('/auth/me', requireAuth, (req, res) => {
  const { findUserById } = require('../auth/users');
  const user = findUserById(req.user.userId);
  res.json({
    user: {
      id: req.user.userId,
      username: req.user.username,
      role: req.user.role,
      avatar: user?.avatar || null,
      homeDir: user?.homeDir || `/home/${req.user.username}`,
    },
  });
});

// GET /api/auth/status — public, tells frontend if auth is configured
router.get('/auth/status', (_req, res) => {
  const users = loadUsers();
  const authConfigured = users.users.length > 0;
  const authMode = process.env.AUTH_MODE || 'optional';
  const authRequired = authMode === 'required';
  // In optional mode with no users, auth is effectively disabled
  const needsLogin = authRequired || (authConfigured && authMode !== 'disabled');
  res.json({
    authRequired: needsLogin,
    authConfigured,
    authMode,
  });
});

// GET /api/auth/users — admin only, list all users
router.get('/auth/users', requireAuth, requireRole('admin'), (_req, res) => {
  const data = loadUsers();
  const safe = data.users.map(u => ({
    id: u.id,
    username: u.username,
    role: u.role,
    homeDir: u.homeDir,
    createdAt: u.createdAt,
  }));
  res.json({ users: safe });
});

// POST /api/auth/users — admin only, create user
router.post('/auth/users', requireAuth, requireRole('admin'), async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }
  if (!role || !['admin', 'user'].includes(role)) {
    return res.status(400).json({ error: '角色必须是 admin 或 user' });
  }
  try {
    const user = await createUser(username.toLowerCase(), password, role);
    res.status(201).json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/auth/users/:id — admin only, delete user
router.delete('/auth/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'id 不能为空' });

  // Prevent deleting self
  if (req.user.userId === id) {
    return res.status(400).json({ error: '不能删除自己的账户' });
  }

  const user = findUserById(id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  // Prevent deleting the last admin
  if (user.role === 'admin') {
    const data = loadUsers();
    const adminCount = data.users.filter(u => u.role === 'admin').length;
    if (adminCount <= 1) {
      return res.status(400).json({ error: '不能删除最后一个管理员账户' });
    }
  }

  try {
    await deleteUser(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/me/password — change own password
router.put('/auth/me/password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: '旧密码和新密码不能为空' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少6位' });
  }

  const { findUserById, verifyPassword, changePassword } = require('../auth/users');
  const user = findUserById(req.user.userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const valid = await verifyPassword(user, oldPassword);
  if (!valid) return res.status(401).json({ error: '旧密码错误' });

  try {
    await changePassword(req.user.userId, newPassword);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/me/avatar — update own avatar (base64 data URL, max 5MB)
router.put('/auth/me/avatar', requireAuth, (req, res) => {
  const { avatar } = req.body || {};
  if (!avatar) return res.status(400).json({ error: 'avatar 不能为空' });
  if (typeof avatar !== 'string' || !avatar.startsWith('data:image/')) {
    return res.status(400).json({ error: 'avatar 必须是 data:image/ 格式的 base64' });
  }
  // Rough size check: ~200KB base64
  if (avatar.length > 7000000) {
    return res.status(400).json({ error: '头像图片过大，请使用小于5MB的图片' });
  }

  const { updateUserAvatar } = require('../auth/users');
  try {
    updateUserAvatar(req.user.userId, avatar);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/restart — admin only, restart the web UI server
router.post('/restart', requireAuth, requireRole('admin'), (req, res) => {
  const { spawn } = require('child_process');
  const path = require('path');

  const projectDir = path.resolve(__dirname, '..', '..');
  const nodeBin = process.execPath || '/usr/bin/node';
  const restartScript =
    `sleep 2
kill ${process.pid} 2>/dev/null
cd ${projectDir}
nohup ${nodeBin} server.js > server.log 2>&1 &
echo "Server restarted with PID $!"
`;

  const child = spawn('bash', ['-c', restartScript], {
    detached: true,
    stdio: 'ignore',
    cwd: projectDir,
  });
  child.unref();

  res.json({ ok: true, message: '服务正在重启，请稍候...' });
});

module.exports = router;
