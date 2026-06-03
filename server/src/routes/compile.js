const router = require('express').Router();
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { requireAuth } = require('../middleware/auth');
const { compileJavaProject } = require('../javaCompile');

const execFileAsync = promisify(execFile);
const COMPILE_TIMEOUT_MS = 10000;
const RUN_TIMEOUT_MS = 5000;
const MAX_BUFFER_BYTES = 1024 * 1024;

// Force monochrome output from subprocesses so we don't surface escape codes
// in the student-facing terminal. NO_COLOR is the cross-tool standard;
// PYTHONNOCOLOR disables Python 3.13's new colorized tracebacks; TERM=dumb
// stops most other tools (g++ included) from emitting ANSI.
const PLAIN_ENV = {
  ...process.env,
  NO_COLOR: '1',
  CLICOLOR: '0',
  PYTHONNOCOLOR: '1',
  TERM: 'dumb',
};

// Defensive: strip any ANSI escape sequence that still slips through.
// Covers CSI sequences (colors, cursor moves) and OSC sequences (titles).
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
function stripAnsi(text) {
  return String(text || '').replace(ANSI_RE, '');
}

function runWithInput(command, args, stdin = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: PLAIN_ENV });
    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      child.kill('SIGKILL');
      const err = new Error('Execution timed out');
      err.output = 'Execution timed out';
      reject(err);
    }, RUN_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length + stderr.length > MAX_BUFFER_BYTES) {
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stdout.length + stderr.length > MAX_BUFFER_BYTES) {
        child.kill('SIGKILL');
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      finished = true;
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (finished) return;
      finished = true;
      const cleanStdout = stripAnsi(stdout);
      const cleanStderr = stripAnsi(stderr);
      const output = (cleanStdout || cleanStderr || '').trim();
      if (code === 0) {
        resolve({ stdout: cleanStdout, stderr: cleanStderr, output });
      } else {
        const err = new Error(output || 'Execution failed');
        err.output = output || 'Execution failed';
        reject(err);
      }
    });

    child.stdin.write(String(stdin || ''));
    child.stdin.end();
  });
}

async function compilePythonSource(source) {
  const normalizedSource = String(source || '');
  if (!normalizedSource.trim()) {
    throw new Error('Python source code is required');
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oreos-python-'));
  const pyFile = path.join(tempDir, 'main.py');

  try {
    await fs.writeFile(pyFile, normalizedSource, 'utf8');
    const { stdout, stderr } = await execFileAsync('python3', ['-m', 'py_compile', pyFile], {
      timeout: COMPILE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      env: PLAIN_ENV,
    });
    return {
      tempDir,
      compileOutput: stripAnsi((stdout || stderr || '')).trim(),
    };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    const output = stripAnsi(error?.stderr || error?.stdout || error?.message || 'Compilation failed').trim();
    const err = new Error(output);
    err.output = output;
    throw err;
  }
}

async function compileCppSource(source) {
  const normalizedSource = String(source || '');
  if (!normalizedSource.trim()) {
    throw new Error('C++ source code is required');
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oreos-cpp-'));
  const cppFile = path.join(tempDir, 'main.cpp');
  const binaryFile = path.join(tempDir, 'main');

  try {
    await fs.writeFile(cppFile, normalizedSource, 'utf8');
    const { stdout, stderr } = await execFileAsync('g++', ['-fno-diagnostics-color', '-std=c++17', cppFile, '-o', binaryFile], {
      timeout: COMPILE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      env: PLAIN_ENV,
    });
    return {
      tempDir,
      binaryFile,
      compileOutput: stripAnsi((stdout || stderr || '')).trim(),
    };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    const output = stripAnsi(error?.stderr || error?.stdout || error?.message || 'Compilation failed').trim();
    const err = new Error(output);
    err.output = output;
    throw err;
  }
}

router.post('/java', requireAuth, async (req, res) => {
  try {
    const { className, tempDir, compileOutput } = await compileJavaProject(req.body, {
      timeoutMs: COMPILE_TIMEOUT_MS,
    });
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
  const stdin = String(req.body?.stdin || '');

  let tempDir = '';
  try {
    const compiled = await compileJavaProject(req.body, { timeoutMs: COMPILE_TIMEOUT_MS });
    tempDir = compiled.tempDir;
    const { output } = await runWithInput('java', ['-cp', tempDir, compiled.className], stdin);

    return res.json({
      ok: true,
      message: 'Program executed successfully',
      className: compiled.className,
      output,
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

router.post('/python', requireAuth, async (req, res) => {
  const source = String(req.body?.source || '');
  if (!source.trim()) return res.status(400).json({ error: 'Python source code is required' });

  try {
    const { tempDir, compileOutput } = await compilePythonSource(source);
    await fs.rm(tempDir, { recursive: true, force: true });
    return res.json({
      ok: true,
      message: 'Compilation successful',
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

router.post('/cpp', requireAuth, async (req, res) => {
  const source = String(req.body?.source || '');
  if (!source.trim()) return res.status(400).json({ error: 'C++ source code is required' });

  try {
    const { tempDir, compileOutput } = await compileCppSource(source);
    await fs.rm(tempDir, { recursive: true, force: true });
    return res.json({
      ok: true,
      message: 'Compilation successful',
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

router.post('/python/run', requireAuth, async (req, res) => {
  const source = String(req.body?.source || '');
  const stdin = String(req.body?.stdin || '');
  if (!source.trim()) return res.status(400).json({ error: 'Python source code is required' });

  let tempDir = '';
  try {
    const compiled = await compilePythonSource(source);
    tempDir = compiled.tempDir;
    const pyFile = path.join(tempDir, 'main.py');
    const { output } = await runWithInput('python3', [pyFile], stdin);

    return res.json({
      ok: true,
      message: 'Program executed successfully',
      output,
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

router.post('/cpp/run', requireAuth, async (req, res) => {
  const source = String(req.body?.source || '');
  const stdin = String(req.body?.stdin || '');
  if (!source.trim()) return res.status(400).json({ error: 'C++ source code is required' });

  let tempDir = '';
  try {
    const compiled = await compileCppSource(source);
    tempDir = compiled.tempDir;
    const { output } = await runWithInput(compiled.binaryFile, [], stdin);

    return res.json({
      ok: true,
      message: 'Program executed successfully',
      output,
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
