const { verifyToken } = require('../auth/jwt');
const { loadUsers } = require('../auth/users');
const { AUTH_MODE, OLD_AUTH_TOKEN } = require('../config');

// Decide whether auth should be enforced
function isAuthEnabled() {
  if (AUTH_MODE === 'disabled') return false;
  if (AUTH_MODE === 'required') return true;

  // optional mode: enabled only if users have been configured
  const data = loadUsers();
  if (data.users.length > 0) return true;

  // Fall back to old AUTH_TOKEN if set
  if (OLD_AUTH_TOKEN) return true;

  return false;
}

// Layer 1: authModeCheck — decide whether auth is needed at all
function authModeCheck(req, res, next) {
  if (!isAuthEnabled()) {
    req.user = null;
    return next();
  }

  // Legacy AUTH_TOKEN fallback (only used when no users configured)
  const data = loadUsers();
  if (data.users.length === 0 && OLD_AUTH_TOKEN) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token !== OLD_AUTH_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized — valid Bearer token required' });
    }
    // Synthesize an admin user for legacy token holders
    req.user = { userId: 'legacy', username: 'admin', role: 'admin' };
    return next();
  }

  next(); // Fall through to requireAuth
}

// Layer 2: requireAuth — JWT validation
function requireAuth(req, res, next) {
  if (!isAuthEnabled()) {
    req.user = req.user || null;
    return next();
  }

  // If already set by legacy token check
  if (req.user) return next();

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) {
    return res.status(401).json({ error: '未登录 — 请先登录' });
  }

  try {
    const decoded = verifyToken(token);
    req.user = {
      userId: decoded.userId,
      username: decoded.username,
      role: decoded.role,
    };
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期 — 请重新登录' });
  }
}

// Layer 3: requireRole — role check factory
function requireRole(...roles) {
  return (req, res, next) => {
    if (!isAuthEnabled()) return next();
    if (!req.user) return res.status(401).json({ error: '未登录' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: '权限不足' });
    }
    next();
  };
}

// Optional auth — extract user if token present, but don't block
function optionalAuth(req, res, next) {
  if (!isAuthEnabled()) {
    req.user = null;
    return next();
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token) {
    try {
      const decoded = verifyToken(token);
      req.user = { userId: decoded.userId, username: decoded.username, role: decoded.role };
    } catch {
      req.user = null;
    }
  } else {
    req.user = null;
  }
  next();
}

module.exports = { authModeCheck, requireAuth, requireRole, optionalAuth, isAuthEnabled };
