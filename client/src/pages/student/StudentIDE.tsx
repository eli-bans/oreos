import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Editor, { OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { api, Constraints, Session } from '@/lib/api';
import {
  createDefaultJavaWorkspace,
  javaFilesToApiPayload,
  JavaWorkspace,
  legacyToJavaWorkspace,
  serializeJavaWorkspace,
} from '@/lib/javaWorkspace';
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
  const [questions, setQuestions] = useState<string[]>([]);
  const [javaWorkspace, setJavaWorkspace] = useState<JavaWorkspace | null>(null);

  const codeRef = useRef('');
  const javaWorkspaceRef = useRef<JavaWorkspace | null>(null);
  const lastSentRef = useRef(0);
  const editorReadyRef = useRef(false);
  const idleFlaggedRef = useRef(false);
  const pendingEditorContentRef = useRef<string | null>(null);

  const syncCodeRef = useCallback((content: string, workspace: JavaWorkspace | null) => {
    javaWorkspaceRef.current = workspace;
    codeRef.current = workspace ? serializeJavaWorkspace(workspace) : content;
  }, []);

  const applyEditorContent = useCallback((content: string, workspace: JavaWorkspace | null = null) => {
    pendingEditorContentRef.current = content;
    syncCodeRef(content, workspace);
    if (editorRef.current) {
      editorRef.current.setValue(content);
      pendingEditorContentRef.current = null;
    }
  }, [syncCodeRef]);

  const persistActiveJavaFile = useCallback((editorValue: string) => {
    const ws = javaWorkspaceRef.current;
    if (!ws) return;
    const next: JavaWorkspace = {
      ...ws,
      files: { ...ws.files, [ws.active]: editorValue },
    };
    javaWorkspaceRef.current = next;
    setJavaWorkspace(next);
    syncCodeRef(editorValue, next);
  }, [syncCodeRef]);

  const switchJavaFile = useCallback((fileName: string) => {
    const ws = javaWorkspaceRef.current;
    if (!ws || fileName === ws.active || !(fileName in ws.files)) return;
    const editorValue = editorRef.current?.getValue() ?? ws.files[ws.active];
    const next: JavaWorkspace = {
      ...ws,
      active: fileName,
      files: { ...ws.files, [ws.active]: editorValue },
    };
    javaWorkspaceRef.current = next;
    setJavaWorkspace(next);
    syncCodeRef(next.files[fileName], next);
    if (editorRef.current) {
      editorRef.current.setValue(next.files[fileName]);
    }
  }, [syncCodeRef]);

  const addJavaFile = useCallback(() => {
    const ws = javaWorkspaceRef.current;
    if (!ws) return;
    const editorValue = editorRef.current?.getValue() ?? ws.files[ws.active];
    let index = 1;
    let fileName = 'Helper.java';
    let className = 'Helper';
    while (fileName in ws.files) {
      index += 1;
      className = `Helper${index}`;
      fileName = `${className}.java`;
    }
    const source = `class ${className} {\n}\n`;
    const next: JavaWorkspace = {
      ...ws,
      active: fileName,
      files: { ...ws.files, [ws.active]: editorValue, [fileName]: source },
    };
    javaWorkspaceRef.current = next;
    setJavaWorkspace(next);
    syncCodeRef(source, next);
    if (editorRef.current) {
      editorRef.current.setValue(source);
    }
  }, [syncCodeRef]);

  const removeJavaFile = useCallback((fileName: string) => {
    const ws = javaWorkspaceRef.current;
    if (!ws || Object.keys(ws.files).length <= 1) return;
    const editorValue = editorRef.current?.getValue() ?? ws.files[ws.active];
    const files = { ...ws.files, [ws.active]: editorValue };
    delete files[fileName];
    const names = Object.keys(files);
    const active = ws.active === fileName ? names[0] : ws.active;
    const next: JavaWorkspace = { ...ws, active, files };
    javaWorkspaceRef.current = next;
    setJavaWorkspace(next);
    syncCodeRef(next.files[active], next);
    if (editorRef.current && ws.active === fileName) {
      editorRef.current.setValue(next.files[active]);
    }
  }, [syncCodeRef]);

  // ─── Load session + restore saved work ─────────────────────────────────────
  useEffect(() => {
    if (!sessionId) return;
    Promise.all([
      api.getSession(sessionId),
      api.getMyWorkspace(sessionId),
    ])
      .then(([s, workspace]) => {
        setSession(s);
        setStatus(s.status);
        setConstraints(s.constraints);
        setQuestions(s.questions ?? []);
        const lang = workspace.language || s.constraints.language || 'javascript';
        setLanguage(lang);

        if (lang === 'java') {
          const ws = workspace.hasSavedWork && workspace.content
            ? legacyToJavaWorkspace(workspace.content, s.name)
            : createDefaultJavaWorkspace(s.name);
          setJavaWorkspace(ws);
          applyEditorContent(ws.files[ws.active], ws);
        } else {
          setJavaWorkspace(null);
          const content =
            workspace.hasSavedWork && workspace.content
              ? workspace.content
              : makeStarterComment(lang, s.name);
          applyEditorContent(content);
        }
      })
      .catch(() => navigate('/student'));
  }, [sessionId, navigate, applyEditorContent]);

  // ─── Socket setup ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionId) return;
    const socket = socketRef.current;

    socket.emit('student:join', { sessionId });

    socket.on('session:state', ({ status: s, constraints: c, questions: q }: { status: StatusKind; constraints: Constraints; questions?: string[] }) => {
      setStatus(s);
      setConstraints(c);
      if (q) setQuestions(q);
      if (c.language) setLanguage(c.language);
      if (s === 'ended') setSessionEnded(true);
    });

    socket.on('session:constraints_updated', (c: Constraints) => {
      setConstraints(c);
      if (c.language) setLanguage(c.language);
    });

    socket.on('session:questions_updated', (q: string[]) => {
      setQuestions(q);
    });

    socket.on('student:workspace', ({ content, language: lang }: { content: string; language: string }) => {
      if (content) {
        setLanguage(lang);
        if (lang === 'java') {
          const ws = legacyToJavaWorkspace(content, session?.name ?? 'Session');
          setJavaWorkspace(ws);
          applyEditorContent(ws.files[ws.active], ws);
        } else {
          setJavaWorkspace(null);
          applyEditorContent(content);
        }
      }
    });

    return () => {
      socket.off('session:state');
      socket.off('session:constraints_updated');
      socket.off('session:questions_updated');
      socket.off('student:workspace');
    };
  }, [sessionId, applyEditorContent]);

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
    idleFlaggedRef.current = false;
  }, [sessionId, language]);

  const emitFlag = useCallback((type: string, detail?: string) => {
    if (!sessionId) return;
    socketRef.current.emit('student:flag', { sessionId, type, detail });
    setFlagCount(f => f + 1);
  }, [sessionId]);

  // ─── Monaco editor mount ─────────────────────────────────────────────────────
  const handleEditorMount: OnMount = (editor) => {
    editorRef.current = editor;
    editorReadyRef.current = true;

    if (pendingEditorContentRef.current !== null) {
      editor.setValue(pendingEditorContentRef.current);
      pendingEditorContentRef.current = null;
    } else if (session) {
      if (language === 'java') {
        const ws = javaWorkspaceRef.current ?? createDefaultJavaWorkspace(session.name);
        javaWorkspaceRef.current = ws;
        setJavaWorkspace(ws);
        editor.setValue(ws.files[ws.active]);
        syncCodeRef(ws.files[ws.active], ws);
      } else {
        const starter = makeStarterComment(language, session.name);
        editor.setValue(starter);
        syncCodeRef(starter, null);
      }
    }

    // Log every content change
    editor.onDidChangeModelContent((e) => {
      const code = editor.getValue();
      if (language === 'java' && javaWorkspaceRef.current) {
        persistActiveJavaFile(code);
      } else {
        syncCodeRef(code, null);
      }

      for (const change of e.changes) {
        emitEvent('change', { text: change.text, rangeLength: change.rangeLength });
      }
    });

    // Log cursor movement
    editor.onDidChangeCursorPosition((e) => {
      emitEvent('cursor', { line: e.position.lineNumber, col: e.position.column });
    });

    editor.onKeyDown((e) => {
      const key = e.browserEvent.key.toLowerCase();
      const mod = e.browserEvent.ctrlKey || e.browserEvent.metaKey;
      if (mod && (key === 'v' || key === 'c' || key === 'x')) {
        emitFlag('clipboard_shortcut', `Shortcut: ${key.toUpperCase()}`);
      }
    });
  };

  // ─── Paste interception (always allowed, always flagged) ────────────────────
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const pastedText = e.clipboardData?.getData('text') ?? '';
      emitEvent('paste', { length: pastedText.length });
      emitFlag('paste', `Pasted ${pastedText.length} chars`);
      setPasteCount(p => p + 1);
    };
    document.addEventListener('paste', handlePaste, true);
    return () => {
      document.removeEventListener('paste', handlePaste, true);
    };
  }, [emitEvent, emitFlag]);

  // ─── Tab / visibility monitoring (always flagged) ───────────────────────────
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        setTabSwitches(t => t + 1);
        emitFlag('tab_switch', 'Page became hidden');
        setFullscreenWarning(true);
      } else {
        emitEvent('returned', {});
        setFullscreenWarning(false);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [emitEvent, emitFlag]);

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
      if (idleSecs > 30 && !idleFlaggedRef.current) {
        idleFlaggedRef.current = true;
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
      const javaPayload = javaWorkspaceRef.current
        ? javaFilesToApiPayload(javaWorkspaceRef.current)
        : { source: codeRef.current };
      const result =
        language === 'java'
          ? await api.compileJava(javaPayload)
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
      const javaPayload = javaWorkspaceRef.current
        ? javaFilesToApiPayload(javaWorkspaceRef.current)
        : { source: codeRef.current };
      const result =
        language === 'java'
          ? await api.runJava(javaPayload, stdinText)
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
            onChange={e => {
              const nextLang = e.target.value;
              if (language === 'java' && editorRef.current) {
                persistActiveJavaFile(editorRef.current.getValue());
              }
              if (nextLang === 'java') {
                const ws = javaWorkspaceRef.current ?? createDefaultJavaWorkspace(session?.name ?? 'Session');
                setJavaWorkspace(ws);
                javaWorkspaceRef.current = ws;
                applyEditorContent(ws.files[ws.active], ws);
              } else {
                setJavaWorkspace(null);
                javaWorkspaceRef.current = null;
                const fallback = editorRef.current?.getValue() || makeStarterComment(nextLang, session?.name ?? 'Session');
                applyEditorContent(fallback);
              }
              setLanguage(nextLang);
            }}
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

      <div className={styles.workspace}>
        {questions.length > 0 && (
          <aside className={styles.questionsPanel}>
            <h3 className={styles.questionsTitle}>Questions</h3>
            {questions.map((q, i) => (
              <div key={i} className={styles.questionItem}>
                <span className={styles.questionNum}>Q{i + 1}</span>
                <p className={styles.questionText}>{q}</p>
              </div>
            ))}
          </aside>
        )}
        {language === 'java' && javaWorkspace && (
          <aside className={styles.filesPanel}>
            <div className={styles.filesHeader}>
              <span>Files</span>
              <button type="button" className={styles.filesAdd} onClick={addJavaFile} title="Add Java file">
                +
              </button>
            </div>
            <div className={styles.filesList}>
              {Object.keys(javaWorkspace.files).sort().map((fileName) => (
                <div
                  key={fileName}
                  className={`${styles.fileTab} ${fileName === javaWorkspace.active ? styles.fileTabActive : ''}`}
                >
                  <button type="button" className={styles.fileTabBtn} onClick={() => switchJavaFile(fileName)}>
                    {fileName}
                  </button>
                  {Object.keys(javaWorkspace.files).length > 1 && (
                    <button
                      type="button"
                      className={styles.fileRemove}
                      onClick={() => removeJavaFile(fileName)}
                      title={`Remove ${fileName}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          </aside>
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
      </footer>
    </div>
  );
}
