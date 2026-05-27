const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Parse a skill markdown file with YAML frontmatter.
 * Returns { meta, body, filePath } or null on error.
 */
function parseSkillFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return parseSkillContent(raw, filePath);
  } catch {
    return null;
  }
}

/**
 * Parse skill content string (markdown with YAML frontmatter).
 */
function parseSkillContent(content, filePath) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    // No frontmatter — treat entire content as body
    return { meta: {}, body: content.trim(), filePath: filePath || null };
  }
  try {
    const meta = yaml.load(match[1]) || {};
    const body = (match[2] || '').trim();
    return { meta, body, filePath: filePath || null };
  } catch {
    return { meta: {}, body: content.trim(), filePath: filePath || null };
  }
}

/**
 * Serialize a skill to markdown string.
 */
function serializeSkill(meta, body) {
  const frontmatter = yaml.dump(meta, { lineWidth: -1, noCompatMode: true });
  return `---\n${frontmatter}---\n\n${body || ''}\n`;
}

/**
 * Validate skill metadata. Returns { valid, errors[] }.
 */
function validateSkill(meta, body) {
  const errors = [];
  if (!meta.name || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(meta.name)) {
    errors.push('name 必须以小写字母/数字开头和结尾，只包含小写字母、数字和短横线');
  }
  if (!meta.displayName || !meta.displayName.trim()) {
    errors.push('displayName 不能为空');
  }
  if (!body || !body.trim()) {
    errors.push('技能内容（body）不能为空');
  }
  if (meta.allowedTools && !Array.isArray(meta.allowedTools)) {
    errors.push('allowedTools 必须是数组');
  }
  if (meta.deniedTools && !Array.isArray(meta.deniedTools)) {
    errors.push('deniedTools 必须是数组');
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { parseSkillFile, parseSkillContent, serializeSkill, validateSkill };
