const router = require('express').Router();
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { requireAuth } = require('../middleware/auth');

const execFileAsync = promisify(execFile);

async function compileJavaSource(source) {
  const normalizedSource = String(source || '');
  if (!normalizedSource.trim()) {
    throw new Error('Java source code is required');
  }

  const classMatch = normalizedSource.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
  const className = classMatch?.[1] || 'Main';
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oreos-java-'));
  const javaFile = path.join(tempDir, `${className}.java`);

  try {
    await fs.writeFile(javaFile, normalizedSource, 'utf8');
    const { stdout, stderr } = await execFileAsync('javac', [javaFile], { timeout: 10000 });
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

router.post('/java', requireAuth, async (req, res) => {
  const source = String(req.body?.source || '');
  if (!source.trim()) return res.status(400).json({ error: 'Java source code is required' });

  try {
    const { className, tempDir, compileOutput } = await compileJavaSource(source);
    await fs.rm(tempDir, { recursive: true, force: true });
    return res.json({
      ok: true,
      message: 'Compilation successful',
      className,
      output: compileOutput,
    });
  } catch (error) {
    const output = (error?.output || error?.message || 'Compilation failed').trim();
    return res.status(400).json({
      ok: false,
      error: output,
      output,
    });
  }
});

router.post('/java/run', requireAuth, async (req, res) => {
  const source = String(req.body?.source || '');
  if (!source.trim()) return res.status(400).json({ error: 'Java source code is required' });

  let tempDir = '';
  try {
    const compiled = await compileJavaSource(source);
    tempDir = compiled.tempDir;
    const { stdout, stderr } = await execFileAsync('java', ['-cp', tempDir, compiled.className], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });

    return res.json({
      ok: true,
      message: 'Program executed successfully',
      className: compiled.className,
      output: (stdout || stderr || '').trim(),
      compileOutput: compiled.compileOutput,
    });
  } catch (error) {
    const output = (error?.stderr || error?.stdout || error?.output || error?.message || 'Execution failed').trim();
    return res.status(400).json({
      ok: false,
      error: output,
      output,
    });
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
});

module.exports = router;
