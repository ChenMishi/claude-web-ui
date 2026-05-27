const fs = require('fs');
const path = require('path');
const { parseSkillFile, serializeSkill, validateSkill } = require('./parser');

const BUILTIN_DIR = path.resolve(__dirname, '..', 'builtin-skills');
const SHARED_SKILLS_DIR = path.join(
  (process.env.HOME || '/root'), '.claude-web-ui', 'skills'
);
const CLAUDE_SKILLS_DIR = path.join(
  (process.env.HOME || '/root'), '.claude', 'skills'
);

/**
 * Get the user's personal skills directory.
 */
function getUserSkillsDir(user) {
  if (!user || user.role === 'admin') {
    return path.join(process.env.HOME || '/root', '.claude-web-ui', 'skills');
  }
  const base = user.homeDir || `/home/${user.username}`;
  return path.join(base, '.claude-web-ui', 'skills');
}

/**
 * Scan a directory for .md skill files and parse them.
 */
function scanDir(dir) {
  const skills = [];
  if (!fs.existsSync(dir)) return skills;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
      const filePath = path.join(dir, ent.name);
      const skill = parseSkillFile(filePath);
      if (skill && skill.meta.name) {
        skills.push({
          ...skill.meta,
          body: skill.body,
          filePath,
          source: 'user',
        });
      }
    }
  } catch {}
  return skills;
}

/**
 * List all available skills for a user, respecting the layer hierarchy.
 * Layer priority: project > user > shared > builtin
 * Deduplication: same name → first found wins (project highest priority).
 */
function listSkills(user, projectDir) {
  const seen = new Map();

  // Layer 1: Built-in (lowest priority)
  for (const s of scanDir(BUILTIN_DIR)) {
    s.source = 'builtin';
    s.editable = false;
    if (!seen.has(s.name)) seen.set(s.name, s);
  }

  // Layer 2: Shared (higher priority)
  for (const s of scanDir(SHARED_SKILLS_DIR)) {
    s.source = 'shared';
    s.editable = user?.role === 'admin';
    seen.set(s.name, s);
  }

  // Layer 2.5: Claude Code user skills (~/.claude/skills/)
  for (const s of scanDir(CLAUDE_SKILLS_DIR)) {
    s.source = 'claude';
    s.editable = true;
    seen.set(s.name, s);
  }

  // Layer 3: User personal (higher priority)
  const userDir = getUserSkillsDir(user);
  for (const s of scanDir(userDir)) {
    s.source = 'personal';
    s.editable = true;
    seen.set(s.name, s); // Override
  }

  // Layer 4: Project (highest priority)
  if (projectDir) {
    const projectSkillsDir = path.join(projectDir, '.claude', 'skills');
    for (const s of scanDir(projectSkillsDir)) {
      s.source = 'project';
      s.editable = true;
      seen.set(s.name, s); // Override
    }
  }

  return Array.from(seen.values());
}

/**
 * Get a single skill by name. Returns null if not found.
 */
function getSkill(name, user, projectDir) {
  const skills = listSkills(user, projectDir);
  return skills.find(s => s.name === name) || null;
}

/**
 * Determine which directory to save a skill to.
 * Admin can save to shared, user saves to personal.
 */
function getSaveDir(user, targetScope) {
  if (user?.role === 'admin' && targetScope === 'shared') {
    if (!fs.existsSync(SHARED_SKILLS_DIR)) {
      fs.mkdirSync(SHARED_SKILLS_DIR, { recursive: true });
    }
    return SHARED_SKILLS_DIR;
  }
  const dir = getUserSkillsDir(user);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Create a new skill.
 */
function createSkill(meta, body, user, targetScope) {
  const validation = validateSkill(meta, body);
  if (!validation.valid) {
    return { ok: false, errors: validation.errors };
  }

  const saveDir = getSaveDir(user, targetScope);
  const filePath = path.join(saveDir, `${meta.name}.md`);

  if (fs.existsSync(filePath)) {
    return { ok: false, errors: [`技能 "${meta.name}" 已存在`] };
  }

  const content = serializeSkill(meta, body);
  fs.writeFileSync(filePath, content, 'utf8');

  // Sync to Claude Code skills directory so slash-commands work
  syncToClaudeDir(meta.name, content);

  return { ok: true, filePath };
}

/**
 * Update an existing skill.
 */
function updateSkill(name, meta, body, user, projectDir) {
  const skill = getSkill(name, user, projectDir);
  if (!skill) {
    return { ok: false, errors: [`技能 "${name}" 不存在`] };
  }
  if (!skill.editable) {
    return { ok: false, errors: ['不能修改内置技能'] };
  }

  const validation = validateSkill(meta, body);
  if (!validation.valid) {
    return { ok: false, errors: validation.errors };
  }

  const content = serializeSkill(meta, body);
  fs.writeFileSync(skill.filePath, content, 'utf8');

  // Sync to Claude Code skills directory
  syncToClaudeDir(name, content);

  return { ok: true, filePath: skill.filePath };
}

/**
 * Delete a skill.
 */
function deleteSkill(name, user, projectDir) {
  const skill = getSkill(name, user, projectDir);
  if (!skill) {
    return { ok: false, errors: [`技能 "${name}" 不存在`] };
  }
  if (!skill.editable) {
    return { ok: false, errors: ['不能删除内置技能'] };
  }

  try {
    fs.unlinkSync(skill.filePath);
    // Also remove from Claude Code skills directory
    const claudePath = path.join(CLAUDE_SKILLS_DIR, `${name}.md`);
    try { if (fs.existsSync(claudePath)) fs.unlinkSync(claudePath); } catch {}
    return { ok: true };
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }
}

/**
 * Sync a skill file to the Claude Code skills directory (~/.claude/skills/).
 * This is the standard path Claude Code uses for user-level skills,
 * enabling slash-command recognition.
 */
function syncToClaudeDir(name, content) {
  try {
    if (!fs.existsSync(CLAUDE_SKILLS_DIR)) {
      fs.mkdirSync(CLAUDE_SKILLS_DIR, { recursive: true });
    }
    const claudePath = path.join(CLAUDE_SKILLS_DIR, `${name}.md`);
    fs.writeFileSync(claudePath, content, 'utf8');
  } catch (err) {
    console.error(`[skills] Failed to sync skill "${name}" to Claude dir:`, err.message);
  }
}

module.exports = {
  BUILTIN_DIR, SHARED_SKILLS_DIR, CLAUDE_SKILLS_DIR,
  getUserSkillsDir, listSkills, getSkill,
  createSkill, updateSkill, deleteSkill,
  getSaveDir, syncToClaudeDir,
};
