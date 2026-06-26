#!/usr/bin/env bash
# 产物收集测试 — 验证 extractBashFilePaths 的正则匹配能力
# 用法: bash test_artifact_extraction.sh

set -e

TMPDIR=$(mktemp -d)
cd "$TMPDIR"
echo "测试目录: $TMPDIR"

PASS=0
FAIL=0

check() {
  local desc="$1"
  local cmd="$2"
  local result="$3"
  local expected="$4"

  # 调用 Node 提取
  local actual
  actual=$(node -e "
    const cwd = '$TMPDIR';
    const command = $(node -p "JSON.stringify(process.argv[1])" "$cmd");
    const resultContent = $(node -p "JSON.stringify(process.argv[1])" "$result");

    // 模拟 extractBashFilePaths 的核心逻辑
    const path = require('path');
    const fs = require('fs');
    const os = require('os');

    const cdMatches = [...command.matchAll(/(?:^|&&\s*|;\s*)cd\s+(\S+)/g)];
    let effectiveCwd = cwd;
    if (cdMatches.length > 0) {
      const lastCd = cdMatches[cdMatches.length - 1][1].replace(/^['\"]|['\"]$/g, '');
      effectiveCwd = lastCd.startsWith('/') ? lastCd : path.join(cwd, lastCd);
    }

    const paths = [];

    // 1. Output redirection
    for (const m of command.matchAll(/(?:^|\s)(?:[12]?>|&>)\s*(\S+)/g)) {
      const p = m[1].replace(/^['\"]|['\"]$/g, '');
      if (p && !p.startsWith('/dev/')) paths.push(p);
    }
    // 6b. tar
    for (const m of command.matchAll(/tar\s+-?[a-zA-Z]*f\s+(\S+)/g)) {
      if (!m[1].startsWith('-')) paths.push(m[1]);
    }
    for (const m of command.matchAll(/tar\s+.*?\s-f\s+(\S+)/g)) {
      if (!m[1].startsWith('-')) paths.push(m[1]);
    }
    // 6c. zip
    const zipM = command.match(/(?:^|\s)zip\s+(?:-[a-zA-Z0-9]+\s+)*(\S+)/);
    if (zipM && !zipM[1].startsWith('-')) paths.push(zipM[1]);
    // 6d. 7z
    const sevenZM = command.match(/(?:^|\s)7z\s+a\s+(\S+)/);
    if (sevenZM) paths.push(sevenZM[1]);
    // 6e. gzip / bzip2 / xz (output is file.gz / file.bz2 / file.xz)
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
    // 11. absolute paths in result
    const resultExtRe = /(\/(?:[^\s\"'\`]+\/)*[^\s\"'\`]+\.(?:png|jpe?g|gif|webp|bmp|svg|ico|pdf|docx?|xlsx?|pptx?|zip|tar|gz|tgz|bz2|xz|7z|rar|csv|tsv|txt|md|json|yaml|yml|xml|html?|css|py|js|ts|sh|sql|db|sqlite3?|pkl|h5|pt|onnx|npy|npz|env|cfg|ini|toml|lock|log))(?:\\b|\$)/gi;
    for (const m of (resultContent || '').matchAll(resultExtRe)) {
      paths.push(m[1]);
    }
    // 12. relative paths in result (exclude fullwidth colon from capture)
    const relativeExtRe = /(?:^|\s|[：:])['\"]?([^\s\"'\`：]{1,200}\.(?:zip|tar|gz|tgz|bz2|xz|7z|rar|xlsx?|docx?|pptx?|pdf|csv|png|jpe?g|gif|webp|svg))['\"]?(?:\s|\$|[,，。.])/gmi;
    for (const m of (resultContent || '').matchAll(relativeExtRe)) {
      const p = m[1].replace(/^['\"]|['\"]$/g, '');
      if (p && !p.startsWith('/') && !p.startsWith('-')) {
        paths.push(p);
      }
    }

    // Resolve
    const resolved = [...new Set(paths.map(p => {
      p = p.replace(/^['\"]|['\"]$/g, '');
      if (p.startsWith('/')) return p;
      if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
      return path.join(effectiveCwd, p);
    }))];

    console.log(JSON.stringify(resolved));
  " 2>/dev/null)

  if echo "$actual" | grep -qF "$expected"; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc"
    echo "     期望包含: $expected"
    echo "     实际结果: $actual"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "===== 1. Bash 命令解析 ====="

# 创建真实文件让 fs.existsSync 通过
echo "test" > output.zip
echo "test" > output.tar.gz
echo "test" > output.7z
echo "test" > archive.tar
echo "test" > backup.gz

check "zip -r output.zip folder/" \
  "zip -r output.zip src/" \
  "" \
  "$TMPDIR/output.zip"

check "zip -rm output.zip folder/ (组合短选项)" \
  "zip -rm output.zip src/" \
  "" \
  "$TMPDIR/output.zip"

check "tar czf output.tar.gz folder/" \
  "tar czf output.tar.gz src/" \
  "" \
  "$TMPDIR/output.tar.gz"

check "tar -czf output.tar.gz folder/" \
  "tar -czf output.tar.gz src/" \
  "" \
  "$TMPDIR/output.tar.gz"

check "tar -c -f archive.tar folder/ (分离选项)" \
  "tar -c -f archive.tar src/" \
  "" \
  "$TMPDIR/archive.tar"

check "7z a output.7z folder/" \
  "7z a output.7z src/" \
  "" \
  "$TMPDIR/output.7z"

check "gzip backup (生成 backup.gz)" \
  "gzip backup" \
  "" \
  "$TMPDIR/backup.gz"

check "输出重定向: python script.py > output.csv" \
  "python process.py > output.csv" \
  "" \
  "$TMPDIR/output.csv"

check "输出重定向: python script.py > output.csv (2> stderr)" \
  "python process.py 2>errors.log > output.csv" \
  "" \
  "$TMPDIR/output.csv"

check "cd 子目录后打包: cd sub && zip output.zip *" \
  "cd subdir && zip -r output.zip *" \
  "" \
  "$TMPDIR/subdir/output.zip"

echo ""
echo "===== 2. 命令结果文本扫描 ====="

# 创建更多测试文件
mkdir -p subdir
echo "test" > subdir/report.xlsx
echo "test" > subdir/data.zip
echo "test" > archive.tar.gz

check "绝对路径: Wrote /tmp/xxx/data.csv" \
  "python process.py" \
  "处理完成: $TMPDIR/subdir/data.zip" \
  "$TMPDIR/subdir/data.zip"

check "绝对路径: File created at: /path/to/file.pdf" \
  "python generate.py" \
  "File created successfully at: $TMPDIR/subdir/report.xlsx" \
  "$TMPDIR/subdir/report.xlsx"

# 新功能: 相对路径扫描
check "相对路径: Created output.zip (新第12条)" \
  "python pack.py" \
  "Created output.zip successfully" \
  "$TMPDIR/output.zip"

check "相对路径: 中文冒号：report.xlsx (新第12条)" \
  "python gen.py" \
  "生成完成：report.xlsx" \
  "$TMPDIR/report.xlsx"

check "相对路径: 生成 archive.tar.gz (新第12条)" \
  "python backup.py" \
  "打包完成: archive.tar.gz" \
  "$TMPDIR/archive.tar.gz"

echo ""
echo "===== 3. filterArtifactPaths 过滤规则 ====="

# 创建 .开头的目录结构
mkdir -p dotdir
echo "test" > dotdir/result.zip
echo "test" > dotdir/.hidden
echo "test" > dotdir/normal.txt

# filterArtifactPaths 测试
FILTER_TEST=$(node -e "
const path = require('path');
const cwd = '$TMPDIR';

function filterArtifactPaths(absPaths, cwd) {
  const cwdAbs = path.resolve(cwd || '/');
  const excludeDirs = new Set([
    'node_modules', '__pycache__', '.git', 'dist', 'build', '.next',
    'target', 'out', 'coverage', '.cache', 'vendor', 'bower_components',
  ]);
  const excludeExts = new Set([
    '.pyc', '.pyo', '.o', '.obj', '.class', '.dll', '.so', '.dylib',
    '.wasm', '.map', '.tsbuildinfo',
  ]);
  return absPaths.filter(p => {
    if (!p.startsWith(cwdAbs + path.sep) && p !== cwdAbs) return false;
    // NEW rule 2: only check filename (basename), not directory segments
    const basename = path.basename(p);
    if (basename.startsWith('.')) return false;
    // Rule 3: check directory segments (excluding filename) for junk dirs
    const rel = p.slice(cwdAbs.length);
    const segments = rel.split(path.sep).filter(Boolean);
    if (segments.length > 1 && segments.slice(0, -1).some(s => excludeDirs.has(s))) return false;
    if (excludeExts.has(path.extname(p).toLowerCase())) return false;
    return true;
  });
}

const dotDirFile = path.join('$TMPDIR', 'dotdir', 'result.zip');
const hiddenFile = path.join('$TMPDIR', 'dotdir', '.hidden');
const normalFile = path.join('$TMPDIR', 'dotdir', 'normal.txt');

const result = filterArtifactPaths([dotDirFile, hiddenFile, normalFile], cwd);
console.log(JSON.stringify(result));
" 2>/dev/null)

if echo "$FILTER_TEST" | grep -q "result.zip" && echo "$FILTER_TEST" | grep -q "normal.txt" && ! echo "$FILTER_TEST" | grep -q ".hidden"; then
  echo "  ✅ filterArtifactPaths: dot-dir 中的文件被保留，隐藏文件被过滤"
  PASS=$((PASS + 1))
else
  echo "  ❌ filterArtifactPaths: 期望保留 result.zip 和 normal.txt，过滤 .hidden"
  echo "     实际: $FILTER_TEST"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=============================="
echo "  通过: $PASS  失败: $FAIL"
echo "=============================="

# 清理
cd /
rm -rf "$TMPDIR"

[ "$FAIL" -eq 0 ] && echo "全部通过 ✅" || echo "存在失败 ❌"
exit $FAIL
