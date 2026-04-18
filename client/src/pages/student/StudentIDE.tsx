import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Editor, { OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { api, Constraints, Session } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useAuthStore } from '@/store/auth';
import styles from './StudentIDE.module.css';

type StatusKind = 'waiting' | 'active' | 'ended';

function makeStarterComment(lang: string, sessionName: string): string {
  switch (lang) {
    case 'python':
      return `# Session: ${sessionName}\n# Good luck!\n\n`;
    case 'java':
      return (
        `/**\n` +
        ` * Session: ${sessionName}\n` +
        ` * Good luck!\n` +
        ` */\n\n` +
        `public class Main {\n` +
        `    public static void main(String[] args) {\n` +
        `        \n` +
        `    }\n` +
        `}\n`
      );
    case 'c':
      return (
        `/* Session: ${sessionName} */\n` +
        `/* Good luck! */\n\n` +
        `#include <stdio.h>\n\n` +
        `int main() {\n` +
        `    \n` +
        `    return 0;\n` +
        `}\n`
      );
    case 'cpp':
      return (
        `// Session: ${sessionName}\n` +
        `// Good luck!\n\n` +
        `#include <iostream>\n` +
        `using namespace std;\n\n` +
        `int main() {\n` +
        `    \n` +
        `    return 0;\n` +
        `}\n`
      );
    case 'typescript':
    case 'javascript':
    default:
      return `// Session: ${sessionName}\n// Good luck!\n\n`;
  }
}

export default function StudentIDE() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const socketRef = useRef(getSocket());
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<StatusKind>('waiting');
  const [constraints, setConstraints] = useState<Constraints>({});
  const [language, setLanguage] = useState('javascript');
  const [tabSwitches, setTabSwitches] = useState(0);
  const [pasteCount, setPasteCount] = useState(0);
  const [flagCount, setFlagCount] = useState(0);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [fullscreenWarning, setFullscreenWarning] = useState(false);
  const [compileResult, setCompileResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [running, setRunning] = useState(false);
  const [stdinText, setStdinText] = useState('');
  const [showPanel, setShowPanel] = useState(false);

  const codeRef = useRef('');
  const lastSentRef = useRef(0);
  const constraintsRef = useRef<Constraints>({});
  const starterInjected = useRef(false);

  useEffect(() => {
    constraintsRef.current = constraints;
  }, [constraints]);

  // ─── Load session ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionId) return;
    api.getSession(sessionId).then(s => {
      setSession(s);
      setStatus(s.status);
      setConstraints(s.constraints);
      const lang = s.constraints.language || 'javascript';
      if (s.constraints.language) setLanguage(lang);

      if (editorRef.current && !starterInjected.current) {
        starterInjected.current = true;
        const starter = makeStarterComment(lang, s.name);
        editorRef.current.setValue(starter);
        codeRef.current = starter;
      }
    }).catch(() => navigate('/student'));
  }, [sessionId]);

  // ─── Socket setup ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionId) return;
    const socket = socketRef.current;

    socket.emit('student:join', { sessionId });

    socket.on('session:state', ({ status: s, constraints: c }: { status: StatusKind; constraints: Constraints }) => {
      setStatus(s);
      setConstraints(c);
      if (c.language) setLanguage(c.language);
      if (s === 'ended') setSessionEnded(true);
    });

    socket.on('session:constraints_updated', (c: Constraints) => {
      setConstraints(c);
      if (c.language) setLanguage(c.language);
    });

    return () => {
      socket.off('session:state');
      socket.off('session:constraints_updated');
    };
  }, [sessionId]);

  // ─── Emit keystroke/code event ───────────────────────────────────────────────
  const emitEvent = useCallback((type: string, data: Record<string, unknown> = {}) => {
    if (!sessionId) return;
    socketRef.current.emit('student:keystroke', {
      sessionId,
      type,
      data: { ...data, fullCode: codeRef.current, language },
      ts: Date.now(),
    });
    lastSentRef.current = Date.now();
  }, [sessionId, language]);

  const emitFlag = useCallback((type: string, detail?: string) => {
    if (!sessionId) return;
    socketRef.current.emit('student:flag', { sessionId, type, detail });
    setFlagCount(f => f + 1);
  }, [sessionId]);

  // ─── Monaco editor mount ─────────────────────────────────────────────────────
  const handleEditorMount: OnMount = (editor) => {
    editorRef.current = editor;

    if (session && !starterInjected.current) {
      starterInjected.current = true;
      const starter = makeStarterComment(language, session.name);
      editor.setValue(starter);
      codeRef.current = starter;
    }

    // Log every content change
    editor.onDidChangeModelContent((e) => {
      const code = editor.getValue();
      codeRef.current = code;

      for (const change of e.changes) {
        emitEvent('change', { text: change.text, rangeLength: change.rangeLength });
      }
    });

    // Log cursor movement
    editor.onDidChangeCursorPosition((e) => {
      emitEvent('cursor', { line: e.position.lineNumber, col: e.position.column });
    });

    // Block clipboard shortcuts inside Monaco when paste/copy is disallowed.
    editor.onKeyDown((e) => {
      const blocked = !constraintsRef.current.allowPaste;
      if (!blocked) return;
      const key = e.browserEvent.key.toLowerCase();
      const mod = e.browserEvent.ctrlKey || e.browserEvent.metaKey;
      if (mod && (key === 'v' || key === 'c' || key === 'x')) {
        e.preventDefault();
        e.stopPropagation();
        emitFlag('clipboard_blocked', `Blocked shortcut: ${key.toUpperCase()}`);
      }
    });
  };

  // ─── Paste interception ──────────────────────────────────────────────────────
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const pastedText = e.clipboardData?.getData('text') ?? '';
      if (!constraints.allowPaste) {
        e.preventDefault();
        emitFlag('paste_blocked', `Attempted to paste ${pastedText.length} chars`);
      } else {
        emitEvent('paste', { length: pastedText.length });
        emitFlag('paste', `Pasted ${pastedText.length} chars`);
        setPasteCount(p => p + 1);
      }
    };
    const handleCopyCut = (e: ClipboardEvent) => {
      if (!constraints.allowPaste) {
        e.preventDefault();
        emitFlag('clipboard_blocked', `${e.type} blocked`);
      }
    };
    document.addEventListener('paste', handlePaste, true);
    document.addEventListener('copy', handleCopyCut, true);
    document.addEventListener('cut', handleCopyCut, true);
    return () => {
      document.removeEventListener('paste', handlePaste, true);
      document.removeEventListener('copy', handleCopyCut, true);
      document.removeEventListener('cut', handleCopyCut, true);
    };
  }, [constraints.allowPaste, emitEvent, emitFlag]);

  // ─── Tab / visibility monitoring ─────────────────────────────────────────────
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        setTabSwitches(t => t + 1);
        emitFlag('tab_switch', 'Page became hidden');
        if (!constraints.allowTabSwitch) {
          setFullscreenWarning(true);
        }
      } else {
        emitEvent('returned', {});
        setFullscreenWarning(false);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [constraints.allowTabSwitch, emitEvent, emitFlag]);

  // ─── Window blur / focus monitoring ─────────────────────────────────────────
  useEffect(() => {
    const handleBlur = () => {
      emitFlag('window_blur', 'Window lost focus');
    };
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, [emitFlag]);

  // ─── Heartbeat + idle tracking ───────────────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const idleSecs = Math.round((now - lastSentRef.current) / 1000);
      if (idleSecs > 30) {
        emitFlag('idle', `Idle for ${idleSecs}s`);
      }
      emitEvent('heartbeat', { idleSecs });
    }, 15000);
    return () => clearInterval(interval);
  }, [emitEvent, emitFlag]);

  const handleCompile = useCallback(async () => {
    if (!['java', 'python', 'cpp'].includes(language) || compiling) return;
    setShowPanel(true);
    setCompiling(true);
    setCompileResult(null);
    try {
      const result =
        language === 'java'
          ? await api.compileJava(codeRef.current)
          : language === 'python'
            ? await api.compilePython(codeRef.current)
            : await api.compileCpp(codeRef.current);
      const output = result.output?.trim();
      setCompileResult({
        ok: true,
        text: output ? `Compilation successful\n\n${output}` : 'Compilation successful\n\n(no compiler output)',
      });
      emitEvent('compile_success', { language });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Compilation failed';
      setCompileResult({ ok: false, text: message });
      emitFlag('compile_error', message.slice(0, 500));
    } finally {
      setCompiling(false);
    }
  }, [language, compiling, emitEvent, emitFlag]);

  const handleRun = useCallback(async () => {
    if (!['java', 'python', 'cpp'].includes(language) || running) return;
    setShowPanel(true);
    setRunning(true);
    setCompileResult(null);
    try {
      const result =
        language === 'java'
          ? await api.runJava(codeRef.current, stdinText)
          : language === 'python'
            ? await api.runPython(codeRef.current, stdinText)
            : await api.runCpp(codeRef.current, stdinText);
      const output = result.output?.trim();
      setCompileResult({
        ok: true,
        text: `Program executed successfully\n\n${output || '(no program output)'}`,
      });
      emitEvent('run_success', { language });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Execution failed';
      setCompileResult({ ok: false, text: message });
      emitFlag('run_error', message.slice(0, 500));
    } finally {
      setRunning(false);
    }
  }, [language, running, stdinText, emitEvent, emitFlag]);

  // ─── Prevent right-click ─────────────────────────────────────────────────────
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    document.addEventListener('contextmenu', block);
    return () => document.removeEventListener('contextmenu', block);
  }, []);

  // ─── Keyboard shortcut blocking ──────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Block F12, Ctrl+Shift+I/J/C (devtools)
      if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && ['i','j','c','I','J','C'].includes(e.key))) {
        e.preventDefault();
        emitFlag('devtools_attempt', `Key: ${e.key}`);
        return;
      }
      emitEvent('keydown', { key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey });
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [emitEvent, emitFlag]);

  if (sessionEnded) {
    return (
      <div className={styles.overlay}>
        <div className={styles.overlayCard}>
          <span className={styles.overlayIcon}>🔒</span>
          <h2>Session ended</h2>
          <p>Your lecturer has closed this session. Your work has been saved.</p>
          <button className="btn btn-primary" onClick={() => navigate('/student')}>Back to home</button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {fullscreenWarning && (
        <div className={styles.warning}>
          ⚠ Tab switch detected — this has been flagged for your lecturer.
          <button onClick={() => setFullscreenWarning(false)}>Dismiss</button>
        </div>
      )}

      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.logo}>⬡ Oreos</span>
          <span className={`badge ${status === 'active' ? 'badge-green' : 'badge-yellow'}`}>{status === 'active' ? 'Session active' : 'Waiting to start'}</span>
        </div>

        <div className={styles.headerCenter}>
          {session?.name && <span className={styles.sessionName}>{session.name}</span>}
        </div>

        <div className={styles.headerRight}>
          <div className={styles.monitorStats}>
            {tabSwitches > 0 && <span className="badge badge-red">↗ {tabSwitches} tab switches</span>}
            {pasteCount > 0 && <span className="badge badge-yellow">📋 {pasteCount} pastes</span>}
            {flagCount > 0 && <span className="badge badge-red">⚑ {flagCount} flags</span>}
          </div>
          <select
            value={language}
            onChange={e => setLanguage(e.target.value)}
            className={styles.langSelect}
            disabled={!!constraints.language}
          >
            <option value="javascript">JavaScript</option>
            <option value="python">Python</option>
            <option value="typescript">TypeScript</option>
            <option value="java">Java</option>
            <option value="cpp">C++</option>
            <option value="c">C</option>
          </select>
          {['java', 'python', 'cpp'].includes(language) && (
            <>
              <button className="btn btn-ghost" onClick={handleCompile} disabled={compiling || running}>
                {compiling ? 'Compiling...' : `Compile ${language === 'cpp' ? 'C++' : language[0].toUpperCase() + language.slice(1)}`}
              </button>
              {['java', 'python', 'cpp'].includes(language) && (
                <button className="btn btn-primary" onClick={handleRun} disabled={running || compiling}>
                  {running ? 'Running...' : `Run ${language === 'cpp' ? 'C++' : language[0].toUpperCase() + language.slice(1)}`}
                </button>
              )}
            </>
          )}
          <span className={styles.monitorBadge}>🔴 Monitored</span>
        </div>
      </header>

      {status === 'waiting' && (
        <div className={styles.waitingBanner}>
          ⏳ Your lecturer hasn't started the session yet. You can begin writing — it will be recorded once the session starts.
        </div>
      )}

      <div className={styles.editorWrap}>
        <Editor
          height="100%"
          language={language}
          defaultValue=""
          theme="vs-dark"
          onMount={handleEditorMount}
          options={{
            fontSize: 14,
            minimap: { enabled: false },
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            automaticLayout: true,
            contextmenu: false,
          }}
        />
      </div>
      {['java', 'python', 'cpp'].includes(language) && showPanel && (
        <div className={styles.bottomPanel}>
          <div className={styles.panelHeader}>
            <span className={styles.panelTitle}>Terminal</span>
            <button className={styles.panelClose} onClick={() => setShowPanel(false)}>&times;</button>
          </div>
          <div className={styles.panelBody}>
            <div className={styles.stdinWrap}>
              <label className={styles.stdinLabel}>Input (stdin)</label>
              <textarea
                value={stdinText}
                onChange={(e) => setStdinText(e.target.value)}
                placeholder={'Enter input lines here...\nExample:\n5\n1 2 3 4 5'}
                className={styles.stdinInput}
                rows={3}
              />
            </div>
            {compileResult && (
              <div className={`${styles.compileResult} ${compileResult.ok ? styles.compileOk : styles.compileError}`}>
                {compileResult.text}
              </div>
            )}
          </div>
        </div>
      )}

      <footer className={styles.footer}>
        <span>📡 Connected</span>
        <span>{user?.name}</span>
        <span className={styles.constraints}>
          Paste: <strong style={{ color: constraints.allowPaste ? 'var(--green)' : 'var(--red)' }}>{constraints.allowPaste ? 'allowed' : 'blocked'}</strong>
          &nbsp;·&nbsp;
          Tab switch: <strong style={{ color: constraints.allowTabSwitch ? 'var(--green)' : 'var(--red)' }}>{constraints.allowTabSwitch ? 'allowed' : 'flagged'}</strong>
        </span>
      </footer>
    </div>
  );
}
