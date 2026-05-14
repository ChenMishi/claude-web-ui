const path = require('path');
const fs = require('fs');
const { CLAUDE_PROJECTS_DIR } = require('./config');

function normalizePath(p) {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isPathInside(absPath, cwd) {
  const a = normalizePath(absPath);
  const b = normalizePath(cwd);
  return a === b || a.startsWith(b + '/');
}

function dirNameToCwd(dirName) {
  const parts = dirName.split('-').slice(1);
  function tryResolve(idx, current) {
    if (idx === parts.length) return fs.existsSync(current) ? current : null;
    let segment = '';
    for (let end = idx; end < parts.length; end++) {
      segment = segment ? segment + '-' + parts[end] : parts[end];
      const next = path.join(current, segment);
      if (fs.existsSync(next)) {
        const result = tryResolve(end + 1, next);
        if (result !== null) return result;
      }
    }
    return null;
  }
  const unixResult = tryResolve(0, '/');
  if (unixResult) return unixResult;
  for (const drive of ['C', 'D', 'E', 'F']) {
    const result = tryResolve(0, drive + ':' + path.sep);
    if (result) return result;
  }
  // Fallback: scan JSONL files in the project dir for cwd metadata
  const dirPath = path.join(CLAUDE_PROJECTS_DIR, dirName);
  try {
    for (const file of fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'))) {
      for (const line of fs.readFileSync(path.join(dirPath, file), 'utf8').split('\n')) {
        if (!line.includes('"cwd"')) continue;
        try {
          const obj = JSON.parse(line);
          if (typeof obj.cwd === 'string') return obj.cwd;
        } catch {}
      }
    }
  } catch {}
  return '/' + parts.join('/');
}

function parseTitleFromJsonl(jsonlPath) {
  try {
    const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines.slice(0, 10)) {
      try {
        const rec = JSON.parse(line);
        if (rec.type === 'user') {
          const content = rec.message?.content;
          if (typeof content === 'string' && content.trim()) {
            return content.trim().slice(0, 60);
          }
          if (Array.isArray(content)) {
            const text = content.filter(c => c.type === 'text').map(c => c.text).join(' ');
            if (text.trim()) return text.trim().slice(0, 60);
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

module.exports = { normalizePath, isPathInside, dirNameToCwd, parseTitleFromJsonl };
