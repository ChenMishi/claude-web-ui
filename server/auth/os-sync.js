const { execSync } = require('child_process');

function createSystemUser(username, password) {
  // Check if user already exists
  try {
    execSync(`id ${username}`, { stdio: 'pipe' });
    const info = getUserInfo(username);
    return { uid: info.uid, gid: info.gid, homeDir: info.homeDir };
  } catch {
    // User doesn't exist, create
  }

  execSync(`useradd -m -s /bin/bash ${username}`, { stdio: 'pipe', timeout: 10000 });
  execSync(`echo "${username}:${password}" | chpasswd`, { stdio: 'pipe', timeout: 5000 });

  const info = getUserInfo(username);
  return { uid: info.uid, gid: info.gid, homeDir: info.homeDir };
}

function deleteSystemUser(username) {
  try {
    execSync(`userdel -r ${username}`, { stdio: 'pipe', timeout: 10000 });
    return true;
  } catch (err) {
    console.error(`Failed to delete system user ${username}:`, err.message);
    return false;
  }
}

function getUserInfo(username) {
  const idOut = execSync(`id -u ${username}`, { stdio: 'pipe', encoding: 'utf8' }).trim();
  const uid = parseInt(idOut, 10);
  const gidOut = execSync(`id -g ${username}`, { stdio: 'pipe', encoding: 'utf8' }).trim();
  const gid = parseInt(gidOut, 10);

  let homeDir = `/home/${username}`;
  try {
    const passwd = require('fs').readFileSync('/etc/passwd', 'utf8');
    for (const line of passwd.split('\n')) {
      if (line.startsWith(`${username}:`)) {
        const parts = line.split(':');
        if (parts.length >= 6) homeDir = parts[5];
        break;
      }
    }
  } catch {}

  return { uid, gid, homeDir };
}

module.exports = { createSystemUser, deleteSystemUser, getUserInfo };
