const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const JWT_SECRET_FILE = path.join(os.homedir(), '.claude-web-ui', '.jwt-secret');
const JWT_DIR = path.dirname(JWT_SECRET_FILE);

function getJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  try {
    if (!fs.existsSync(JWT_DIR)) fs.mkdirSync(JWT_DIR, { recursive: true });
    if (fs.existsSync(JWT_SECRET_FILE)) {
      return fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
    }
    const secret = crypto.randomBytes(64).toString('hex');
    fs.writeFileSync(JWT_SECRET_FILE, secret, { mode: 0o600 });
    return secret;
  } catch {
    return crypto.randomBytes(64).toString('hex');
  }
}

let _secret = null;
function secret() {
  if (!_secret) _secret = getJwtSecret();
  return _secret;
}

function signAccessToken(payload) {
  return jwt.sign(payload, secret(), { expiresIn: '15m' });
}

function signRefreshToken(payload) {
  return jwt.sign(payload, secret(), { expiresIn: '7d' });
}

function verifyToken(token) {
  return jwt.verify(token, secret());
}

module.exports = { signAccessToken, signRefreshToken, verifyToken, getJwtSecret };
