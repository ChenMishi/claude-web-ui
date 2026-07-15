const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { CLAUDE_PROJECTS_DIR, SESSIONS_DIR, STATS_DIR, getUserDataDir } = require('../config');

// 从 init-config.json 读取代理地址，默认 127.0.0.1:15721
function getProxyUrl() {
  try {
    const configFile = path.join(path.resolve(__dirname, '..', '..'), 'init-config.json');
    if (fs.existsSync(configFile)) {
      const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (cfg.proxyUrl) return cfg.proxyUrl;
    }
  } catch {}
  return 'http://127.0.0.1:15721';
}
const { dirNameToCwd, parseTitleFromJsonl } = require('../utils');
const { findUserById } = require('../auth/users');
const { requireAuth } = require('../middleware/auth');
const {
  getRuntimeSession, deleteRuntimeSession, getOrCreateRuntime,
  createPendingRuntime, assignSessionId, resolvePendingApproval, setPendingApproval,
  broadcast, subscribeToStream, broadcastDone, getSessionWorkDir,
} = require('../store');
const { ensureProjectSymlinks } = require('../symlinks');

// Agent SDK — enables full tool calling (Bash, Read, Write, Edit, etc.)
// The SDK and its platform binary are npm dependencies (see package.json)
let query;
try { query = require('@anthropic-ai/claude-agent-sdk').query; } catch { /* will fall back to no-tool mode */ }

function findSDKBinary() {
  try {
    // sdkEntry = .../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
    const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
    // Go to the SDK package dir, then sibling binary package
    const sdkDir = path.dirname(sdkEntry);
    const arch = process.arch === 'x64' ? 'x64' : 'arm64';
    // Binary is a sibling of the SDK package: @anthropic-ai/claude-agent-sdk-linux-x64/claude
    const candidates = [
      path.join(sdkDir, '..', `claude-agent-sdk-${process.platform}-${arch}`, 'claude'),
      path.join(sdkDir, '..', `claude-agent-sdk-${process.platform}-${arch}-musl`, 'claude'),
    ];
    for (const bin of candidates) {
      if (fs.existsSync(bin)) {
        console.log('[SDK] Binary found at:', bin);
        return bin;
      }
    }
    console.warn('[SDK] Binary not found, SDK will search internally. Checked:', candidates[0]);
    return null;
  } catch (err) {
    console.warn('[SDK] Error finding binary:', err.message);
    return null;
  }
}

const SDK_BINARY = findSDKBinary();

// Separate storage for AskUserQuestion context (module-level)
const askQuestionContext = new Map();

const router = Router();

function sseWrite(res, ev) {
  try {
    if (res.writableEnded) return;
    const chunk = `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
    if (!res.write(chunk)) {
      // Backpressure — drain is fine, we just wait for it
      res.once('drain', () => {});
    }
  } catch {}
}

function logError(msg, err) {
  try {
    const path = require('path');
    const fs = require('fs');
    const dir = path.resolve(__dirname, '..', '..', 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toLocaleString('sv-SE');
    fs.appendFileSync(`${dir}/server-error.log`, `${ts} ${msg} ${err?.message || err}\n`);
  } catch {}
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Extract file paths from Bash commands and their results ──
function extractBashFilePaths(command, resultContent, cwd, sessionStartTime) {
  const paths = [];
  if (!command || !cwd) return paths;

  // Detect cd prefix(es) for accurate relative path resolution
  // e.g. "cd /x && tar czf file.tar.gz" → file is in /x, not cwd
  const cdMatches = [...command.matchAll(/(?:^|&&\s*|;\s*)cd\s+(\S+)/g)];
  let effectiveCwd = cwd;
  if (cdMatches.length > 0) {
    const lastCd = cdMatches[cdMatches.length - 1][1].replace(/^['"]|['"]$/g, '');
    effectiveCwd = lastCd.startsWith('/') ? lastCd : path.join(cwd, lastCd);
  }

  // 1. Output redirection: > file (creating new, NOT >> which is appending)
  for (const m of command.matchAll(/(?:^|\s)(?:[12]?>|&>)\s*(\S+)/g)) {
    const p = m[1].replace(/^['"]|['"]$/g, '');
    if (p && !p.startsWith('/dev/')) paths.push(p);
  }

  // 2. tee command (tee file, tee -a file)
  for (const m of command.matchAll(/tee\s+(?:-[a-zA-Z]+\s+)*(\S+)/g)) {
    if (!m[1].startsWith('-')) paths.push(m[1]);
  }

  // 3. touch command — NOT collected: touch only updates timestamps (or creates empty placeholder),
  //    not a reliable artifact signal. If a file is later written with content, the Write tool
  //    detection will catch it instead.
  // (removed — was collecting false positives)

  // 4. mkdir -p
  for (const m of command.matchAll(/mkdir\s+(?:-[a-zA-Z]+\s+)*(\S+)/g)) {
    if (!m[1].startsWith('-')) paths.push(m[1]);
  }

  // 5. curl -o / wget -O
  for (const m of command.matchAll(/(?:curl|wget)\s+.*?\s-(o|O)\s*(\S+)/g)) {
    paths.push(m[2]);
  }

  // 6. dd of=
  for (const m of command.matchAll(/dd\s+.*?\bof=(\S+)/g)) {
    paths.push(m[1]);
  }

  // 6b. tar -czf / tar czf / tar -c -z -f (output follows f flag)
  const tarPaths = new Set();
  // Combined flags: tar -czf file, tar czf file
  for (const m of command.matchAll(/tar\s+-?[a-zA-Z]*f\s+(\S+)/g)) {
    if (!m[1].startsWith('-')) tarPaths.add(m[1]);
  }
  // Separate -f flag: tar -c -z -f file
  for (const m of command.matchAll(/tar\s+.*?\s-f\s+(\S+)/g)) {
    if (!m[1].startsWith('-')) tarPaths.add(m[1]);
  }
  for (const p of tarPaths) paths.push(p);

  // 6c. zip output.zip files... (first positional arg after flags is output)
  const zipM = command.match(/(?:^|\s)zip\s+(?:-[a-zA-Z0-9]+\s+)*(\S+)/);
  if (zipM && !zipM[1].startsWith('-')) paths.push(zipM[1]);

  // 6d. 7z a output.7z files... (arg after 'a' is output)
  const sevenZM = command.match(/(?:^|\s)7z\s+a\s+(\S+)/);
  if (sevenZM) paths.push(sevenZM[1]);

  // 6e. gzip / bzip2 / xz file (output is file.gz / file.bz2 / file.xz)
  for (const m of command.matchAll(/(?:^|\s)(?:gzip|bzip2|xz)\s+(?:-[a-zA-Z0-9]+\s+)*(\S+)/g)) {
    const p = m[1];
    if (!p.startsWith('-')) {
      paths.push(p);
      const extMap = { gzip: '.gz', bzip2: '.bz2', xz: '.xz' };
      const cmdName = m[0].trim().split(/\s+/)[0];
      const ext = extMap[cmdName];
      if (ext) paths.push(p + ext);
    }
  }

  // 6f. convert/magick input [options] output  (ImageMagick)
  const convertM = command.match(/(?:^|\s)(?:convert|magick)\s+(?:\S+\s+)+(?:-[a-zA-Z]+\s+\S+\s+)*(\S+?)(?:\s*&&|\s*;|\s*\||\s*$)/);
  if (convertM && !convertM[1].startsWith('-')) paths.push(convertM[1]);

  // 6g. ffmpeg -i input ... output  (ffmpeg output is last non-flag arg)
  const ffmpegM = command.match(/(?:^|\s)ffmpeg\s+(?:-[a-zA-Z0-9]+\s+\S+\s+)*.*?(\S+?)(?:\s*&&|\s*;|\s*\||\s*$)/);
  if (ffmpegM && !ffmpegM[1].startsWith('-') && ffmpegM[1] !== '2') paths.push(ffmpegM[1]);

  // 7. cp destination (last arg before && / ; / |) — copying is creating a new file
  const cpM = command.match(/(?:^|;\s*)cp\s+(?:-[a-zA-Z]+\s+)*(?:\S+\s+)+?(\S+?)(?:\s*&&|\s*;|\s*\||\s*$)/);
  if (cpM && !cpM[1].match(/^-[a-zA-Z]/)) paths.push(cpM[1]);

  // 8. From result: "The file /path has been updated successfully."
  for (const m of (resultContent || '').matchAll(/(?:^|\n)The file (\S+) has been updated/gm)) {
    paths.push(m[1]);
  }

  // 9. From result: "File created/written at: /path"
  for (const m of (resultContent || '').matchAll(/File (?:created|written) (?:successfully )?at:\s*(\S+)/gi)) {
    paths.push(m[1]);
  }

  // 10. From result: "create mode 100644 path/to/file" (git output)
  for (const m of (resultContent || '').matchAll(/create mode \d+ (.+)/g)) {
    paths.push(m[1]);
  }

  // 11. Scan result content AND command for absolute paths with common file extensions
  //     Catches Python/openpyxl/docx/ImageMagick/ffmpeg/etc output
  //     Scan BOTH result AND command — Python to_excel() doesn't print paths
  //     Skip read-only commands (ls, grep, cat, etc.) — their output lists existing files, not artifacts
  const readOnlyCmdRe = /^(?:ls|grep|cat|head|tail|find|stat|file|wc|du|df|echo|printf|which|type|pwd|whoami|id|uname|hostname|free|uptime|ps|readlink|realpath|basename|dirname|node|git|npm|npx|python|python3|cp|mv|chmod|chown|mkdir|rmdir|touch)\b/;
  const strippedCmd = command.trim().replace(/^(?:cd\s+\S+\s*(?:&&|;)\s*)+/, '');
  if (!readOnlyCmdRe.test(strippedCmd)) {
  const resultExtRe = /(\/(?:[^\s"'`]+\/)*[^\s"'`]+\.(?:png|jpe?g|gif|webp|bmp|svg|ico|pdf|docx?|xlsx?|pptx?|zip|tar|gz|tgz|bz2|xz|7z|rar|csv|tsv|txt|md|json|yaml|yml|xml|html?|css|py|js|ts|sh|sql|db|sqlite3?|pkl|h5|pt|onnx|npy|npz|env|cfg|ini|toml|lock|log))(?:\b|$)/gi;
  const scanText = (resultContent || '') + '\n' + (command || '');
  for (const m of scanText.matchAll(resultExtRe)) {
    paths.push(m[1]);
  }

  // 12. Scan result content for relative paths with archive/doc/image extensions
  //     Catches "Created output.zip", "打包完成: archive.tar.gz", "生成 report.xlsx" etc.
  //     Exclude fullwidth colon/comma from filename capture to avoid greedy matching
  const relativeExtRe = /(?:^|\s|[：:])['"]?([^\s"'`：]{1,200}\.(?:zip|tar|gz|tgz|bz2|xz|7z|rar|xlsx?|docx?|pptx?|pdf|csv|png|jpe?g|gif|webp|svg))['"]?(?:\s|$|[,，。.])/gmi;
  for (const m of (resultContent || '').matchAll(relativeExtRe)) {
    const p = m[1].replace(/^['"]|['"]$/g, '');
    if (p && !p.startsWith('/') && !p.startsWith('-')) {
      paths.push(p);
    }
  }
  } // end read-only command guard

  // Resolve relative paths and deduplicate
  const os = require('os');
  const resolved = [...new Set(paths.map(p => {
    p = p.replace(/^['"]|['"]$/g, '');
    if (p.startsWith('/')) return p;
    if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
    return path.join(effectiveCwd, p);
  }))];

  // Only return actual files that exist AND were created/modified during this session
  // (prevents collecting pre-existing project files mentioned in Bash output)
  const threshold = (sessionStartTime || 0) - 5000; // 5s tolerance
  return resolved.filter(p => {
    try {
      if (!fs.existsSync(p)) return false;
      const stat = fs.statSync(p);
      if (stat.isDirectory()) return false;
      if (sessionStartTime && stat.mtimeMs < threshold) return false;
      return true;
    } catch { return false; }
  });
}

// ── Filter artifact paths: keep only meaningful user-facing files ──
function filterArtifactPaths(absPaths, cwd) {
  const cwdAbs = path.resolve(cwd || '/');

  // Directories and extensions to exclude
  const excludeDirs = new Set([
    'node_modules', '__pycache__', '.git', 'dist', 'build', '.next',
    'target', 'out', 'coverage', '.cache', 'vendor', 'bower_components',
  ]);
  const excludeExts = new Set([
    '.pyc', '.pyo', '.o', '.obj', '.class', '.dll', '.so', '.dylib',
    '.wasm', '.map', '.tsbuildinfo', '.log',
  ]);

  return absPaths.filter(p => {
    // 1. Must be inside project cwd (exclude /tmp, /var, system paths etc.)
    if (!p.startsWith(cwdAbs + path.sep) && p !== cwdAbs) return false;

    // 2. No hidden files (exclude filenames starting with ., like .env, .DS_Store)
    //    Directories starting with . are allowed (e.g. .claude-web-ui, .claude, .vscode)
    const basename = path.basename(p);
    if (basename.startsWith('.')) return false;

    // 3. No files inside junk directories
    const rel = p.slice(cwdAbs.length);
    const segments = rel.split(path.sep).filter(Boolean);
    if (segments.length > 1 && segments.slice(0, -1).some(s => excludeDirs.has(s))) return false;

    // 4. No compiled/transient file extensions
    if (excludeExts.has(path.extname(p).toLowerCase())) return false;

    return true;
  });
}

// ── Extract file paths from user prompt text (for "帮我把这个excel加一个sheet" etc.) ──
function extractUserMentionedFiles(runtime) {
  const files = new Map(); // absolutePath → toolResultsName
  const cwd = runtime.cwd || '/';
  const prompt = runtime.userPrompt || '';
  const sessionStart = runtime.sessionStartTime || 0;

  if (!prompt && !runtime.attachmentPaths?.length) return files;

  // Build search text: user prompt + attachment filenames
  const attachmentNames = (runtime.attachmentPaths || []).map(p => path.basename(p));
  const searchText = prompt + ' ' + attachmentNames.join(' ');

  // Extract candidate filenames from text:
  //   - quoted paths: "xxx.xlsx", 'src/utils/helper.ts'
  //   - bare paths with extensions: xxx.sh, src/xxx.ts
  //   - attachment basenames
  const candidates = new Set();

  // Quoted strings
  for (const m of searchText.matchAll(/["'`]([^"'`]+?\.[a-zA-Z0-9]{1,8})["'`]/g)) {
    candidates.add(m[1]);
  }
  // Bare paths with known extensions (including compound extensions like .tar.gz)
  for (const m of searchText.matchAll(/(?:^|\s|[、，,])([^\s、，,]{1,120}\.(?:tar\.gz|tar\.bz2|tar\.xz|tgz|[a-zA-Z0-9]{1,8}))(?:\s|$|[、，,.。，])/g)) {
    candidates.add(m[1]);
  }
  // Also search for bare filenames of common user-facing types (excel, word, pdf, image, script, config, archive)
  const commonExtRe = /(?:^|\s|[、，,])([^\s、，,]{1,80}\.(?:xlsx?|docx?|pptx?|pdf|csv|txt|json|yaml|yml|xml|html?|css|jsx?|tsx?|py|sh|sql|png|jpe?g|gif|webp|svg|zip|tar\.gz|tgz|7z|rar|md|toml|cfg|ini|env))(?:\s|$|[、，,.。，])/gi;
  for (const m of searchText.matchAll(commonExtRe)) {
    candidates.add(m[1]);
  }
  // Add attachment basenames
  for (const ap of (runtime.attachmentPaths || [])) {
    candidates.add(path.basename(ap));
  }

  if (candidates.size === 0) return files;

  // Find these files in the project directory tree (exclude junk dirs)
  const excludeDirs = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.next', 'target', '.cache']);

  function findInDir(dir, depth) {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || excludeDirs.has(entry.name)) continue;
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        findInDir(fp, depth + 1);
      } else if (candidates.has(entry.name)) {
        // Check if modified during this session
        try {
          const stat = fs.statSync(fp);
          if (stat.mtimeMs >= sessionStart - 5000) { // 5s tolerance
            // Build tool-results name: preserve one level of parent dir for disambiguation
            const parentName = path.basename(path.dirname(fp));
            const safeName = (parentName && parentName !== path.basename(cwd))
              ? parentName + '_' + entry.name
              : entry.name;
            // Avoid overwriting: add counter if duplicate
            let finalName = safeName;
            let counter = 1;
            const existingNames = new Set(Array.from(files.values()));
            while (existingNames.has(finalName)) {
              const ext = path.extname(safeName);
              const base = safeName.slice(0, -ext.length);
              finalName = `${base}(${counter})${ext}`;
              counter++;
            }
            files.set(fp, finalName);
          }
        } catch {}
      }
    }
  }

  findInDir(cwd, 0);

  // Also check attachment paths directly (they may be outside cwd, e.g. uploads/)
  for (const ap of (runtime.attachmentPaths || [])) {
    if (files.has(ap)) continue;
    try {
      if (fs.existsSync(ap) && fs.statSync(ap).isFile()) {
        files.set(ap, path.basename(ap));
      }
    } catch {}
  }

  return files;
}

// ── Copy collected artifact files to session's tool-results directory ──
// Stores real data at {cwd}/.claude/sessions/{sessionId}/tool-results/
function copyToToolResults(sessionId, cwd, filePaths) {
  const workDir = getSessionWorkDir(cwd);
  const resultsDir = path.join(workDir, sessionId, 'tool-results');
  try { fs.mkdirSync(resultsDir, { recursive: true }); } catch {}

  const mapping = {}; // originalPath → toolResultsPath

  for (const [srcPath, destName] of filePaths) {
    // Safety: only allow safe characters in destName
    const safeName = destName.replace(/[^a-zA-Z0-9_\-\.\(\)一-鿿]/g, '_');
    const destPath = path.join(resultsDir, safeName);
    try {
      // Overwrite if destination exists (updated version of same file)
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
      // Try hard link first (zero extra disk space, same inode)
      // Fall back to copy if cross-filesystem
      try {
        fs.linkSync(srcPath, destPath);
      } catch (linkErr) {
        if (linkErr.code === 'EXDEV' || linkErr.code === 'EPERM' || linkErr.code === 'EEXIST') {
          fs.copyFileSync(srcPath, destPath);
        } else {
          throw linkErr;
        }
      }
      mapping[srcPath] = destPath;
    } catch (e) {
      console.log('[artifact] link/copy failed for', srcPath, ':', e.message);
    }
  }

  return mapping;
}

// ── Artifact judgment: output extensions that are clearly generated files ──
const OUTPUT_EXTS = new Set([
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.ppt',
  '.pdf', '.csv',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico',
]);

// ── Source-code extensions: typically project source, not user-facing output ──
const SOURCE_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.pyi', '.java', '.go', '.rs', '.rb', '.php',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh',
  '.cs', '.swift', '.kt', '.kts', '.scala',
  '.vue', '.svelte', '.css', '.scss', '.less', '.sass',
  '.sql', '.graphql', '.proto',
  '.sh', '.bash', '.zsh', '.fish',
]);

function isOutputExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (OUTPUT_EXTS.has(ext)) return true;
  // Compound extensions: .tar.gz, .tar.bz2, .tar.xz
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tar.bz2') || lower.endsWith('.tar.xz')) return true;
  return false;
}

function isSourceExtension(filePath) {
  return SOURCE_EXTS.has(path.extname(filePath).toLowerCase());
}

// ── Rule pre-filter for Write/Edit tools: classify files as collect / llm-pending / discard ──
// Returns { collect: [...], llmPending: [...] }
function prefilterWriteEdit(runtime) {
  const pending = runtime.pendingWriteEditPaths || [];
  if (pending.length === 0) return { collect: [], llmPending: [] };

  // Build sets for S1 (user-mentioned) and S2 (attachment)
  const userMentionedAbs = new Set();
  try {
    const userFiles = extractUserMentionedFiles(runtime);
    for (const [absPath] of userFiles) {
      userMentionedAbs.add(absPath);
    }
  } catch {}

  const attachmentAbs = new Set(
    (runtime.attachmentPaths || []).map(p => {
      try { return path.resolve(runtime.cwd || '/', p); } catch { return p; }
    })
  );

  const collect = [];
  const llmPending = [];

  for (const info of pending) {
    const absPath = (() => {
      try { return path.resolve(runtime.cwd || '/', info.path); } catch { return info.path; }
    })();
    const ext = path.extname(absPath).toLowerCase();
    const isOutput = isOutputExtension(absPath);
    const isSource = isSourceExtension(absPath);
    const isUserMentioned = userMentionedAbs.has(absPath);
    const isAttachment = attachmentAbs.has(absPath);
    const isNew = !info.existedBefore;

    if (info.toolName === 'Write') {
      // S1: user mentioned → collect
      // S2: was attachment → collect
      // S4: output extension → collect
      // S3 alone (new file, not mentioned, not output) → LLM decides
      if (isUserMentioned || isAttachment || isOutput) {
        collect.push(absPath);
      } else {
        // New source/unknown file without strong signal, or existing file → LLM decides
        llmPending.push({ index: llmPending.length + collect.length, path: absPath, ...info });
      }
    } else if (info.toolName === 'Edit') {
      // S4: output extension → collect
      // S1/S2 + non-source → collect (user asked to modify a specific output file)
      if (isOutput) {
        collect.push(absPath);
      } else if ((isUserMentioned || isAttachment) && !isSource) {
        collect.push(absPath);
      } else if (isUserMentioned && isSource) {
        // User mentioned a source file → could be artifact (e.g. "modify the script I just created")
        llmPending.push({ index: llmPending.length + collect.length, path: absPath, ...info });
      } else {
        // Edit on existing non-mentioned source file → discard (not artifact)
        console.log('[artifact] Edit skip (existing source, not mentioned):', info.path);
      }
    }
  }

  return { collect, llmPending };
}

// ── LLM judgment for ambiguous files ──
async function llmJudgeArtifacts(userPrompt, pendingFiles, cwd, model) {
  if (!pendingFiles || pendingFiles.length === 0) return {};

  const proxyBase = getProxyUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    // Use the current session model directly
    const judgeModel = model || 'claude-sonnet-4-6';

    const fileList = pendingFiles.map(f => {
      const relPath = (() => {
        try { return path.relative(cwd, f.path); } catch { return f.path; }
      })();
      return `${f.index + 1}. path=${relPath}, tool=${f.toolName}, new=${!f.existedBefore}, ext=${path.extname(f.path)}`;
    }).join('\n');

    const systemPrompt = `你是一个文件分类助手。请判断以下文件哪些是用户会话的"产物"。

判断标准：
- **是产物(true)**：用户明确要求生成的脚本、文档、Office文件、图片、压缩包等；用户上传并要求修改/整理的文件；用户明确要求修改的之前生成的文件
- **不是产物(false)**：项目原有的源代码文件（即使被模型自动修改了）；项目配置文件（除非用户明确要求修改或生成）；开发过程中的临时/中间文件（测试脚本、debug输出、临时数据、构建中间产物等）

用户原始需求：
${(userPrompt || '(无)').slice(0, 500)}

文件列表：
${fileList}

请只返回JSON格式，不要任何其他文字：
{"files": {"0": true, "1": false, "2": true}}`;

    const proxyRes = await fetch(`${proxyBase}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'proxy', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: judgeModel,
        max_tokens: 200,
        messages: [{ role: 'user', content: systemPrompt }],
        stream: false,
        thinking: { type: 'disabled' },
      }),
      signal: controller.signal,
    });

    if (!proxyRes.ok) {
      console.log('[artifact] LLM judge HTTP error:', proxyRes.status);
      return null;
    }
    const data = await proxyRes.json();
    const textBlock = (data.content || []).find(c => c.type === 'text');
    if (!textBlock?.text) {
      console.log('[artifact] LLM judge: no text in response');
      return null;
    }

    let text = textBlock.text.trim();
    // Extract JSON from markdown code blocks if present
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) text = jsonMatch[0];
    const result = JSON.parse(text);
    console.log('[artifact] LLM judge result:', JSON.stringify(result.files));
    return result.files || {};
  } catch (err) {
    console.log('[artifact] LLM judge error:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Sweep working directory for new/modified output files (csv, xlsx, pdf, etc.) ──
// Catches files generated by Bash commands (Python scripts, CLI tools) that weren't
// detected by the text-based path extraction because the command output didn't
// contain a recognizable file path.
function sweepNewOutputFiles(cwd, sessionStartTime) {
  const results = new Map();
  if (!cwd || !sessionStartTime) return results;
  const threshold = sessionStartTime - 5000; // 5s tolerance

  // Output extensions that are clearly generated/user-facing files
  // Excludes source code extensions (.js, .json, .py, .md, .txt, .html, .xml, .svg)
  // that are too often project files, not user-facing artifacts
  const OUTPUT_EXT_SWEEP = new Set([
    '.csv', '.tsv', '.xlsx', '.xls', '.docx', '.pptx', '.pdf',
    '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
  ]);
  const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.cache', '.claude', '.claude-web-ui', 'venv', '.vision_cache', 'test_output', 'outputs', 'temp', 'tmp', '.pytest_cache']);

  function scan(dir, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        scan(fp, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!OUTPUT_EXT_SWEEP.has(ext)) continue;
        try {
          const stat = fs.statSync(fp);
          if (stat.mtimeMs < threshold) continue;
          const parentName = path.basename(path.dirname(fp));
          const safeName = (parentName && parentName !== path.basename(cwd))
            ? parentName + '_' + entry.name : entry.name;
          let finalName = safeName;
          let counter = 1;
          const existingNames = new Set(results.values());
          while (existingNames.has(finalName)) {
            const e = path.extname(safeName);
            finalName = safeName.slice(0, -e.length) + `(${counter})${e}`;
            counter++;
          }
          results.set(fp, finalName);
        } catch {}
      }
    }
  }

  scan(cwd, 0);
  return results;
}

// ── Finalize artifacts: collect all paths, copy to tool-results, return updated paths ──
async function finalizeArtifacts(runtime, extractedPaths, authUser) {
  const sessionId = runtime.sessionId;
  const cwd = runtime.cwd;
  if (!sessionId || !cwd) return extractedPaths;

  const allFiles = new Map(); // absPath → destName

  // 1. Collect paths from Bash tools (already filtered by extractBashFilePaths + filterArtifactPaths)
  for (const [, paths] of Object.entries(extractedPaths || {})) {
    for (const p of paths) {
      // Skip temp/dev/test files
      if (/[._-](?:tmp|temp|test|test_|spec|mock|fixture)/i.test(path.basename(p))) continue;
      // Skip source files — Bash-modified .js/.py/.sh etc. are project code, not user-facing artifacts
      if (isSourceExtension(p)) continue;
      if (!allFiles.has(p)) {
        try {
          if (fs.existsSync(p) && fs.statSync(p).isFile()) {
            allFiles.set(p, path.basename(p));
          }
        } catch {}
      }
    }
  }

  // 2. Process Write/Edit paths with rule pre-filter + optional LLM judgment
  const prefilterResult = prefilterWriteEdit(runtime);
  console.log('[artifact] prefilter: collect', prefilterResult.collect.length,
    'llmPending', prefilterResult.llmPending.length);

  // Collect rule-decided files
  for (const absPath of prefilterResult.collect) {
    if (!allFiles.has(absPath)) {
      try {
        if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
          allFiles.set(absPath, path.basename(absPath));
        }
      } catch {}
    }
  }

  // LLM judgment for ambiguous files (if enabled and files pending)
  if (prefilterResult.llmPending.length > 0) {
    let llmEnabled = true; // default enabled
    try {
      const configFile = path.join(path.resolve(__dirname, '..', '..'), 'init-config.json');
      if (fs.existsSync(configFile)) {
        const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        if (cfg.aiArtifactJudge !== undefined) llmEnabled = cfg.aiArtifactJudge;
      }
    } catch {}

    if (llmEnabled) {
      console.log('[artifact] LLM judge: sending', prefilterResult.llmPending.length, 'files to model');
      const llmResult = await llmJudgeArtifacts(
        runtime.userPrompt || '',
        prefilterResult.llmPending,
        cwd,
        runtime.model
      );

      if (llmResult) {
        for (const f of prefilterResult.llmPending) {
          const key = String(f.index);
          if (llmResult[key] === true) {
            if (!allFiles.has(f.path)) {
              try {
                if (fs.existsSync(f.path) && fs.statSync(f.path).isFile()) {
                  allFiles.set(f.path, path.basename(f.path));
                }
              } catch {}
            }
          }
        }
      } else {
        // LLM failed → discard ambiguous files (can't judge without LLM)
        console.log('[artifact] LLM judge failed, discarding', prefilterResult.llmPending.length, 'ambiguous files');
      }
    } else {
      // LLM disabled → discard ambiguous files (no judgment available)
      console.log('[artifact] LLM judge disabled, discarding', prefilterResult.llmPending.length, 'ambiguous files');
    }
  }

  // 3. Collect user-mentioned files from prompt (S1 — strong signal, always collect)
  const userFiles = extractUserMentionedFiles(runtime);
  for (const [p, name] of userFiles) {
    if (!allFiles.has(p)) allFiles.set(p, name);
  }

  // 4. Sweep working directory for new output files not caught by Bash/WEdit extraction
  //    Covers Bash-generated CSVs, PDFs, images etc. that weren't mentioned in command output
  const sweptFiles = sweepNewOutputFiles(cwd, runtime.sessionStartTime);
  for (const [p, name] of sweptFiles) {
    if (!allFiles.has(p)) {
      allFiles.set(p, name);
      console.log('[artifact] sweep found:', name);
    }
  }

  if (allFiles.size === 0) return extractedPaths;

  console.log('[artifact] finalizeArtifacts: collected', allFiles.size, 'files for session', sessionId);

  // 5. Copy to tool-results directory (in cwd/.claude/sessions/)
  const mapping = copyToToolResults(sessionId, cwd, allFiles);
  console.log('[artifact] copied', Object.keys(mapping).length, 'files to tool-results');

  // 6. Create symlinks in ~/.claude/projects/ for centralized management
  try { ensureProjectSymlinks(cwd, sessionId, authUser); } catch (e) {
    console.log('[artifact] symlink creation failed:', e.message);
  }

  // 7. Update extractedPaths with tool-results paths
  const updatedPaths = {};
  for (const [toolId, paths] of Object.entries(extractedPaths || {})) {
    updatedPaths[toolId] = paths.map(p => mapping[p] || p).filter(p => {
      try { return fs.existsSync(p); } catch { return false; }
    });
  }
  // Also include Write/Edit and user-mentioned files (these don't have tool_use_ids in extractedPaths)
  const writeEditPaths = [];
  const userMentionedPaths = [];
  for (const [absPath] of allFiles) {
    if (mapping[absPath] && !Object.values(extractedPaths || {}).some(arr => arr.includes(absPath))) {
      writeEditPaths.push(mapping[absPath]);
    }
  }
  for (const [absPath] of userFiles) {
    if (mapping[absPath]) userMentionedPaths.push(mapping[absPath]);
  }
  if (writeEditPaths.length > 0) updatedPaths['write-edit'] = writeEditPaths;
  if (userMentionedPaths.length > 0) updatedPaths['user-mentioned'] = userMentionedPaths;

  return updatedPaths;
}

function handleSDKMessage(message, runtime, isStreaming) {

  if (message.type === 'system') {
    if (message.session_id && !runtime.sessionId) {
      assignSessionId(runtime, message.session_id);
      // Notify frontend so it knows the sessionId as early as possible
      if (isStreaming) broadcast(runtime, 'session', { sessionId: message.session_id });
    }
    return;
  }

  if (message.type === 'assistant') {
    if (isStreaming) {
      // Store Bash commands and Write/Edit tool file paths for artifact extraction
      if (!runtime.bashCommands) runtime.bashCommands = new Map();
      if (!runtime.writeFilePaths) runtime.writeFilePaths = new Map();
      const content = message.message?.content || [];
      for (const block of content) {
        if (block.type === 'tool_use' && block.name === 'Bash' && block.id) {
          runtime.bashCommands.set(block.id, block.input?.command || '');
          console.log('[artifact] stored Bash cmd:', block.id, '→', (block.input?.command || '').slice(0, 120));
        }
        if (block.type === 'tool_use' && block.name === 'Write' && block.id && block.input?.file_path) {
          const absPath = path.resolve(runtime.cwd || '/', block.input.file_path);
          runtime.writeFilePaths.set(block.id, { path: block.input.file_path, existedBefore: fs.existsSync(absPath), toolName: 'Write' });
        }
        if (block.type === 'tool_use' && block.name === 'Edit' && block.id && block.input?.file_path) {
          const absPath = path.resolve(runtime.cwd || '/', block.input.file_path);
          runtime.writeFilePaths.set(block.id, { path: block.input.file_path, existedBefore: fs.existsSync(absPath), toolName: 'Edit' });
        }
      }
      // Log usage for debugging
      if (message.message?.usage) {
        console.log('[SDK usage]', JSON.stringify(message.message.usage));
      }
      broadcast(runtime, 'message', {
        type: 'assistant',
        uuid: message.uuid || '',
        session_id: message.session_id || '',
        message: message.message,
        parent_tool_use_id: message.parent_tool_use_id || null,
      });
    }
    return;
  }

  if (message.type === 'user') {
    const hasToolResult = (message.message?.content || []).some(b => b.type === 'tool_result');
    if (hasToolResult && isStreaming) {
      // Extract file paths from Bash tool results
      const extractedPaths = {};
      const content = message.message?.content || [];
      for (const block of content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const cmd = runtime.bashCommands?.get(block.tool_use_id);
          console.log('[artifact] tool_result:', block.tool_use_id, 'hasCmd:', !!cmd, 'is_error:', block.is_error, 'cwd:', runtime.cwd);
          if (cmd) {
            console.log('[artifact] extracting from cmd:', cmd.slice(0, 150));
            const paths = extractBashFilePaths(cmd, typeof block.content === 'string' ? block.content : '', runtime.cwd, runtime.sessionStartTime);
            console.log('[artifact] extracted paths:', JSON.stringify(paths));
            if (paths.length > 0) {
              const filtered = filterArtifactPaths(paths, runtime.cwd);
              console.log('[artifact] filtered paths:', JSON.stringify(filtered));
              if (filtered.length > 0) {
                extractedPaths[block.tool_use_id] = filtered;
              }
            }
            runtime.bashCommands.delete(block.tool_use_id);
          }
          // Check Write/Edit tool file paths — defer judgment to finalizeArtifacts (rule+LLM)
          const writeInfo = runtime.writeFilePaths?.get(block.tool_use_id);
          if (writeInfo && !block.is_error) {
            const absPath = path.resolve(runtime.cwd || '/', writeInfo.path);
            try {
              if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
                if (!runtime.pendingWriteEditPaths) runtime.pendingWriteEditPaths = [];
                // Avoid duplicates
                if (!runtime.pendingWriteEditPaths.some(f => f.path === absPath)) {
                  runtime.pendingWriteEditPaths.push({ ...writeInfo, path: absPath });
                  console.log('[artifact] Write/Edit pending:', writeInfo.toolName, writeInfo.path, 'existedBefore:', writeInfo.existedBefore);
                }
              }
            } catch {}
            runtime.writeFilePaths.delete(block.tool_use_id);
          }
        }
      }
      // Merge extracted paths into runtime accumulator for finalization at session end
      if (!runtime.allExtractedPaths) runtime.allExtractedPaths = {};
      for (const [toolId, paths] of Object.entries(extractedPaths)) {
        if (!runtime.allExtractedPaths[toolId]) runtime.allExtractedPaths[toolId] = [];
        for (const p of paths) {
          if (!runtime.allExtractedPaths[toolId].includes(p)) {
            runtime.allExtractedPaths[toolId].push(p);
          }
        }
      }

      broadcast(runtime, 'message', {
        type: 'user',
        uuid: message.uuid || '',
        session_id: message.session_id || '',
        message: message.message,
        parent_tool_use_id: message.parent_tool_use_id || null,
        extractedPaths,
      });
    }
    return;
  }

  if (message.type === 'result') {
    if (message.subtype === 'success') {
      const usage = message.usage || {};
      const sdkCost = message.total_cost_usd;
      const sdkTokens = {
        input: usage.input_tokens || 0,
        output: usage.output_tokens || 0,
        cache: { read: usage.cache_read_input_tokens || 0, write: usage.cache_creation_input_tokens || 0 },
      };

      // Apply custom pricing if configured for this model
      let cost = sdkCost;
      let currency;
      try {
        const pricingFile = path.join(path.resolve(__dirname, '..', '..'), 'pricing-config.json');
        if (fs.existsSync(pricingFile)) {
          const pricing = JSON.parse(fs.readFileSync(pricingFile, 'utf8'));
          // Strip provider prefix from model name for pricing lookup
          const pureModel = (runtime.model || '').includes('/')
            ? runtime.model.split('/').pop()
            : runtime.model;
          const modelPricing = pricing.models?.[pureModel];
          // Always use custom pricing if config exists — unconfigured models default to 0
          const ip = modelPricing?.input || 0;
          const op = modelPricing?.output || 0;
          const crp = modelPricing?.cacheInput || 0;
          const cwp = modelPricing?.cacheOutput || 0;
          cost = ((sdkTokens.input * ip)
                + (sdkTokens.output * op)
                + (sdkTokens.cache.read * crp)
                + (sdkTokens.cache.write * cwp)) / 1_000_000;
          currency = '¥';
        }
      } catch {}

      return { cost, currency, tokens: sdkTokens };
    }
    return;
  }
}

// ── Security: user sandbox helpers ──

// Commands that remote tools (ssh/scp/rsync/ansible) are allowed to use on OTHER machines
const REMOTE_PREFIXES = ['ssh ', 'scp ', 'rsync ', 'ansible', 'ansible-playbook'];

// Dangerous commands blocked for regular users on the LOCAL machine
const LOCAL_DANGEROUS = [
  // Privilege escalation
  'sudo', 'su ', 'su -', 'pkexec',
  // System power control
  'reboot', 'shutdown', 'poweroff', 'halt',
  'init 0', 'init 6', 'telinit',
  'systemctl reboot', 'systemctl poweroff', 'systemctl halt', 'systemctl suspend',
  // Process termination
  'kill -9 1', 'kill -9 -1', 'killall',
  // System service control
  'systemctl stop', 'systemctl disable', 'systemctl mask',
  'service stop', 'service disable',
  // User/password management
  'passwd', 'usermod', 'userdel', 'groupdel',
  // Filesystem / Ownership
  'chown', 'chmod 777', 'chmod -R 777',
  'mount ', 'umount ', 'mkfs', 'fdisk', 'parted',
  'mkswap', 'swapon', 'swapoff',
  // Network / Firewall
  'iptables -F', 'iptables -X', 'iptables -P', 'nft flush',
  // Data destruction
  'dd if=', 'rm -rf /', 'shred',
  // Fork bomb
  ':(){ :|:& };:',
  // Kernel / Module
  'modprobe -r', 'rmmod',
];

function getUserSandbox(authUser) {
  if (!authUser || authUser.role === 'admin') return null;
  const user = findUserById(authUser.userId);
  if (!user) return null;
  return {
    username: user.username,
    homeDir: user.homeDir || `/home/${user.username}`,
    osUid: user.osUid,
    osGid: user.osGid,
  };
}

function isPathAllowed(filePath, homeDir) {
  if (!filePath || !homeDir) return false;
  const resolved = path.resolve(filePath);
  const home = path.resolve(homeDir);
  if (resolved === home || resolved.startsWith(home + path.sep)) return true;
  if (resolved.startsWith('/tmp/')) return true;
  return false;
}

function sandboxBashCommand(command, sandbox) {
  if (!sandbox) return command; // admin, no sandboxing

  const lower = (command || '').toLowerCase();

  // Check if this is a remote operation — if so, skip local dangerous checks
  const isRemote = REMOTE_PREFIXES.some(prefix => lower.startsWith(prefix));
  if (!isRemote) {
    for (const dc of LOCAL_DANGEROUS) {
      if (lower.includes(dc.toLowerCase())) {
        throw new Error(`安全限制：普通用户不能执行包含 "${dc}" 的命令`);
      }
    }
  }

  // Wrap with sudo -u to run as the user
  return `sudo -u ${sandbox.username} -i bash -c ${JSON.stringify(command)}`;
}

// ── End security helpers ──

function buildSDKOptions(runtime, body, authUser) {
  const agentOptions = body.options || {};
  const level = agentOptions.permissionLevel || 'auto';
  const sandbox = getUserSandbox(authUser);

  // ── Active skill integration ──
  const activeSkillName = agentOptions.activeSkill || null;
  let skillAllowedTools = null; // null = no restriction, [] = allow nothing, [...] = allow list
  let skillDeniedTools = [];

  if (activeSkillName) {
    try {
      const { getSkill } = require('../skills/store');
      const skill = getSkill(activeSkillName, authUser, sandbox ? sandbox.homeDir : runtime.cwd);
      if (skill) {
        // Prepend skill body to system prompt with explicit activation notice.
        // The Skill tool is NOT used for custom skills — the instructions are inline
        // and must be followed directly.
        const skillPrompt = [
          `[已激活技能: ${skill.displayName || skill.name}]`,
          `(技能注册名: ${skill.name})`,
          `此技能已在当前对话中激活，以下指令已生效。你必须直接遵守这些指令，`,
          `不要通过 Skill 工具来调用此技能，因为 Skill 工具只识别系统内置技能。`,
          ``,
          `${skill.body}`,
        ].join('\n');
        const userPrompt = agentOptions.systemPrompt || '';
        agentOptions.systemPrompt = skillPrompt + (userPrompt ? '\n\n---\n\n' + userPrompt : '');

        // Collect skill tool restrictions
        if (skill.allowedTools && skill.allowedTools.length > 0) {
          skillAllowedTools = new Set(skill.allowedTools);
        }
        if (skill.deniedTools && skill.deniedTools.length > 0) {
          skillDeniedTools = skill.deniedTools;
        }

        // Skill model preference (lower priority than explicit user choice)
        if (skill.model && agentOptions.model === undefined) {
          agentOptions.model = skill.model;
        }
      }
    } catch (err) {
      console.error('[skills] Error loading skill:', err.message);
    }
  }

  // Inject global memory rules + current session info into system prompt
  try {
    const memPath = path.join(os.homedir(), '.claude', 'projects', '-root', 'memory', 'MEMORY.md');
    if (fs.existsSync(memPath)) {
      const memContent = fs.readFileSync(memPath, 'utf8');
      // Inject current session project and ID so MEMORY.md code can extract them reliably
      const sessionInfo = findSessionFile(runtime.sessionId, authUser);
      const projDir = sessionInfo ? path.basename(sessionInfo.entryDir || '') : '';
      const projName = (projDir === '_root' || projDir === '-root' || !projDir) ? '-root' : projDir;
      const sessionHint = `[SESSION_INFO: projectDir=${projName}, sessionId=${runtime.sessionId}]`;
      const userPrompt = agentOptions.systemPrompt || '';
      agentOptions.systemPrompt = memContent + '\n' + sessionHint + '\n\n' + (userPrompt || '');
    }
  } catch {}

  // Inject Superpowers using-superpowers bootstrap if skills are synced
  try {
    const superpowersBootstrap = path.join(os.homedir(), '.claude', 'skills', 'using-superpowers.md');
    if (fs.existsSync(superpowersBootstrap)) {
      const content = fs.readFileSync(superpowersBootstrap, 'utf8');
      // Extract body after YAML frontmatter (between second ---)
      const parts = content.split('---');
      const body = parts.length >= 3 ? parts.slice(2).join('---').trim() : content.trim();
      if (body) {
        const userPrompt = agentOptions.systemPrompt || '';
        agentOptions.systemPrompt = body + (userPrompt ? '\n\n' + userPrompt : '');
      }
    }
  } catch {}

  const proxyUrl = getProxyUrl();

  const options = {
    cwd: sandbox ? sandbox.homeDir : runtime.cwd,
    permissionMode: 'acceptEdits',
    pathToClaudeCodeExecutable: SDK_BINARY,
    ...runtime.sessionId ? { resume: runtime.sessionId } : {},
    ...agentOptions.model !== undefined ? { model: agentOptions.model } : {},
    ...agentOptions.maxTurns !== undefined ? { maxTurns: agentOptions.maxTurns } : {},
    ...agentOptions.systemPrompt !== undefined ? { systemPrompt: agentOptions.systemPrompt } : {},
    ...agentOptions.maxBudgetUsd !== undefined ? { maxBudgetUsd: agentOptions.maxBudgetUsd } : {},
    ...agentOptions.effort !== undefined ? { effort: agentOptions.effort } : {},
    // Non-admin users: strip additionalDirectories (could be used to bypass sandbox)
    ...(sandbox ? {} : (agentOptions.additionalDirectories?.length ? { additionalDirectories: agentOptions.additionalDirectories } : {})),
    // Always route SDK through built-in proxy
    // IMPORTANT: ...process.env must be first so the subprocess inherits PATH etc.
    // The SDK query() `env` parameter COMPLETELY REPLACES the subprocess environment.
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: proxyUrl,
      ANTHROPIC_API_KEY: 'proxy',
      CLAUDE_SESSION_ID: runtime.sessionId,
      CLAUDE_USER_ID: authUser?.userId || '',
      CLAUDE_WEBUI_PORT: String(require('../config').PORT || 3000),
      ...(agentOptions.env || {}),
    },
    ...agentOptions.thinking !== undefined ? { thinking: agentOptions.thinking } : {},
    // GLM models don't support extended thinking — force disable to avoid
    // "content[].thinking must be passed back" errors from non-conformant APIs
    ...(/^glm/i.test(agentOptions.model || '') ? { thinking: { type: 'disabled' } } : {}),
    // Non-DeepSeek-native providers (ApiRouter etc) can't pass reasoning_content
    // back through Anthropic-format proxies — force disable thinking to avoid 400 errors
    ...((() => {
      if (agentOptions.model && agentOptions.model.includes('/')) {
        const pId = agentOptions.model.slice(0, agentOptions.model.lastIndexOf('/'));
        try {
          const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'provider-config.json'), 'utf8'));
          const cp = (cfg.providers || []).find(p => p.id === pId);
          if (cp && !/deepseek\.com/i.test(cp.baseUrl)) {
            return { thinking: { type: 'disabled' } };
          }
        } catch {}
      }
      return {};
    })()),
    stream_options: { include_usage: true },
    ...runtime.abort ? { abortController: runtime.abort } : {},
  };

  options.canUseTool = async (toolName, input) => {
    // ── Skill tool restrictions (applied first, before sandbox) ──
    // Custom skills are injected inline — block Skill tool to prevent "Unknown skill" errors
    if (activeSkillName && toolName === 'Skill') {
      return { behavior: 'deny', message: `无需使用 Skill 工具：自定义技能 "${activeSkillName}" 已激活并注入到系统提示中，请直接按技能指令执行。` };
    }
    if (skillDeniedTools.includes(toolName)) {
      return { behavior: 'deny', message: `技能限制：不允许使用 ${toolName} 工具` };
    }
    if (skillAllowedTools !== null && !skillAllowedTools.has(toolName)) {
      return { behavior: 'deny', message: `技能限制：${toolName} 不在允许列表中` };
    }

    if (toolName === 'AskUserQuestion') {
      console.log('[AskUserQuestion] canUseTool called, questions:', input.questions?.length || 0);
      // Store resolver — use fixed key to avoid session ID mismatch between SDK and frontend
      broadcast(runtime, 'ask_user', { questions: input.questions || [] });
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          askQuestionContext.delete('pending');
          console.log('[AskUserQuestion] 超时（2分钟），自动继续');
          resolve({ behavior: 'allow', updatedInput: { ...input, answers: {} } });
        }, 120000);
        askQuestionContext.set('pending', (result) => {
          clearTimeout(timeout);
          console.log('[AskUserQuestion] resolver called with answers:', JSON.stringify(result.answers || {}).slice(0, 100));
          resolve({ behavior: 'allow', updatedInput: { ...input, answers: result.answers || {} } });
        });
        console.log('[AskUserQuestion] resolver stored with key "pending"');
      });
    }

    // ── Sandbox checks for non-admin users ──
    if (sandbox) {
      try {
        // Bash: wrap command with sudo -u to run as the user
        if (toolName === 'Bash' && input.command) {
          input.command = sandboxBashCommand(input.command, sandbox);
        }
        // Write / Edit: check target path is within homeDir
        if ((toolName === 'Write' || toolName === 'Edit') && input.file_path) {
          if (!isPathAllowed(input.file_path, sandbox.homeDir)) {
            throw new Error(`安全限制：不能写入 ${input.file_path}，只能在 ${sandbox.homeDir} 目录下操作`);
          }
        }
        // Read / Glob / Grep: limit search scope for non-admin users
        if ((toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') && input.file_path) {
          const resolved = path.resolve(input.file_path || input.pattern || '');
          const basePath = resolved.split(path.sep).slice(0, 3).join(path.sep) || resolved;
          if (!isPathAllowed(basePath, sandbox.homeDir) &&
              !basePath.startsWith('/etc/') && !basePath.startsWith('/usr/') &&
              basePath !== '/etc' && basePath !== '/usr') {
            throw new Error(`安全限制：不能${toolName === 'Read' ? '读取' : '搜索'} ${input.file_path || input.pattern}`);
          }
        }
      } catch (err) {
        return { behavior: 'deny', message: err.message };
      }
    }

    // Auto mode: allow all tools
    if (level === 'auto') return { behavior: 'allow', updatedInput: input };

    // confirm-dangerous: only pause for Bash / Write / Edit
    const dangerous = new Set(['Bash', 'Write', 'Edit']);
    if (level === 'confirm-dangerous' && !dangerous.has(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }

    // confirm-all or dangerous tool: ask user
    const desc = input?.description || input?.command || input?.file_path || '';
    const action = desc ? `${toolName}: ${desc}`.slice(0, 80) : toolName;
    return new Promise((resolve) => {
      const sessionKey = runtime.sessionId || 'pending';
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        pendingApprovals.delete(sessionKey); // clean up without calling resolver
        console.log('[canUseTool] 用户确认超时，自动允许:', action);
        resolve({ behavior: 'allow', updatedInput: input });
      }, 120000); // 2 minute timeout
      setPendingApproval(sessionKey, (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        console.log('[canUseTool] user answered:', JSON.stringify(result));
        resolve(result);
      }, 'confirm', input);
      broadcast(runtime, 'tool_confirm', { tool: toolName, action, input });
    });
  };

  return options;
}

// ── User-specific data migration ──
// After SDK executes, move session files to user's home directory
function migrateSessionToUserDir(sessionId, cwd, authUser) {
  const { projects: userProjectsDir } = getUserDataDir(authUser);
  if (userProjectsDir === CLAUDE_PROJECTS_DIR) return; // admin — no migration needed

  // Find the session JSONL in global projects dir (SDK may use different dir naming)
  const srcFile = findSessionInDir(CLAUDE_PROJECTS_DIR, sessionId);
  if (!srcFile) return;

  // If already a symlink, the session has already been migrated — skip
  try {
    if (fs.lstatSync(srcFile).isSymbolicLink()) return;
  } catch {}

  const { getProjectDirName } = require('../store');
  const projectDir = getProjectDirName(cwd);
  const dstDir = path.join(userProjectsDir, projectDir);
  const dstFile = path.join(dstDir, `${sessionId}.jsonl`);

  try {
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(srcFile, dstFile);
    fs.writeFileSync(path.join(dstDir, '.cwd'), cwd, 'utf8');
    // Delete source file so admin's global directory doesn't see it
    try { fs.unlinkSync(srcFile); } catch {}
    // Clean up empty source directory
    const srcDir = path.dirname(srcFile);
    try {
      const remaining = fs.readdirSync(srcDir).filter(f => !f.startsWith('.'));
      if (remaining.length === 0) fs.rmdirSync(srcDir);
    } catch {}
  } catch (err) {
    console.error(`[migrate] Failed to migrate session ${sessionId}:`, err.message);
  }
}

// Scan a base directory for a specific session JSONL file
function findSessionInDir(baseDir, sessionId) {
  if (!fs.existsSync(baseDir)) return null;
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(baseDir, entry.name, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// Resolve project directory for a user — check user-specific dir first, fallback to global
function resolveProjectDir(cwd, authUser) {
  const { projects: userProjectsDir } = getUserDataDir(authUser);
  const { getProjectDirName } = require('../store');
  const projectDir = getProjectDirName(cwd);
  const userPath = path.join(userProjectsDir, projectDir);
  if (fs.existsSync(userPath)) return userPath;
  const globalPath = path.join(CLAUDE_PROJECTS_DIR, projectDir);
  if (fs.existsSync(globalPath)) return globalPath;
  // Neither exists — return user path for creation
  return (authUser && authUser.role !== 'admin') ? userPath : globalPath;
}

// Shared helper — generate a short AI title using the proxy
async function generateSessionTitle(sessionId, prompt, cwd, authUser) {
  try {
    const title = await generateTitleText(prompt);
    if (title) {
      storeSessionTitle(sessionId, title, cwd, authUser);
    }
    return title || null;
  } catch (err) {
    console.error('Title generation error:', err?.message);
    return null;
  }
}

// Lightweight: just call the proxy, return title text (no disk I/O)
async function generateTitleText(prompt) {
  const proxyBase = getProxyUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  // 读取 provider 配置，选择标题生成用的模型
  let titleModel = 'claude-haiku-4-5-20251001'; // 默认 Anthropic
  try {
    const providerFile = path.join(path.resolve(__dirname, '..', '..'), 'provider-config.json');
    if (fs.existsSync(providerFile)) {
      const cfg = JSON.parse(fs.readFileSync(providerFile, 'utf8'));
      // 优先用 haikuModel，其次 sonnetModel，最后用主 model
      titleModel = cfg.haikuModel || cfg.sonnetModel || cfg.model || titleModel;
    }
  } catch {}

  try {
    const proxyRes = await fetch(`${proxyBase}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'proxy', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: titleModel,
        max_tokens: 50,
        messages: [{ role: 'user', content: `用不超过15个汉字为以下对话生成一个简短的标题，直接返回标题文本，不要带引号、不要解释：${prompt}` }],
        stream: false,
        thinking: { type: 'disabled' },
      }),
      signal: controller.signal,
    });
    if (!proxyRes.ok) return null;
    const data = await proxyRes.json();
    const textBlock = (data.content || []).find(c => c.type === 'text');
    if (textBlock?.text) return textBlock.text.trim().slice(0, 30);
    // Fallback: try thinking block or any string content
    for (const c of (data.content || [])) {
      if (c.text) return String(c.text).trim().slice(0, 30);
      if (c.thinking) return String(c.thinking).trim().slice(0, 30);
    }
    return null;
  } catch (err) {
    console.error('generateTitleText error:', err?.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Store title .meta.json to disk (in cwd/.claude/sessions/, symlinked from projects dir)
function storeSessionTitle(sessionId, title, cwd, authUser) {
  const workDir = getSessionWorkDir(cwd);
  try { fs.mkdirSync(workDir, { recursive: true }); } catch {}
  fs.writeFileSync(path.join(workDir, `${sessionId}.meta.json`), JSON.stringify({ title }), 'utf8');
  // Ensure symlinks are set up (handles both new and existing sessions)
  try { ensureProjectSymlinks(cwd, sessionId, authUser); } catch {}
}

// Helper: scan both admin and user project dirs for a session file
function findSessionFile(id, authUser) {
  const dirsToScan = [CLAUDE_PROJECTS_DIR];
  const { projects: userProjects } = getUserDataDir(authUser);
  if (userProjects !== CLAUDE_PROJECTS_DIR) dirsToScan.push(userProjects);

  for (const baseDir of dirsToScan) {
    if (!fs.existsSync(baseDir)) continue;
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(baseDir, entry.name, `${id}.jsonl`);
      if (fs.existsSync(file)) return { file, entryDir: path.join(baseDir, entry.name), entry };
    }
  }
  return null;
}

// --- Session info ---
router.get('/session/:id', (req, res) => {
  const { id } = req.params;
  const runtime = getRuntimeSession(id);
  let found = null;
  const sessionInfo = findSessionFile(id, req.user);
  if (sessionInfo) {
    const { file, entryDir } = sessionInfo;
    let title = parseTitleFromJsonl(file) || id.slice(0, 8);
    const metaPath = path.join(entryDir, `${id}.meta.json`);
    if (fs.existsSync(metaPath)) {
      try { title = JSON.parse(fs.readFileSync(metaPath, 'utf8')).title; } catch {}
    }
    const cwd = runtime?.cwd || dirNameToCwd(path.basename(entryDir));
    let lastModified = 0;
    try { lastModified = fs.statSync(file).mtimeMs; } catch {}
    found = { id, title, cwd, status: runtime?.status || 'idle', lastModified };
  }
  if (!found) {
    try {
      if (fs.existsSync(SESSIONS_DIR)) {
        for (const f of fs.readdirSync(SESSIONS_DIR)) {
          if (!f.endsWith('.json')) continue;
          try {
            const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
            if (data.sessionId === id) {
              found = { id, title: data.summary || id.slice(0, 8), cwd: data.cwd || '', status: runtime?.status || 'idle', lastModified: data.startedAt || 0 };
              break;
            }
          } catch {}
        }
      }
    } catch {}
  }
  if (!found) return res.status(404).json({ error: 'Session not found' });
  res.json(found);
});

// Delete session
router.delete('/session/:id', (req, res) => {
  const { id } = req.params;
  const runtime = getRuntimeSession(id);
  runtime?.abort?.abort();
  deleteRuntimeSession(id);
  let deleted = false;
  // Scan both global and user-specific project directories
  const dirsToScan = [CLAUDE_PROJECTS_DIR];
  const { projects: userProjects } = getUserDataDir(req.user);
  if (userProjects !== CLAUDE_PROJECTS_DIR && fs.existsSync(userProjects)) {
    dirsToScan.push(userProjects);
  }
  for (const baseDir of dirsToScan) {
    if (!fs.existsSync(baseDir)) continue;
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(baseDir, entry.name, `${id}.jsonl`);
      if (!fs.existsSync(file)) continue;

      // Resolve symlink to find real file location for cleanup
      let realFile = file;
      try {
        if (fs.lstatSync(file).isSymbolicLink()) {
          realFile = fs.realpathSync(file);
        }
      } catch {}

      // Delete the symlink/entry in projects dir
      fs.rmSync(file, { force: true });
      const metaFile = path.join(baseDir, entry.name, `${id}.meta.json`);
      if (fs.existsSync(metaFile)) {
        try {
          if (fs.lstatSync(metaFile).isSymbolicLink()) {
            const realMeta = fs.realpathSync(metaFile);
            try { fs.unlinkSync(realMeta); } catch {}
          }
        } catch {}
        fs.rmSync(metaFile, { force: true });
      }

      // Delete session subdirectory symlink and its real target
      const dirLink = path.join(baseDir, entry.name, id);
      try {
        if (fs.lstatSync(dirLink).isSymbolicLink()) {
          const realSessionDir = fs.realpathSync(dirLink);
          fs.rmSync(realSessionDir, { recursive: true, force: true });
        }
        fs.rmSync(dirLink, { recursive: true, force: true });
      } catch {}

      // Delete real .jsonl if it wasn't already covered above
      if (realFile !== file && fs.existsSync(realFile)) {
        try { fs.unlinkSync(realFile); } catch {}
      }

      deleted = true;
    }
  }
  if (!deleted) return res.status(404).json({ error: 'Session not found' });
  res.json({ ok: true });
});

// Abort session
router.post('/session/:id/abort', (req, res) => {
  const { id } = req.params;
  const runtime = getRuntimeSession(id);
  if (!runtime) return res.status(404).json({ error: 'Session not found' });
  if (runtime.status !== 'busy') return res.status(409).json({ error: 'Session is not busy' });
  runtime.abort?.abort();
  // 立即清理旧订阅者，防止 SDK 后续 broadcastDone 污染新请求的 SSE 连接
  for (const sub of runtime.subscribers) {
    try { if (!sub.writableEnded) sub.end(); } catch {}
  }
  runtime.subscribers.clear();
  runtime.status = 'idle';
  res.json({ ok: true });
});

// Rename session (sidecar .meta.json)
router.patch('/session/:id', (req, res) => {
  const { id } = req.params;
  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title is required' });
  const sessionInfo = findSessionFile(id, req.user);
  if (!sessionInfo) return res.status(404).json({ error: 'Session not found' });
  // Resolve real path (follow symlink) so .meta.json is written alongside the real .jsonl
  let realDir = sessionInfo.entryDir;
  try {
    if (fs.lstatSync(sessionInfo.file).isSymbolicLink()) {
      realDir = path.dirname(fs.realpathSync(sessionInfo.file));
    }
  } catch {}
  const metaPath = path.join(realDir, `${id}.meta.json`);
  fs.writeFileSync(metaPath, JSON.stringify({ title }), 'utf8');
  res.json({ ok: true });
});

// Toggle pin status (sidecar .meta.json)
router.post('/session/:id/pin', (req, res) => {
  const { id } = req.params;
  const pinned = !!req.body?.pinned;
  const sessionInfo = findSessionFile(id, req.user);
  if (!sessionInfo) return res.status(404).json({ error: 'Session not found' });
  let realDir = sessionInfo.entryDir;
  try {
    if (fs.lstatSync(sessionInfo.file).isSymbolicLink()) {
      realDir = path.dirname(fs.realpathSync(sessionInfo.file));
    }
  } catch {}
  const metaPath = path.join(realDir, `${id}.meta.json`);
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
  }
  meta.pinned = pinned;
  fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf8');
  res.json({ ok: true, pinned });
});

// Get session messages
// 从文件末尾倒读，只收集包含实际文本内容的消息（过滤纯工具调用）
// textOffset: 跳过前 N 条文本消息, textLimit: 最多返回条数
function readLastTextRecords(jsonlPath, textOffset, textLimit) {
  const CHUNK_SIZE = 65536; // 64KB 块
  let fd;
  try {
    fd = fs.openSync(jsonlPath, 'r');
    const stat = fs.fstatSync(fd);
    const results = [];
    let textCount = 0; // 已找到的文本消息总数
    let pos = stat.size;
    let leftover = '';

    while (pos > 0 && results.length < textLimit) {
      const readSize = Math.min(CHUNK_SIZE, pos);
      pos -= readSize;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, pos);
      const chunk = buf.toString('utf8') + leftover;
      const lines = chunk.split('\n');
      leftover = lines.shift() || '';

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.type === 'user' || rec.type === 'assistant') {
            const content = rec.message?.content;
            // 判断是否包含实际文本内容（排除纯工具调用/工具结果消息）
            const hasText = typeof content === 'string'
              ? content.trim().length > 0
              : Array.isArray(content) && content.some(b => b.type === 'text' && (b.text || '').trim());
            if (hasText) {
              textCount++;
              if (textCount > textOffset) {
                results.unshift(rec);
                if (results.length >= textLimit) break;
              }
            }
          }
        } catch { /* 跳过损坏行 */ }
      }
    }

    // 文件开头剩余的第一行
    if (leftover.trim() && results.length < textLimit) {
      try {
        const rec = JSON.parse(leftover);
        if (rec.type === 'user' || rec.type === 'assistant') {
          const content = rec.message?.content;
          const hasText = typeof content === 'string'
            ? content.trim().length > 0
            : Array.isArray(content) && content.some(b => b.type === 'text' && (b.text || '').trim());
          if (hasText) {
            textCount++;
            if (textCount > textOffset) {
              results.unshift(rec);
            }
          }
        }
      } catch {}
    }

    return results;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

// 保留原函数用于其他可能的调用方
function readLastUserAssistantRecords(jsonlPath, needed) {
  const CHUNK_SIZE = 65536; // 64KB 块
  let fd;
  try {
    fd = fs.openSync(jsonlPath, 'r');
    const stat = fs.fstatSync(fd);
    const records = [];
    let pos = stat.size;
    let leftover = '';

    while (pos > 0 && records.length < needed) {
      const readSize = Math.min(CHUNK_SIZE, pos);
      pos -= readSize;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, pos);
      const chunk = buf.toString('utf8') + leftover;
      const lines = chunk.split('\n');
      // 第一段可能是不完整的行，留给下一轮拼接到 chunk 前面
      leftover = lines.shift() || '';

      // 从后往前解析，尽早凑够 needed 条
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.type === 'user' || rec.type === 'assistant') {
            records.unshift(rec);
            if (records.length >= needed) break;
          }
        } catch { /* 跳过损坏行 */ }
      }
    }

    // 文件开头剩余的第一行
    if (leftover.trim() && records.length < needed) {
      try {
        const rec = JSON.parse(leftover);
        if (rec.type === 'user' || rec.type === 'assistant') {
          records.unshift(rec);
        }
      } catch {}
    }

    return records;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

router.get('/session/:id/message', (req, res) => {
  const { id } = req.params;
  const TEXT_LIMIT = 20;
  const sessionInfo = findSessionFile(id, req.user);
  const jsonlPath = sessionInfo ? sessionInfo.file : null;
  if (!jsonlPath) return res.json([]);

  const messages = [];
  try {
    const reqOffset = req.query.offset !== undefined ? parseInt(req.query.offset) : null;
    const textOffset = reqOffset !== null && !isNaN(reqOffset) ? reqOffset : 0;
    // 从文件末尾倒读，按文本消息数分页，每次返回固定 20 条
    const msgRecords = readLastTextRecords(jsonlPath, textOffset, TEXT_LIMIT);
    messages.push(...msgRecords);
  } catch {}
  res.json(messages);
});

// Send message (SSE stream using Agent SDK with full tool calling)
router.post('/session/:id/message', async (req, res) => {
  const { id } = req.params;
  const isNew = id === 'new';
  const body = req.body || {};

  if (!query) {
    return res.status(500).json({ error: 'Agent SDK not available. Tool calling is disabled.' });
  }

  // ── Sandbox: non-admin users get their homeDir as cwd ──
  const sandbox = getUserSandbox(req.user);
  if (sandbox) {
    // Only override cwd if it's outside the user's homeDir (allow subdirectories)
    const { isPathInside } = require('../utils');
    if (!isPathInside(body.cwd || '/', sandbox.homeDir)) {
      body.cwd = sandbox.homeDir;
    }
  }

  let runtime;
  if (isNew) {
    if (!body.cwd) return res.status(400).json({ error: 'cwd is required for new sessions' });
    runtime = createPendingRuntime(body.cwd);
  } else {
    let cwd = body.cwd;
    let foundInDir = null;
    if (!cwd) {
      const existing = getRuntimeSession(id);
      cwd = existing?.cwd;
      if (!cwd) {
        const sessionInfo = findSessionFile(id, req.user);
        if (sessionInfo) {
          try {
            const content = fs.readFileSync(sessionInfo.file, 'utf8');
            const firstLine = content.split('\n').find(l => l.includes('"cwd"'));
            if (firstLine) {
              const obj = JSON.parse(firstLine);
              if (typeof obj.cwd === 'string') cwd = obj.cwd;
            }
          } catch {}
          if (!cwd) cwd = dirNameToCwd(path.basename(sessionInfo.entryDir));
          foundInDir = path.basename(sessionInfo.entryDir);
        }
      }
    }
    if (!cwd) return res.status(400).json({ error: 'cwd not found for session' });

    // Ensure session file is in the SDK's expected directory
    if (foundInDir && fs.existsSync(CLAUDE_PROJECTS_DIR)) {
      const { getProjectDirName } = require('../store');
      const expectedDir = getProjectDirName(cwd);
      if (foundInDir !== expectedDir) {
        // Use findSessionFile to get the actual source path (may be in user dir)
        const srcInfo = findSessionFile(id, req.user);
        const srcFile = srcInfo ? srcInfo.file : null;
        const dstDir = path.join(CLAUDE_PROJECTS_DIR, expectedDir);
        const dstFile = path.join(dstDir, `${id}.jsonl`);
        if (srcFile && !fs.existsSync(dstFile)) {
          try {
            if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
            fs.copyFileSync(srcFile, dstFile);
            fs.writeFileSync(path.join(dstDir, '.cwd'), cwd, 'utf8');
          } catch {}
        }
      }
    }

    runtime = getOrCreateRuntime(id, cwd);
  }

  if (runtime.status === 'busy') {
    return res.status(409).json({ error: 'Session is busy', canReconnect: true });
  }

  const prompt = (body.prompt || '').trim();
  if (!prompt && (!body.attachments || body.attachments.length === 0)) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  // ── Store artifact tracking context on runtime ──
  runtime.userPrompt = prompt;
  runtime.attachmentPaths = (body.attachments || []).map(a => a.path).filter(Boolean);
  runtime.sessionStartTime = Date.now();
  runtime.allExtractedPaths = {};
  runtime.pendingWriteEditPaths = [];

  // ── Attachments: prepend file info to prompt ──
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const SUPPORTED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const officeExts = ['.docx', '.xlsx', '.pptx'];
  const archiveExts = ['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar'];

  // ── Helper: check if Florence-2 is installed ──
  function checkFlorenceInstalled() {
    const venvPython = path.join(path.resolve(__dirname, '..', '..'), 'venv', 'bin', 'python3');
    if (!fs.existsSync(venvPython)) return false;
    const visionScript = path.join(path.resolve(__dirname, '..', '..'), 'vision_analyze.py');
    if (!fs.existsSync(visionScript)) return false;
    const cacheDir = path.join(path.resolve(__dirname, '..', '..'), '.vision_cache');
    if (!fs.existsSync(cacheDir)) return false;
    try {
      let totalSize = 0;
      const walkDir = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) walkDir(p);
          else totalSize += fs.statSync(p).size;
        }
      };
      walkDir(cacheDir);
      return totalSize > 50 * 1024 * 1024;
    } catch { return false; }
  }

  // ── Helper: build image analysis text via Florence-2 ──
  function runFlorenceAnalysis(imageAttachments) {
    const visionScript = path.join(path.resolve(__dirname, '..', '..'), 'vision_analyze.py');
    const venvPython = path.join(path.resolve(__dirname, '..', '..'), 'venv', 'bin', 'python3');
    const pythonBin = fs.existsSync(venvPython) ? venvPython : 'python3';
    const blocks = [];
    for (const img of imageAttachments) {
      try {
        const imgData = fs.readFileSync(img.path);
        const MAX_IMG_SIZE = 20 * 1024 * 1024;
        if (imgData.length > MAX_IMG_SIZE) {
          blocks.push(`[图片 ${img.fileName || img.originalName} 过大 (${formatSize(imgData.length)})，跳过分析]`);
          continue;
        }
        const { execFileSync } = require('child_process');
        const result = execFileSync(pythonBin, [visionScript, img.path], {
          encoding: 'utf-8', timeout: 300000,
          env: { ...process.env, PYTHONUNBUFFERED: '1' }
        });
        const analysis = JSON.parse(result);
        if (analysis.ok) {
          const parts = [];
          if (analysis.caption) parts.push(`📷 画面描述：${analysis.caption}`);
          if (analysis.ocr && analysis.ocr !== 'No text found' && analysis.ocr !== '-' && analysis.ocr.trim()) {
            parts.push(`📝 图中文字：${analysis.ocr}`);
          }
          blocks.push(parts.join('\n'));
        } else {
          blocks.push(`[图片分析失败: ${analysis.error}]`);
        }
      } catch (e) {
        blocks.push(`[图片分析异常: ${e.message}]`);
      }
    }
    return blocks.join('\n\n');
  }

  // ── Build promptArg for a given strategy ──
  function buildPromptArgForStrategy(attachments, prompt, strategy) {
    // If no attachments at all, pass prompt directly
    if (!attachments || attachments.length === 0) {
      return prompt || '';
    }

    const imageAttachments = attachments.filter(a => SUPPORTED_IMAGE_MIME.includes(a.mimeType));
    const nonImageAttachments = attachments.filter(a => !SUPPORTED_IMAGE_MIME.includes(a.mimeType));

    // Build text info for non-image attachments
    const fileLines = nonImageAttachments.map(a => {
      const name = a.fileName || a.originalName || '';
      const ext = name.toLowerCase();
      const isOffice = officeExts.some(oe => ext.endsWith(oe));
      const isArchive = archiveExts.some(ae => ext.endsWith(ae)) || ext.endsWith('.tar.gz');
      if (isArchive && a.extractedPath) {
        return `- 📦 ${a.fileName || a.originalName}: 已解压至 ${a.extractedPath}（见下方文件树）`;
      }
      if (isOffice && a.extractedText) {
        const label = ext.endsWith('.xlsx') ? '📊' : '📄';
        return `- ${label} ${a.fileName || a.originalName}: 文本已提取（见下方内容）`;
      }
      return `- 📄 文件: ${a.path} (${a.mimeType || 'unknown'}, ${formatSize(a.size || 0)})`;
    }).join('\n');

    // Also list image attachments in text (for transparency)
    const imageLines = imageAttachments.map(a =>
      `- 🖼 图片: ${a.fileName || a.originalName} (${a.mimeType || 'unknown'}, ${formatSize(a.size || 0)})`
    ).join('\n');

    const allFileLines = [fileLines, imageLines].filter(Boolean).join('\n');

    // Include extracted text from Office documents / archive file trees
    const extractedBlocks = attachments
      .filter(a => a.extractedText)
      .map(a => {
        const name = a.fileName || a.originalName || 'unknown';
        const isArchive = archiveExts.some(ae => (a.fileName || a.originalName || '').toLowerCase().endsWith(ae))
          || (a.fileName || a.originalName || '').toLowerCase().endsWith('.tar.gz');
        const label = isArchive ? '📦' : '📄';
        const maxLen = 8000;
        const text = a.extractedText.length > maxLen
          ? a.extractedText.slice(0, maxLen) + '\n\n...（内容过长，已截断）'
          : a.extractedText;
        return `\n── ${label} ${name} ──\n${text}`;
      })
      .concat(attachments
        .filter(a => a.extractedPath && !a.extractedText)
        .map(a => {
          const name = a.fileName || a.originalName || 'unknown';
          return `\n── 📦 ${name} ──\n文件已解压至: ${a.extractedPath}\n请用 Read 工具读取其中的文件`;
        }));

    const textPrefix = [
      '用户上传了以下文件：',
      allFileLines,
      extractedBlocks.join('\n')
    ].filter(Boolean).join('\n');

    // No images: plain text
    if (imageAttachments.length === 0) {
      const fullPrompt = [textPrefix, prompt].filter(Boolean).join('\n\n---\n\n');
      return fullPrompt; // string
    }

    // ── Strategy: native (base64 image blocks for vision models) ──
    if (strategy === 'native') {
      const contentBlocks = [];
      contentBlocks.push({ type: 'text', text: [textPrefix, prompt].filter(Boolean).join('\n\n---\n\n') });
      const MAX_IMG_SIZE = 20 * 1024 * 1024;
      for (const img of imageAttachments) {
        try {
          const imgData = fs.readFileSync(img.path);
          if (imgData.length > MAX_IMG_SIZE) {
            contentBlocks.push({ type: 'text', text: `\n⚠️ 图片 ${img.fileName || img.originalName} 过大 (${formatSize(imgData.length)})，已跳过内嵌。` });
            continue;
          }
          const base64 = imgData.toString('base64');
          contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: base64 } });
        } catch (e) {
          contentBlocks.push({ type: 'text', text: `\n⚠️ 无法读取图片 ${img.fileName || img.originalName}: ${e.message}` });
        }
      }
      const sdkMessage = { type: 'user', message: { role: 'user', content: contentBlocks }, parent_tool_use_id: null };
      // Return AsyncIterable<SDKUserMessage>
      return {
        [Symbol.asyncIterator]() {
          let done = false;
          return {
            async next() {
              if (done) return { done: true };
              done = true;
              return { value: sdkMessage, done: false };
            }
          };
        }
      };
    }

    // ── Strategy: florence (local Florence-2 analysis) ──
    if (strategy === 'florence') {
      const analysisText = runFlorenceAnalysis(imageAttachments);
      const fullPrompt = [textPrefix, analysisText, '---', prompt].filter(Boolean).join('\n\n');
      return fullPrompt; // string
    }

    // ── Strategy: tesseract (command-line OCR, always available if installed) ──
    const { execSync } = require('child_process');
    const tesseractInstalled = (() => {
      try { execSync('which tesseract', { encoding: 'utf8', timeout: 3000 }); return true; } catch { return false; }
    })();

    const ocrBlocks = [];
    for (const img of imageAttachments) {
      try {
        const imgData = fs.readFileSync(img.path);
        if (imgData.length > 50 * 1024 * 1024) {
          ocrBlocks.push(`[图片 ${img.fileName || img.originalName} 过大，跳过 OCR]`);
          continue;
        }
        if (tesseractInstalled) {
          // Run tesseract with Chinese + English language support
          const text = execSync(`tesseract "${img.path}" stdout -l chi_sim+eng 2>/dev/null`, {
            encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024
          }).trim();
          if (text) {
            ocrBlocks.push(`📝 Tesseract OCR 识别结果（${img.fileName || img.originalName}）：\n${text}`);
          } else {
            ocrBlocks.push(`[图片 ${img.fileName || img.originalName} 中未检测到文字]`);
          }
        } else {
          ocrBlocks.push(`[Tesseract OCR 未安装，无法识别图片 ${img.fileName || img.originalName}]`);
        }
      } catch (e) {
        ocrBlocks.push(`[OCR 识别失败 ${img.fileName || img.originalName}: ${e.message}]`);
      }
    }
    const ocrText = ocrBlocks.join('\n\n');

    // Also hint about Florence-2 for enhanced recognition
    const florenceHint = florenceInstalled ? '' :
      '\n\n💡 当前为 Tesseract OCR 文字识别。如需增强图像识别（画面描述 + 更精准 OCR），请在「设置 → 初始化」中安装 Florence-2 图像识别模型。';

    const fullPrompt = [textPrefix, ocrText + florenceHint, '---', prompt].filter(Boolean).join('\n\n');
    return fullPrompt; // string
  }

  // Determine available strategies (top-priority first)
  const hasImages = attachments.some(a => SUPPORTED_IMAGE_MIME.includes(a.mimeType));
  const florenceInstalled = checkFlorenceInstalled();

  // Check if model supports vision (avoid unnecessary native attempts)
  const modelName = (body.options?.model || '').toLowerCase();
  const modelIsVision = /claude.*(sonnet|opus)/i.test(modelName)
    || /gpt-4o|gemini/i.test(modelName)
    || /claude-3[.-]?5/i.test(modelName);

  const promptStrategies = hasImages
    ? [...(modelIsVision ? ['native'] : []), ...(florenceInstalled ? ['florence'] : []), 'text']
    : ['text'];

  const wantsStream = req.headers.accept?.includes('text/event-stream') || req.query.stream === '1';

  runtime.status = 'busy';
  runtime.abort = new AbortController();
  const abortCtrl = runtime.abort;  // 保存引用，catch 中用于判断是否已被新执行替换
  runtime.buffer = []; // clear buffer from any previous run
  runtime.model = body.options?.model || 'unknown';

  try {
    const options = buildSDKOptions(runtime, body, req.user);

    if (wantsStream) {
      // SSE streaming mode — disable all timeouts for long-running agent sessions
      req.setTimeout(0);
      req.socket?.setTimeout?.(0);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      // Prevent uncaught socket errors from crashing the process
      res.on('error', (e) => { logError('Response socket error', e); });
      req.on('error', (e) => { logError('Request socket error', e); });

      // Subscribe this response to the broadcast stream
      subscribeToStream(runtime, res);

      // Send keepalive comments every 15s to prevent proxy timeouts
      let keepalive = null;
      keepalive = setInterval(() => {
        try { if (!res.writableEnded) res.write(':keepalive\n\n'); } catch {}
      }, 15000);
      res.on('close', () => { if (keepalive) clearInterval(keepalive); });
    }

    // Generate AI title immediately before SDK execution
    // Always broadcast for TaskPanel; only persist to disk for new sessions
    let aiTitle = null;
    if (wantsStream && prompt) {
      try {
        aiTitle = await generateTitleText(prompt);
        if (aiTitle) {
          if (isNew) {
            runtime.pendingTitle = aiTitle;
          }
          broadcast(runtime, 'title', { title: aiTitle, sessionId: isNew ? null : id });
        }
      } catch (err) {
        logError('Title generation error', err);
      }
    }

    let result;
    const allMessages = [];
    let compactRetried = false;  // 防止死循环 — 只压缩一次

    // ── Proactive: strip incompatible fields from JSONL before every request ──
    // reasoning_content is DeepSeek-specific. It MUST be preserved for DeepSeek-native
    // providers (api.deepseek.com), but stripped for middlemen like ApiRouter.
    // "type: thinking" blocks are GLM-specific and always incompatible cross-provider.
    try {
      const sessionData = findSessionFile(runtime.sessionId, req.user);
      if (sessionData) {
        let realPath = sessionData.file;
        try { if (fs.lstatSync(realPath).isSymbolicLink()) realPath = fs.realpathSync(realPath); } catch {}
        const fileContent = fs.readFileSync(realPath, 'utf8');
        const lines = fileContent.split('\n').filter(Boolean);
        let cleaned = 0;

        // Check if current model belongs to a DeepSeek-native provider
        let currentProviderId = '';
        if (runtime.model && runtime.model.includes('/')) {
          currentProviderId = runtime.model.slice(0, runtime.model.lastIndexOf('/'));
        }
        let isDeepSeekNative = false;
        try {
          const providerConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'provider-config.json'), 'utf8'));
          const cp = (providerConfig.providers || []).find(p => p.id === currentProviderId);
          isDeepSeekNative = cp?.baseUrl && /deepseek\.com/i.test(cp.baseUrl);
        } catch {}

        let cleanedLines = lines.map(line => {
          try {
            const obj = JSON.parse(line);
            let changed = false;
            // Always strip "type: thinking" blocks (GLM-specific)
            const msgContent = obj.message?.content;
            if (Array.isArray(msgContent)) {
              const filtered = msgContent.filter(b => b.type !== 'thinking');
              if (filtered.length !== msgContent.length) {
                obj.message = { ...obj.message, content: filtered };
                changed = true;
              }
            }
            // Strip reasoning_content unless provider is DeepSeek-native
            if (!isDeepSeekNative) {
              if (obj.reasoning_content !== undefined) { delete obj.reasoning_content; changed = true; }
              if (obj.message?.reasoning_content !== undefined) { delete obj.message.reasoning_content; changed = true; }
            }
            if (changed) cleaned++;
            return JSON.stringify(obj);
          } catch { return line; }
        });
        if (cleaned > 0) {
          fs.writeFileSync(realPath, cleanedLines.join('\n') + '\n', 'utf8');
        }
      }
    } catch (e) { /* non-fatal */ }

    // Outer retry loop: compact on ContextWindowExceededError and retry
    while (true) {
    // ── Try strategies in priority order, retry on image_error ──
    for (const strategy of promptStrategies) {
      const arg = buildPromptArgForStrategy(attachments, prompt || '', strategy);

      // Notify frontend on strategy fallback
      if (strategy !== promptStrategies[0]) {
        allMessages.length = 0; // reset for retry
        runtime.buffer = [];
        if (wantsStream) {
          broadcast(runtime, 'system_notice', {
            text: strategy === 'florence'
              ? '🔄 模型不支持图像输入，已切换本地 Florence-2 进行画面描述和 OCR 识别'
              : '🔄 图像识别模型未安装。当前使用基础文字识别，如需增强请到「设置→初始化」安装 Florence-2 模型。'
          });
        }
      }

      let imageError = false;

      // Idle watchdog: only active during text generation (responding phase).
      // During tool execution (Bash, npm install, etc.) the SDK may be quiet for
      // long periods on slow networks, so no timeout is applied there.
      const RESPONDING_IDLE_TIMEOUT = 180000; // 3 minutes
      let idleTimer = null;
      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          console.log('[SESSION] No message during responding for', RESPONDING_IDLE_TIMEOUT / 1000, 's, aborting');
          abortCtrl.abort();
        }, RESPONDING_IDLE_TIMEOUT);
      };
      const clearIdleTimer = () => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      };

      try {
        for await (const message of query({ prompt: arg, options })) {
          // ── Idle watchdog: only activate during pure text generation ──
          if (message.type === 'assistant') {
            const content = message.message?.content || [];
            const hasText = content.some(b => b.type === 'text');
            const hasToolUse = content.some(b => b.type === 'tool_use');
            if (hasToolUse) {
              clearIdleTimer(); // tool call — may run long Bash, no timeout
            } else if (hasText) {
              resetIdleTimer(); // pure text generation — start/refresh watchdog
            }
          } else if (message.type === 'user') {
            clearIdleTimer(); // tool results flowing in — no timeout
          }

          // ── Detect [Unsupported Image] placeholder anywhere in the message ──
          if (strategy === 'native' && promptStrategies.length > 1) {
            // Check full serialized message — SDK may place the placeholder in any field
            if (JSON.stringify(message).includes('[Unsupported Image]')) {
              // SDK silently replaced image with placeholder — retry with next strategy
              imageError = true;
              // Remove the placeholder message from the broadcast buffer
              runtime.buffer = (runtime.buffer || []).filter(
                m => !(m.type === 'user' && JSON.stringify(m.message?.content || '').includes('[Unsupported Image]'))
              );
              break;
            }
          }

          const info = handleSDKMessage(message, runtime, wantsStream);
          if (message.type === 'assistant' || message.type === 'user') {
            allMessages.push(message);
          }
          if (message.type === 'result') {
            if (message.subtype !== 'success') {
              const errText = (message.errors || []).join('; ') || `SDK result: ${message.subtype}`;
              // Check if this is an image-related error and we have more strategies to try
              if (strategy === 'native' && /image|unsupported|not.*support/i.test(errText) && promptStrategies.length > 1) {
                imageError = true;
                break; // break inner for-await, continue outer loop to next strategy
              }
              // ── Context window exceeded: auto compact and retry (once) ──
              if (!compactRetried && /context.*window|context.*length|ContextWindowExceeded|maximum.*context|input.*token/i.test(errText) && runtime.sessionId) {
                compactRetried = true;
                logError('Context window exceeded, auto-compacting', errText);
                try {
                  const sessionData = findSessionFile(runtime.sessionId, req.user);
                  if (sessionData) {
                    let realPath = sessionData.file;
                    try { if (fs.lstatSync(realPath).isSymbolicLink()) realPath = fs.realpathSync(realPath); } catch {}
                    const content = fs.readFileSync(realPath, 'utf8');
                    const lines = content.split('\n').filter(Boolean);
                    if (lines.length > 0) {
                      const userIndices = [];
                      for (let i = lines.length - 1; i >= 0 && userIndices.length < 5; i--) {
                        try { if (JSON.parse(lines[i]).type === 'user') userIndices.unshift(i); } catch {}
                      }
                      if (userIndices.length > 0 && userIndices[0] > 0) {
                        fs.writeFileSync(realPath, lines.slice(userIndices[0]).join('\n') + '\n', 'utf8');
                        console.log('[SESSION] Auto-compacted:', lines.length, '→', lines.length - userIndices[0], 'lines for session', runtime.sessionId);
                      }
                    }
                  }
                } catch (e) { console.error('[SESSION] Auto-compact error:', e.message); }
                allMessages.length = 0;
                runtime.buffer = [];
                broadcast(runtime, 'system_notice', {
                  text: '⚠️ 上下文超限，已自动压缩对话历史后重试...'
                });
                break;
              }
              // ── Thinking block pollution: strip from JSONL and retry (once) ──
              if (!compactRetried && /thinking.*must be passed|content\[\].*thinking/i.test(errText) && runtime.sessionId) {
                compactRetried = true;
                logError('Thinking block pollution detected, stripping from JSONL', errText);
                try {
                  const sessionData = findSessionFile(runtime.sessionId, req.user);
                  if (sessionData) {
                    let realPath = sessionData.file;
                    try { if (fs.lstatSync(realPath).isSymbolicLink()) realPath = fs.realpathSync(realPath); } catch {}
                    const content = fs.readFileSync(realPath, 'utf8');
                    const lines = content.split('\n').filter(Boolean);
                    let cleaned = 0;
                    const cleanedLines = lines.map(line => {
                      try {
                        const obj = JSON.parse(line);
                        // Strip thinking blocks from message content
                        const msgContent = obj.message?.content;
                        if (Array.isArray(msgContent)) {
                          const filtered = msgContent.filter(b => b.type !== 'thinking');
                          if (filtered.length !== msgContent.length) {
                            obj.message = { ...obj.message, content: filtered };
                            cleaned++;
                          }
                        }
                        return JSON.stringify(obj);
                      } catch { return line; }
                    });
                    fs.writeFileSync(realPath, cleanedLines.join('\n') + '\n', 'utf8');
                    console.log('[SESSION] Stripped thinking blocks from', cleaned, 'messages for session', runtime.sessionId);
                  }
                } catch (e) { console.error('[SESSION] Strip thinking error:', e.message); }
                allMessages.length = 0;
                runtime.buffer = [];
                result = null;  // reset so while loop retries
                broadcast(runtime, 'system_notice', {
                  text: '⚠️ 检测到不兼容的 thinking 数据，已自动清理后重试...'
                });
                break;
              }
              // ── reasoning_content missing: API needs it but provider changed ──
              // This is a genuine compatibility issue — pass through as error, don't strip
              if (!compactRetried && /reasoning_content.*must be passed/i.test(errText)) {
                logError('Reasoning content mismatch — model requires reasoning_content from prior turns', errText);
                // Don't retry; the model genuinely needs data we can't provide across providers
                result = { error: errText };
              }
              logError('SDK result error', errText);
              result = { error: errText };
            } else {
              result = info;
            }
          }
        }
      } finally {
        clearIdleTimer();
      }

      if (!imageError) break; // success or non-image error → exit strategy loop
    }

    // If compact retry was triggered, loop back; otherwise exit
    if (result && !result.error) break;
    if (!compactRetried || (result && result.error)) break;
    // compactRetried is true and no result set = we did a compact break, need to retry
    result = null;
    } // end outer while

    if (wantsStream) {
      // 如果 abort controller 已被替换，说明新执行已接管，跳过广播
      if (runtime.abort !== abortCtrl) return;

      // ── 非 catch 路径的 SDK 错误：发送 error 事件，避免前端误显"已完成" ──
      if (result?.error) {
        broadcast(runtime, 'error', { message: result.error });
      }

      // If we have a pending title from before and now know the sessionId, store it
      if (runtime.pendingTitle && runtime.sessionId && isNew) {
        storeSessionTitle(runtime.sessionId, runtime.pendingTitle, runtime.cwd, req.user);
      }

      // Migrate session data to user-specific directory
      if (runtime.sessionId) {
        migrateSessionToUserDir(runtime.sessionId, runtime.cwd, req.user);
      }

      // ── Finalize artifacts: collect all paths, copy to tool-results ──
      let artifactFiles = [];
      try {
        const finalArtifacts = await finalizeArtifacts(runtime, runtime.allExtractedPaths || {}, req.user);
        // Build flat list of artifact files (now pointing to tool-results/) for frontend
        const seen = new Set();
        for (const [, paths] of Object.entries(finalArtifacts || {})) {
          for (const p of paths) {
            try {
              if (!seen.has(p) && fs.existsSync(p) && fs.statSync(p).isFile()) {
                seen.add(p);
                artifactFiles.push({ path: p, name: path.basename(p) });
              }
            } catch {}
          }
        }
      } catch (e) { console.log('[artifact] finalizeArtifacts error:', e.message); }

      broadcastDone(runtime, {
        sessionId: runtime.sessionId,
        cost: result?.cost,
        tokens: result?.tokens,
        currency: result?.currency,
        artifactFiles,
      });

      // Write stats record
      try {
        if (result?.tokens && result?.cost != null && runtime.sessionId) {
          if (!fs.existsSync(STATS_DIR)) fs.mkdirSync(STATS_DIR, { recursive: true });
          const now = new Date();
          const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
          const statsFile = path.join(STATS_DIR, `${ym}.jsonl`);
          const record = JSON.stringify({
            t: now.toISOString(),
            userId: req.user?.id,
            username: req.user?.username || 'anonymous',
            model: runtime.model || 'unknown',
            sessionId: runtime.sessionId,
            input: result.tokens.input || 0,
            output: result.tokens.output || 0,
            cacheRead: result.tokens.cache?.read || 0,
            cacheWrite: result.tokens.cache?.write || 0,
            cost: result.cost,
            currency: result.currency || '$',
          }) + '\n';
          fs.appendFileSync(statsFile, record);
        }
      } catch {}

    } else {
      // Blocking mode — return all messages
      res.json({
        sessionId: runtime.sessionId,
        cost: result?.cost,
        currency: result?.currency,
        tokens: result?.tokens,
        messages: allMessages,
      });
    }
  } catch (err) {
    console.error('[SESSION] Error details:', err?.message, err?.stack?.split('\n').slice(0,3).join('\n'));
    logError('Session message error', err);
    // 如果 abort controller 已被新执行替换，说明插队/新请求已接管，跳过广播避免污染新 SSE 连接
    if (runtime.abort !== abortCtrl) return;
    if (err.name === 'AbortError') {
      try {
        broadcast(runtime, 'error', { message: '回复超时，已自动结束' });
        broadcastDone(runtime, { aborted: true });
      } catch {}
    } else {
      const errMsg = err instanceof Error ? err.message : String(err);
      try {
        broadcast(runtime, 'error', { message: errMsg });
        broadcastDone(runtime, { error: errMsg });
      } catch {}
    }
  } finally {
    // 仅当 abort controller 未被替换时才清理（未被新执行接管）
    if (runtime.abort === abortCtrl) {
      runtime.status = 'idle';
      runtime.abort = null;
      runtime.buffer = [];
    }
  }
});

// Reconnect to a running session stream (after page refresh)
router.get('/session/:id/stream', (req, res) => {
  const { id } = req.params;
  const runtime = getRuntimeSession(id);

  if (!runtime) return res.status(404).json({ error: 'Session not found' });
  if (runtime.status !== 'busy') return res.status(404).json({ error: 'Session is not running', status: runtime.status });

  // Set up SSE
  req.setTimeout(0);
  req.socket?.setTimeout?.(0);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.on('error', (e) => { logError('Reconnect response error', e); });
  req.on('error', (e) => { logError('Reconnect request error', e); });

  // Replay buffer + subscribe to live stream
  subscribeToStream(runtime, res);

  let keepalive = null;
  keepalive = setInterval(() => {
    try { if (!res.writableEnded) res.write(':keepalive\n\n'); } catch {}
  }, 15000);
  res.on('close', () => { if (keepalive) clearInterval(keepalive); });
});

// Resolve AskUserQuestion
router.post('/session/:id/message/resolve', (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  if (!body.answers || typeof body.answers !== 'object') {
    return res.status(400).json({ error: 'answers is required' });
  }
  const firstVal = Object.values(body.answers)[0];

  // Tool confirmation (允许/拒绝)
  if (firstVal === '允许' || firstVal === '拒绝') {
    const decision = firstVal === '拒绝'
      ? { behavior: 'deny', message: '用户拒绝执行' }
      : { behavior: 'allow', updatedInput: {} };
    let ok = resolvePendingApproval(id, decision);
    if (!ok) ok = resolvePendingApproval('pending', decision);
    if (!ok) return res.status(409).json({ error: 'No pending question for this session' });
    return res.json({ ok: true });
  }

  // AskUserQuestion — always resolve via fixed key 'pending'
  console.log('[AskUserQuestion] resolve request, answers:', JSON.stringify(body.answers).slice(0, 100), 'firstVal:', firstVal);
  const askResolve = askQuestionContext.get('pending');
  console.log('[AskUserQuestion] resolver found:', !!askResolve);
  if (askResolve && firstVal !== '允许' && firstVal !== '拒绝') {
    askQuestionContext.delete('pending');
    askResolve({ answers: body.answers });
    console.log('[AskUserQuestion] resolved successfully');
    return res.json({ ok: true });
  }
  if (!askResolve) {
    console.log('[AskUserQuestion] resolver NOT FOUND. pending keys:', [...askQuestionContext.keys()]);
  }
  return res.status(409).json({ error: 'No pending question for this session' });
});

// Generate session title from first user message via Claude
router.post('/session/:id/title', async (req, res) => {
  const { id } = req.params;
  const prompt = (req.body.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const title = await generateSessionTitle(id, prompt, req.body.cwd, req.user);
  res.json({ title });
});

// Compact session: trim history, preserving complete user-assistant turns
router.post('/session/:id/compact', requireAuth, (req, res) => {
  const { id } = req.params;
  const keepUserTurns = Math.max(0, parseInt(req.body?.keepCount) || 2);
  const sessionInfo = findSessionFile(id, req.user);
  if (!sessionInfo) return res.status(404).json({ error: 'Session not found' });

  try {
    let realPath = sessionInfo.file;
    try {
      if (fs.lstatSync(realPath).isSymbolicLink()) realPath = fs.realpathSync(realPath);
    } catch {}
    const content = fs.readFileSync(realPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length === 0) return res.json({ ok: true, trimmed: false });

    // Scan from end to find the last N+2 user-type entries
    // +1 because the last user entry is the compact trigger itself ("压缩对话上下文")
    // +1 extra for safety margin — always keep at least one prior user turn
    const targetUserCount = keepUserTurns + 2;
    const userIndices = [];
    for (let i = lines.length - 1; i >= 0 && userIndices.length < targetUserCount; i--) {
      try {
        const rec = JSON.parse(lines[i]);
        if (rec.type === 'user') userIndices.unshift(i);
      } catch { /* skip unparseable lines */ }
    }

    if (userIndices.length === 0) {
      // No user entries — keep everything (shouldn't happen in normal flow)
      return res.json({ ok: true, trimmed: false });
    }

    // Keep from the earliest found user entry (ensures complete turns)
    const fromIdx = userIndices[0];
    if (fromIdx === 0) return res.json({ ok: true, trimmed: false }); // Already minimal

    const trimmed = lines.slice(fromIdx);
    fs.writeFileSync(realPath, trimmed.join('\n') + '\n', 'utf8');
    res.json({ ok: true, trimmed: true, removed: lines.length - trimmed.length, keptTurns: userIndices.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Session Artifact Management ──

// Find tool-results directory: try cwd/.claude/sessions/ first, then projects dir
function findArtifactsDir(cwd, sessionId, authUser) {
  // Sanitize: sessionId must be a UUID or similar safe identifier
  if (!sessionId || sessionId.includes('/') || sessionId.includes('..') || sessionId.includes('\\')) {
    return null;
  }
  // 1. Try cwd-based sessions dir (new behavior)
  if (cwd) {
    const workDir = getSessionWorkDir(cwd);
    const newPath = path.join(workDir, sessionId, 'tool-results');
    if (fs.existsSync(newPath)) return newPath;
  }
  // 2. Fallback to projects dir (old behavior / symlinks)
  const projectDir = resolveProjectDir(cwd, authUser);
  const oldPath = path.join(projectDir, sessionId, 'tool-results');
  if (fs.existsSync(oldPath)) return oldPath;
  return null;
}

// List artifacts for a session (tool-results/ files)
router.get('/session/:id/artifacts', (req, res) => {
  const { id } = req.params;
  const cwd = req.query.cwd || '';
  try {
    const resultsDir = findArtifactsDir(cwd, id, req.user);
    if (!resultsDir || !fs.existsSync(resultsDir)) return res.json({ files: [] });
    const entries = fs.readdirSync(resultsDir, { withFileTypes: true });
    const files = entries
      .filter(e => e.isFile())
      .map(e => {
        const stat = fs.statSync(path.join(resultsDir, e.name));
        return { name: e.name, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download an artifact file
router.get('/session/:id/artifacts/download', (req, res) => {
  const { id } = req.params;
  const cwd = req.query.cwd || '';
  const fileName = req.query.file;
  if (!fileName) return res.status(400).json({ error: '缺少参数: file' });
  // Prevent path traversal
  if (fileName.includes('/') || fileName.includes('..')) {
    return res.status(400).json({ error: '非法文件名' });
  }
  try {
    const resultsDir = findArtifactsDir(cwd, id, req.user);
    if (!resultsDir) return res.status(404).json({ error: '产物目录不存在' });
    const filePath = path.join(resultsDir, fileName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
    res.download(filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete artifact file(s)
router.delete('/session/:id/artifacts', (req, res) => {
  const { id } = req.params;
  const cwd = req.body.cwd || '';
  const fileList = req.body.files;
  if (!fileList || !Array.isArray(fileList) || fileList.length === 0) {
    return res.status(400).json({ error: '缺少参数: files' });
  }
  let deleted = 0;
  const errors = [];
  try {
    const resultsDir = findArtifactsDir(cwd, id, req.user);
    if (!resultsDir) return res.json({ deleted: 0, errors: ['产物目录不存在'] });
    for (const name of fileList) {
      // Prevent path traversal
      if (name.includes('/') || name.includes('..')) {
        errors.push(`${name}: 非法文件名`);
        continue;
      }
      const filePath = path.join(resultsDir, name);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          deleted++;
        }
      } catch (e) { errors.push(`${name}: ${e.message}`); }
    }
    // Clean up empty tool-results dir
    try {
      const remaining = fs.readdirSync(resultsDir);
      if (remaining.length === 0) fs.rmdirSync(resultsDir);
    } catch {}
    res.json({ ok: true, deleted, errors: errors.length > 0 ? errors : undefined });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
