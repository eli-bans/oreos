const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const TOP_LEVEL_CLASS_RE =
  /(?:^|\n)([ \t]*)((?:(?:public|private|protected)\s+)?(?:abstract\s+|final\s+|strictfp\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\b)/g;

function findTopLevelClassNames(source) {
  const names = [];
  let match;
  while ((match = TOP_LEVEL_CLASS_RE.exec(source)) !== null) {
    if (match[1] !== '') continue;
    names.push(match[3]);
  }
  return names;
}

function findPublicClassName(source) {
  const match = source.match(/\bpublic\s+class\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
  return match?.[1] || null;
}

function findClassWithMain(source) {
  const mainMatch = source.match(/\bpublic\s+static\s+void\s+main\s*\(\s*String\b/);
  if (!mainMatch || mainMatch.index === undefined) return null;

  const beforeMain = source.slice(0, mainMatch.index);
  let lastClass = null;
  let match;
  TOP_LEVEL_CLASS_RE.lastIndex = 0;
  while ((match = TOP_LEVEL_CLASS_RE.exec(beforeMain)) !== null) {
    if (match[1] !== '') continue;
    lastClass = match[3];
  }
  return lastClass;
}

function fileNameForSource(source, fallback = 'Main') {
  const publicName = findPublicClassName(source);
  if (publicName) return `${publicName}.java`;
  const first = findTopLevelClassNames(source)[0];
  return `${first || fallback}.java`;
}

function normalizeJavaFiles(input) {
  if (Array.isArray(input?.files) && input.files.length > 0) {
    const files = [];
    for (const entry of input.files) {
      const source = String(entry?.source ?? entry?.content ?? '').trim();
      if (!source) continue;
      let name = String(entry?.name ?? entry?.path ?? '').trim();
      if (!name) name = fileNameForSource(source);
      if (!name.endsWith('.java')) name = `${name.replace(/\.java$/i, '')}.java`;
      files.push({ name: path.basename(name), source });
    }
    if (files.length > 0) return files;
  }

  const source = String(input?.source ?? '').trim();
  if (!source) return [];
  return [{ name: fileNameForSource(source), source }];
}

function resolveMainClassName(files) {
  for (const file of files) {
    const mainClass = findClassWithMain(file.source);
    if (mainClass) return mainClass;
  }
  for (const file of files) {
    const publicName = findPublicClassName(file.source);
    if (publicName) return publicName;
  }
  const firstFile = files[0];
  if (firstFile) {
    const base = firstFile.name.replace(/\.java$/i, '');
    const names = findTopLevelClassNames(firstFile.source);
    if (names.includes(base)) return base;
    return names[0] || base || 'Main';
  }
  return 'Main';
}

async function compileJavaProject(input, { timeoutMs = 10000 } = {}) {
  const files = normalizeJavaFiles(input);
  if (files.length === 0) {
    throw new Error('Java source code is required');
  }

  const tempDir = await fs.mkdtemp(path.join(require('os').tmpdir(), 'oreos-java-'));
  try {
    for (const file of files) {
      await fs.writeFile(path.join(tempDir, file.name), file.source, 'utf8');
    }
    const javaPaths = files.map((f) => path.join(tempDir, f.name));
    const { stdout, stderr } = await execFileAsync('javac', javaPaths, { timeout: timeoutMs });
    const className = resolveMainClassName(files);
    return {
      className,
      tempDir,
      compileOutput: (stdout || stderr || '').trim(),
    };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    const output = (error?.stderr || error?.stdout || error?.message || 'Compilation failed').trim();
    const err = new Error(output);
    err.output = output;
    throw err;
  }
}

module.exports = {
  compileJavaProject,
  normalizeJavaFiles,
  resolveMainClassName,
  fileNameForSource,
  findPublicClassName,
};
