// Simple Bearer-token authentication middleware.
// Set AUTH_TOKEN env var to enable protection; absent = no auth (backward compatible).

const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

function auth(req, res, next) {
  // Auth disabled — skip
  if (!AUTH_TOKEN) return next();

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized — valid Bearer token required' });
  }

  next();
}

module.exports = auth;
