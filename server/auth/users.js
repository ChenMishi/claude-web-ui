const fs = require('fs');
const path = require('path');
const os = require('os');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { createSystemUser, deleteSystemUser } = require('./os-sync');

const USERS_DIR = path.join(os.homedir(), '.claude-web-ui');
const USERS_FILE = path.join(USERS_DIR, 'users.json');

function ensureDir() {
  if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });
}

function loadUsers() {
  ensureDir();
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
  } catch {}
  return { users: [] };
}

function saveUsers(data) {
  ensureDir();
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}

function findUserByUsername(username) {
  const data = loadUsers();
  return data.users.find(u => u.username === username) || null;
}

function findUserById(id) {
  const data = loadUsers();
  return data.users.find(u => u.id === id) || null;
}

async function createUser(username, password, role) {
  const data = loadUsers();

  if (findUserByUsername(username)) {
    throw new Error(`用户 ${username} 已存在`);
  }

  // Validate username
  if (!/^[a-z_][a-z0-9_-]{1,31}$/.test(username)) {
    throw new Error('用户名只能包含小写字母、数字、下划线和连字符，且以字母或下划线开头，长度2-32');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  let osUid = 0, osGid = 0, homeDir = os.homedir();

  if (role === 'user') {
    try {
      const info = createSystemUser(username, password);
      osUid = info.uid;
      osGid = info.gid;
      homeDir = info.homeDir;
    } catch (err) {
      throw new Error(`创建系统用户失败: ${err.message}`);
    }
  }

  const user = {
    id: crypto.randomUUID(),
    username,
    passwordHash,
    role,
    osUid,
    osGid,
    homeDir,
    createdAt: new Date().toISOString(),
  };

  data.users.push(user);
  saveUsers(data);

  const { passwordHash: _, ...safe } = user;
  return safe;
}

async function deleteUser(userId) {
  const data = loadUsers();
  const idx = data.users.findIndex(u => u.id === userId);
  if (idx === -1) throw new Error('用户不存在');

  const user = data.users[idx];

  // Don't allow deleting yourself — enforced by route
  // if (user.username === currentUsername) throw new Error('不能删除自己');

  // Remove OS user for regular users
  if (user.role === 'user' && user.osUid >= 1000) {
    try {
      deleteSystemUser(user.username);
    } catch (err) {
      console.error(`Failed to delete OS user ${user.username}:`, err.message);
    }
  }

  data.users.splice(idx, 1);
  saveUsers(data);
  return true;
}

async function verifyPassword(user, plaintext) {
  return bcrypt.compare(plaintext, user.passwordHash);
}

async function ensureDefaultAdmin() {
  const data = loadUsers();
  const hasAdmin = data.users.some(u => u.role === 'admin');
  if (hasAdmin) return data.users.find(u => u.role === 'admin');

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) return null;

  const passwordHash = await bcrypt.hash(adminPassword, 12);
  const admin = {
    id: crypto.randomUUID(),
    username: 'admin',
    passwordHash,
    role: 'admin',
    osUid: 0,
    osGid: 0,
    homeDir: os.homedir(),
    createdAt: new Date().toISOString(),
  };

  data.users.push(admin);
  saveUsers(data);

  const { passwordHash: _, ...safe } = admin;
  return safe;
}

module.exports = {
  loadUsers, saveUsers,
  findUserByUsername, findUserById,
  createUser, deleteUser,
  verifyPassword,
  ensureDefaultAdmin,
};
