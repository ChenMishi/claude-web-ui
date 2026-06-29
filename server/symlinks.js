const fs = require('fs');
const path = require('path');
const { getProjectDirName, getSessionWorkDir } = require('./store');
const { CLAUDE_PROJECTS_DIR, getUserDataDir } = require('./config');

/**
 * After a session completes, ensure real data lives in {cwd}/.claude/sessions/
 * and the user's projects dir contains only symlinks.
 *
 * During streaming, the SDK always writes .jsonl and subagents/ to
 * CLAUDE_PROJECTS_DIR (~/.claude/projects/). This function moves those
 * real files to the work dir and replaces them with symlinks.
 */
function ensureProjectSymlinks(cwd, sessionId, authUser) {
  const workDir = getSessionWorkDir(cwd);
  const projectsDir = getUserDataDir(authUser).projects;
  const dirName = getProjectDirName(cwd);
  const linkDir = path.join(projectsDir, dirName);
  // SDK always writes to global CLAUDE_PROJECTS_DIR (root's home), not user projects dir
  const globalLinkDir = path.join(CLAUDE_PROJECTS_DIR, dirName);

  try { fs.mkdirSync(linkDir, { recursive: true }); } catch {}
  try { fs.mkdirSync(workDir, { recursive: true }); } catch {}

  // .cwd file — always write to user's projects dir for project discovery
  try {
    fs.writeFileSync(path.join(linkDir, '.cwd'), path.resolve(cwd));
  } catch {}

  // Source directories to check for real files (SDK writes to global, not user dir)
  const sourceDirs = [linkDir];
  if (linkDir !== globalLinkDir) sourceDirs.push(globalLinkDir);

  // SDK may write to the - convention directory (SDK uses - as path separator).
  // E.g. for cwd=/root, SDK uses "-root" while web UI uses "_root".
  // Since -root may be a symlink to _root (from migration), check both conventions
  // so we migrate real files regardless of which name the SDK chose.
  const altDirName = dirName.replace(/_/g, '-');
  let altUserDir = null, altGlobalDir = null;
  if (altDirName !== dirName) {
    altUserDir = path.join(projectsDir, altDirName);
    if (!sourceDirs.includes(altUserDir)) sourceDirs.push(altUserDir);
    altGlobalDir = path.join(CLAUDE_PROJECTS_DIR, altDirName);
    if (!sourceDirs.includes(altGlobalDir)) sourceDirs.push(altGlobalDir);
  }

  // Individual files: .jsonl, .meta.json
  for (const name of [sessionId + '.jsonl', sessionId + '.meta.json']) {
    const realPath = path.join(workDir, name);
    const projectsPath = path.join(linkDir, name);

    // Already a symlink → already migrated, skip
    try {
      if (fs.lstatSync(projectsPath).isSymbolicLink()) continue;
    } catch {}

    // Already in work dir → just create symlink from projects dir
    if (fs.existsSync(realPath)) {
      try { fs.unlinkSync(projectsPath); } catch {}
      createRelSymlink(realPath, projectsPath);
      continue;
    }

    // Search source dirs for the real file to move
    let moved = false;
    for (const sourceDir of sourceDirs) {
      const sourcePath = path.join(sourceDir, name);
      try {
        if (fs.existsSync(sourcePath) && !fs.lstatSync(sourcePath).isSymbolicLink()) {
          fs.mkdirSync(path.dirname(realPath), { recursive: true });
          fs.renameSync(sourcePath, realPath);
          if (!createRelSymlink(realPath, projectsPath)) {
            // Symlink failed → copy file back so SDK can still resume
            fs.copyFileSync(realPath, sourcePath);
          }
          moved = true;
          break;
        }
      } catch (e) {
        console.log('[symlink] move failed for', name, 'from', sourceDir, ':', e.message);
      }
    }
    // If we didn't find a real file to move but there's a stale projects copy, remove it
    if (!moved && fs.existsSync(projectsPath)) {
      try { fs.unlinkSync(projectsPath); } catch {}
    }
  }

  // Session directory ({sessionId}/): contains subagents/ from SDK, tool-results/ from us
  const realDir = path.join(workDir, sessionId);
  const projectsDirLink = path.join(linkDir, sessionId);

  // If already a symlink, skip
  let isSymlink = false;
  try { isSymlink = fs.lstatSync(projectsDirLink).isSymbolicLink(); } catch {}

  if (!isSymlink) {
    try { fs.mkdirSync(realDir, { recursive: true }); } catch {}

    // Merge contents from any source directory that has them
    for (const sourceDir of sourceDirs) {
      const sourceDirPath = path.join(sourceDir, sessionId);
      try {
        if (fs.existsSync(sourceDirPath) && fs.statSync(sourceDirPath).isDirectory()
            && !fs.lstatSync(sourceDirPath).isSymbolicLink()) {
          mergeDir(sourceDirPath, realDir);
          fs.rmSync(sourceDirPath, { recursive: true, force: true });
        }
      } catch (e) {
        console.log('[symlink] merge dir failed for', sourceDir, ':', e.message);
      }
    }

    // Remove stale projects dir link if it exists as a real dir
    try {
      if (fs.existsSync(projectsDirLink) && !fs.lstatSync(projectsDirLink).isSymbolicLink()) {
        fs.rmSync(projectsDirLink, { recursive: true, force: true });
      }
    } catch {}

    // Create symlink from projects dir → work dir
    createRelSymlink(realDir, projectsDirLink);
  }

  // ── Ensure - convention dirs are symlinks to _ convention dirs ──
  // SDK binary uses - as path separator (e.g. -data-temp), web UI uses _.
  // The startup migration handles existing dirs, but new project dirs created
  // mid-session need this to be set up on-the-fly. Without this, the SDK's
  // resume lookup in -dir/ will miss sessions whose files were moved to work dir.
  //
  // Also ensure the - convention dirs have symlinks for the .jsonl/.meta.json
  // files, in case the directory symlink didn't exist when the file was written.
  if (altDirName !== dirName) {
    for (const altDir of [altUserDir, altGlobalDir].filter(Boolean)) {
      if (!altDir) continue;
      // Convert alt dir to a symlink if it's a real directory
      try {
        if (fs.existsSync(altDir) && !fs.lstatSync(altDir).isSymbolicLink()) {
          // Merge any remaining files into the _ convention dir, then replace with symlink
          for (const entry of fs.readdirSync(altDir, { withFileTypes: true })) {
            const src = path.join(altDir, entry.name);
            const dst = path.join(linkDir, entry.name);
            try {
              if (!fs.existsSync(dst)) fs.renameSync(src, dst);
              else if (entry.isFile()) { try { fs.unlinkSync(src); } catch {} }
            } catch {}
          }
          try { fs.rmdirSync(altDir); } catch {}
        }
      } catch {}
      // Create or recreate the alt dir as a symlink to the _ convention dir
      try {
        if (!fs.existsSync(altDir)) {
          createRelSymlink(linkDir, altDir);
        } else if (!fs.lstatSync(altDir).isSymbolicLink()) {
          try { fs.rmSync(altDir, { recursive: true, force: true }); } catch {}
          createRelSymlink(linkDir, altDir);
        }
      } catch {}
    }
  }
}

// Create relative symlink: linkPath → target. Returns true on success.
function createRelSymlink(target, linkPath) {
  try {
    const relative = path.relative(path.dirname(linkPath), target);
    fs.symlinkSync(relative, linkPath);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') {
      console.log('[symlink] create failed for', linkPath, ':', e.message);
    }
    return false;
  }
}

// Move contents from srcDir to dstDir (non-destructive merge)
function mergeDir(srcDir, dstDir) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(dst)) {
        fs.renameSync(src, dst);
      } else {
        mergeDir(src, dst);
        try { fs.rmdirSync(src); } catch {}
      }
    } else {
      if (!fs.existsSync(dst)) {
        fs.renameSync(src, dst);
      } else {
        try { fs.unlinkSync(src); } catch {}  // dst already has it, discard src
      }
    }
  }
}

module.exports = { ensureProjectSymlinks };
