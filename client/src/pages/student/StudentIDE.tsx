import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Modal } from '@/components/Modal';
import { Kbd, modKey } from '@/components/Kbd';
import { toast } from '@/components/Toaster';
import styles from './StudentIDE.module.css';

const LANG_LABEL: Record<string, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  java: 'Java',
  cpp: 'C++',
  c: 'C',
};

const JAVA_CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

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
  const [connected, setConnected] = useState(socketRef.current.connected);
  const [compileResult, setCompileResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [running, setRunning] = useState(false);
  const [stdinText, setStdinText] = useState('');
  const [showPanel, setShowPanel] = useState(false);
  const [questions, setQuestions] = useState<string[]>([]);
  const [javaWorkspace, setJavaWorkspace] = useState<JavaWorkspace | null>(null);
  const [submittedAt, setSubmittedAt] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [showSubmittedSuccess, setShowSubmittedSuccess] = useState(false);
  const [showAddFileModal, setShowAddFileModal] = useState(false);
  const [newFileName, setNewFileName] = useState('');

  const wasDisconnectedRef = useRef(false);
  const codeRef = useRef('');
  const javaWorkspaceRef = useRef<JavaWorkspace | null>(null);
  const lastSentRef = useRef(0);
  const editorReadyRef = useRef(false);
  const idleFlaggedRef = useRef(false);
  const hasStartedTypingRef = useRef(false);
  const pendingEditorContentRef = useRef<string | null>(null);
  // Tracks the most recent text the student copied from within this page so
  // we can tell the difference between "moving my own code" (not suspicious)
  // and "pasting from an external source" (suspicious).
  const ownClipboardRef = useRef<string>('');

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

  const openAddJavaFile = useCallback(() => {
    if (!javaWorkspaceRef.current || submittedAt) return;
    setNewFileName('');
    setShowAddFileModal(true);
  }, [submittedAt]);

  const commitAddJavaFile = useCallback((rawName: string): { ok: true } | { ok: false; reason: string } => {
    const ws = javaWorkspaceRef.current;
    if (!ws) return { ok: false, reason: 'Workspace not ready' };
    const className = rawName.trim().replace(/\.java$/i, '');
    if (!className) return { ok: false, reason: 'Enter a class name.' };
    if (!JAVA_CLASS_NAME.test(className)) {
      return { ok: false, reason: 'Use letters, digits, _ or $. Don\'t start with a digit.' };
    }
    const fileName = `${className}.java`;
    if (fileName in ws.files) return { ok: false, reason: `${fileName} already exists.` };

    const editorValue = editorRef.current?.getValue() ?? ws.files[ws.active];
    const source = `class ${className} {\n    \n}\n`;
    const next: JavaWorkspace = {
      ...ws,
      active: fileName,
      files: { ...ws.files, [ws.active]: editorValue, [fileName]: source },
    };
    javaWorkspaceRef.current = next;
    setJavaWorkspace(next);
    syncCodeRef(source, next);
    if (editorRef.current) editorRef.current.setValue(source);
    return { ok: true };
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
        if (workspace.submittedAt) setSubmittedAt(workspace.submittedAt);

        let lang = workspace.language || s.constraints.language || 'javascript';
        let savedContent = workspace.hasSavedWork && workspace.content ? workspace.content : '';
        let recovered = false;

        // Prefer a local draft when it's fresher than the server copy and the
        // student hasn't submitted — recovers work that never synced (e.g. a
        // network cut left the last edits stuck on the device).
        if (!workspace.submittedAt && sessionId && user) {
          try {
            const raw = localStorage.getItem(`oreos_draft_${sessionId}_${user.id}`);
            if (raw) {
              const draft = JSON.parse(raw);
              const serverTs = workspace.savedAt ?? 0;
              const draftTs = draft?.ts ?? 0;
              if (typeof draft?.content === 'string' && draft.content &&
                  (!savedContent || draftTs > serverTs)) {
                savedContent = draft.content;
                if (draft.language) lang = draft.language;
                recovered = !!savedContent && draftTs > serverTs;
              }
            }
          } catch {
            // malformed draft — ignore and fall back to the server copy
          }
        }

        setLanguage(lang);

        if (lang === 'java') {
          const ws = savedContent
            ? legacyToJavaWorkspace(savedContent, s.name)
            : createDefaultJavaWorkspace(s.name);
          setJavaWorkspace(ws);
          applyEditorContent(ws.files[ws.active], ws);
        } else {
          setJavaWorkspace(null);
          applyEditorContent(savedContent || makeStarterComment(lang, s.name));
        }

        if (recovered) {
          toast.info('Recovered unsaved work', 'Restored code saved on this device since your last sync.');
        }
      })
      .catch(() => navigate('/student'));
  }, [sessionId, navigate, applyEditorContent]);

  // ─── Socket setup ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionId) return;
    const socket = socketRef.current;

    socket.emit('student:join', { sessionId });

    // On every (re)connect, re-join the room and push the latest full code so a
    // gap created while the socket was down is closed on the server immediately.
    const handleConnect = () => {
      setConnected(true);
      if (wasDisconnectedRef.current) {
        wasDisconnectedRef.current = false;
        toast.success('Back online', 'Your connection is restored and your work has synced.');
      }
      socket.emit('student:join', { sessionId });
      if (!submittedRef.current) {
        socket.emit('student:keystroke', {
          sessionId,
          type: 'resync',
          data: { fullCode: codeRef.current, language: languageRef.current },
          ts: Date.now(),
        });
      }
    };
    const handleDisconnect = () => {
      wasDisconnectedRef.current = true;
      setConnected(false);
      saveDraft(true);
    };
    // Browser-level offline fires faster than the socket's own timeout, so we
    // listen to both and treat either as "you've lost connection".
    const handleOffline = () => handleDisconnect();
    const handleOnline = () => { if (socket.connected) handleConnect(); };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

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
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      socket.off('session:state');
      socket.off('session:constraints_updated');
      socket.off('session:questions_updated');
      socket.off('student:workspace');
    };
  }, [sessionId, applyEditorContent]);

  // ─── Local draft autosave ─────────────────────────────────────────────────
  // The socket only persists snapshots every few seconds, so a network cut can
  // lose whatever was typed since the last successful snapshot. We mirror the
  // full workspace to localStorage continuously; on reload we restore from it
  // when it's fresher than what the server has. This survives a dropped
  // connection, a closed tab, or a browser crash.
  const submittedRef = useRef(false);
  useEffect(() => { submittedRef.current = !!submittedAt; }, [submittedAt]);

  const draftKey = sessionId && user ? `oreos_draft_${sessionId}_${user.id}` : null;
  const draftKeyRef = useRef(draftKey);
  useEffect(() => { draftKeyRef.current = draftKey; }, [draftKey]);
  const lastDraftRef = useRef(0);

  const saveDraft = useCallback((force = false) => {
    const key = draftKeyRef.current;
    if (!key || submittedRef.current) return;
    const now = Date.now();
    if (!force && now - lastDraftRef.current < 1000) return;
    lastDraftRef.current = now;
    try {
      localStorage.setItem(key, JSON.stringify({
        content: codeRef.current,
        language: languageRef.current,
        ts: now,
      }));
    } catch {
      // storage full or disabled — nothing else we can do
    }
  }, []);

  const clearDraft = useCallback(() => {
    const key = draftKeyRef.current;
    if (!key) return;
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }, []);

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
    saveDraft();
  }, [sessionId, language, saveDraft]);

  const emitFlag = useCallback((type: string, detail?: string) => {
    if (!sessionId) return;
    socketRef.current.emit('student:flag', { sessionId, type, detail });
    setFlagCount(f => f + 1);
  }, [sessionId]);

  // Monaco's listeners are bound exactly once at mount, so they would otherwise
  // hold stale closures of `language`, `emitEvent`, and `emitFlag`. We mirror
  // those into refs and read the refs from inside the listeners.
  const languageRef = useRef(language);
  const emitEventRef = useRef(emitEvent);
  const emitFlagRef = useRef(emitFlag);
  useEffect(() => { languageRef.current = language; }, [language]);
  useEffect(() => { emitEventRef.current = emitEvent; }, [emitEvent]);
  useEffect(() => { emitFlagRef.current = emitFlag; }, [emitFlag]);

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
      // Read state through refs — this callback is bound only once.
      if (languageRef.current === 'java' && javaWorkspaceRef.current) {
        persistActiveJavaFile(code);
      } else if (languageRef.current !== 'java') {
        // Only clear the java workspace ref when we're NOT in a java session.
        // Calling syncCodeRef(code, null) while on Java would null the workspace
        // ref mid-flight (e.g. immediately after a file switch) and break the
        // next file-tab click.
        syncCodeRef(code, null);
      }

      // Mark "student has started writing" only on real edits — `isFlush` is
      // true for programmatic setValue calls (initial load, language switch,
      // file switch, new-file creation), which shouldn't count.
      if (!e.isFlush && !hasStartedTypingRef.current) {
        hasStartedTypingRef.current = true;
        // From this moment on, idle is measured from the first real keystroke,
        // not from a stale lastSent that was bumped by setValue.
        lastSentRef.current = Date.now();
      }

      for (const change of e.changes) {
        emitEventRef.current('change', { text: change.text, rangeLength: change.rangeLength });
      }
    });

    // Log cursor movement
    editor.onDidChangeCursorPosition((e) => {
      emitEventRef.current('cursor', { line: e.position.lineNumber, col: e.position.column });
    });

    // NOTE: paste detection lives entirely in the document `paste` handler
    // (`handlePaste`), which is the only place that can see the pasted text and
    // tell self-paste (rearranging your own code — not flagged) from an external
    // paste (flagged). We intentionally do NOT flag Ctrl/Cmd+V here, because a
    // keydown can't tell the two apart and would flag the student for pasting
    // their own code.
  };

  // ─── Flush the local draft when the tab is hidden or closed ─────────────────
  // pagehide/visibilitychange are the last reliable moments before the page goes
  // away (refresh, close, crash-on-navigate), so we force a final save there.
  useEffect(() => {
    const flush = () => saveDraft(true);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
    };
  }, [saveDraft]);

  // ─── Copy tracking — record what the student copies from within the page ────
  useEffect(() => {
    const handleCopy = (e: ClipboardEvent) => {
      const copied = e.clipboardData?.getData('text') ?? window.getSelection()?.toString() ?? '';
      if (copied) ownClipboardRef.current = copied;
    };
    // Also intercept cut so moving code around doesn't flag either
    const handleCut = (e: ClipboardEvent) => {
      const cut = e.clipboardData?.getData('text') ?? window.getSelection()?.toString() ?? '';
      if (cut) ownClipboardRef.current = cut;
    };
    document.addEventListener('copy', handleCopy, true);
    document.addEventListener('cut', handleCut, true);
    return () => {
      document.removeEventListener('copy', handleCopy, true);
      document.removeEventListener('cut', handleCut, true);
    };
  }, []);

  // ─── Paste interception ───────────────────────────────────────────────────
  // Always allowed. Only flagged when the pasted text is NOT something the
  // student already copied from within this same session. This prevents
  // "moved my own code" from drowning out real integrity events.
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const pastedText = e.clipboardData?.getData('text') ?? '';
      if (!pastedText) return;

      // Always record the event on the timeline
      emitEvent('paste', { length: pastedText.length });

      const isSelfPaste = pastedText === ownClipboardRef.current;

      if (isSelfPaste) {
        // Student is rearranging their own code — log it but don't flag
        return;
      }

      // Anything pasted from outside this session is flagged, regardless of length
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

  // ─── Window blur monitoring ───────────────────────────────────────────────────
  // Recorded on the timeline for replay context but NOT counted as a flag.
  // visibilitychange already flags the tab switch; blur is a duplicate signal
  // from the same action and was causing one switch to show as 2-3 flags.
  useEffect(() => {
    const handleBlur = () => {
      emitEvent('window_blur', {});
    };
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, [emitEvent]);

  // ─── Heartbeat + idle tracking ───────────────────────────────────────────────
  // Idle is only meaningful AFTER the student has actually started writing.
  // Thinking time before the first keystroke (reading the brief, planning) is
  // not a red flag, so we don't surface it as one.
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const idleSecs = Math.round((now - lastSentRef.current) / 1000);
      if (
        hasStartedTypingRef.current &&
        idleSecs > 30 &&
        !idleFlaggedRef.current
      ) {
        idleFlaggedRef.current = true;
        emitFlag('idle', `Idle for ${idleSecs}s`);
      }
      emitEvent('heartbeat', {
        idleSecs,
        started: hasStartedTypingRef.current,
      });
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
      // Compile errors are part of writing code, not suspicious behaviour.
      // Record them on the timeline (lecturer sees them in replay) but don't
      // count them as integrity flags.
      emitEvent('compile_error', { language, message: message.slice(0, 500) });
    } finally {
      setCompiling(false);
    }
  }, [language, compiling, emitEvent]);

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
      // Same reasoning as compile_error: log it but don't raise a flag.
      emitEvent('run_error', { language, message: message.slice(0, 500) });
    } finally {
      setRunning(false);
    }
  }, [language, running, stdinText, emitEvent]);

  const syncEditorIntoRef = useCallback(() => {
    if (!editorRef.current) return;
    if (language === 'java') {
      persistActiveJavaFile(editorRef.current.getValue());
    } else {
      syncCodeRef(editorRef.current.getValue(), null);
    }
  }, [language, persistActiveJavaFile, syncCodeRef]);

  const openSubmitModal = useCallback(() => {
    if (submitting || submittedAt) return;
    if (status === 'ended') {
      toast.error('Session has ended', 'You can no longer submit work.');
      return;
    }
    syncEditorIntoRef();
    if (!codeRef.current.trim()) {
      toast.error('Nothing to submit', 'Write some code first, then try again.');
      return;
    }
    setSubmitError(null);
    setShowSubmitModal(true);
  }, [submitting, submittedAt, status, syncEditorIntoRef]);

  const confirmSubmit = useCallback(async () => {
    if (!sessionId || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.submitWork(sessionId, {
        content: codeRef.current,
        language,
      });
      submittedRef.current = true;
      clearDraft();
      setSubmittedAt(result.submittedAt);
      setShowSubmitModal(false);
      setShowSubmittedSuccess(true);
      emitEvent('submitted', { language });
      toast.success('Submitted', `Your work was recorded at ${new Date(result.submittedAt).toLocaleTimeString()}.`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Submission failed';
      setSubmitError(message);
      toast.error('Submit failed', message);
    } finally {
      setSubmitting(false);
    }
  }, [sessionId, submitting, language, emitEvent, clearDraft]);

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.updateOptions({ readOnly: !!submittedAt });
    }
  }, [submittedAt]);

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

  // ─── App-level shortcuts: ⌘↵ run, ⌘⇧↵ submit ───────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          openSubmitModal();
        } else if (['java', 'python', 'cpp'].includes(language)) {
          handleRun();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [language, handleRun, openSubmitModal]);

  const previewCode = useMemo(() => {
    // For Java, codeRef holds the serialized JSON workspace — useless to show
    // raw. Render it as readable source with file separators instead, and
    // measure lines/chars against the readable form (which is what the
    // student actually thinks of as "their code").
    let text = codeRef.current || '';
    if (language === 'java' && javaWorkspaceRef.current) {
      const ws = javaWorkspaceRef.current;
      const names = Object.keys(ws.files).sort();
      // Make sure the active file reflects whatever is currently in the editor,
      // not the last persisted value, when the modal opens.
      const liveActive = editorRef.current?.getValue() ?? ws.files[ws.active];
      text = names
        .map((name) => {
          const body = name === ws.active ? liveActive : ws.files[name];
          return `// ── ${name} ──\n${body}`;
        })
        .join('\n\n');
    }
    const trimmed = text.length > 2000 ? text.slice(0, 2000) + '\n…' : text;
    const lines = text.split('\n').length;
    const chars = text.length;
    return { text: trimmed, lines, chars };
  }, [showSubmitModal, language]); // recompute when modal opens

  const newFileValidation = useMemo(() => {
    const trimmed = newFileName.trim().replace(/\.java$/i, '');
    if (!trimmed) return { state: 'empty' as const };
    if (!JAVA_CLASS_NAME.test(trimmed)) {
      return { state: 'invalid' as const, message: 'Use letters, digits, _ or $. Don\'t start with a digit.' };
    }
    const fileName = `${trimmed}.java`;
    if (javaWorkspace && fileName in javaWorkspace.files) {
      return { state: 'invalid' as const, message: `${fileName} already exists.` };
    }
    return { state: 'valid' as const, fileName };
  }, [newFileName, javaWorkspace]);

  const langLabel = LANG_LABEL[language] ?? language;
  const flagSummary = tabSwitches + pasteCount + flagCount;
  const monitorTone =
    flagCount > 0 ? 'danger' : pasteCount + tabSwitches > 0 ? 'warning' : 'calm';

  if (sessionEnded && !showSubmittedSuccess) {
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

  const compileEligible = ['java', 'python', 'cpp'].includes(language);
  const actionLockReason = submittedAt ? 'Already submitted' : status === 'ended' ? 'Session ended' : null;

  return (
    <div className={styles.page}>
      {!connected && (
        <div className={styles.offlineBanner}>
          <span className={styles.offlineDot} />
          <span>
            Connection lost — you’re offline. Your work is being saved on this device.
            Keep this tab open; it will sync automatically when you’re back online.
          </span>
        </div>
      )}

      {fullscreenWarning && (
        <div className={styles.warning}>
          <span>⚠ Tab switch detected — flagged for your lecturer.</span>
          <button type="button" onClick={() => setFullscreenWarning(false)}>Dismiss</button>
        </div>
      )}

      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.brand}>
            <span className={styles.logoMark} aria-hidden>⬡</span>
            <span className={styles.logoText}>Oreos</span>
          </div>
          <div className={styles.sessionMeta}>
            <span className={styles.sessionName}>{session?.name ?? 'Session'}</span>
            <span className={styles.sessionSub}>
              <span className={`${styles.statusDot} ${status === 'active' ? styles.statusDotActive : styles.statusDotWait}`} />
              {status === 'active' ? 'Live' : status === 'ended' ? 'Ended' : 'Waiting to start'}
              <span className={styles.dotSep}>·</span>
              {langLabel}
            </span>
          </div>
        </div>

        <div className={styles.headerRight}>
          <span
            className={`${styles.activity} ${styles[`activity_${monitorTone}`]}`}
            title={`${tabSwitches} tab switch${tabSwitches === 1 ? '' : 'es'} · ${pasteCount} paste${pasteCount === 1 ? '' : 's'} · ${flagCount} other flag${flagCount === 1 ? '' : 's'}`}
          >
            <span className={styles.activityPulse} aria-hidden />
            {flagSummary === 0 ? 'Activity tracked' : `${flagSummary} flag${flagSummary === 1 ? '' : 's'}`}
          </span>

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
            disabled={!!constraints.language || !!submittedAt}
            aria-label="Language"
          >
            <option value="javascript">JavaScript</option>
            <option value="python">Python</option>
            <option value="typescript">TypeScript</option>
            <option value="java">Java</option>
            <option value="cpp">C++</option>
            <option value="c">C</option>
          </select>

          <div className={styles.headerDivider} />

          {compileEligible && (
            <>
              <button
                className={`btn btn-ghost ${styles.runBtn}`}
                onClick={handleCompile}
                disabled={compiling || running || !!submittedAt}
              >
                {compiling ? 'Compiling…' : 'Compile'}
              </button>
              <button
                className={`btn btn-primary ${styles.runBtn}`}
                onClick={handleRun}
                disabled={running || compiling || !!submittedAt}
                title={`Run · ${modKey} ↵`}
              >
                {running ? 'Running…' : '▶ Run'}
              </button>
            </>
          )}

          <button
            className={`btn ${submittedAt ? 'btn-ghost' : 'btn-success'} ${styles.submitBtn}`}
            onClick={openSubmitModal}
            disabled={submitting || !!submittedAt || status === 'ended'}
            title={actionLockReason ?? `Submit · ${modKey} ⇧ ↵`}
          >
            {submittedAt ? '✓ Submitted' : submitting ? 'Submitting…' : 'Submit work'}
          </button>
        </div>
      </header>

      {status === 'waiting' && !submittedAt && (
        <div className={styles.waitingBanner}>
          <span className={styles.waitingDot} />
          Your lecturer hasn't started the session yet. You can warm up — anything you type is recorded once it starts.
        </div>
      )}

      <div className={styles.workspace}>
        {questions.length > 0 && (
          <aside className={styles.questionsPanel}>
            <div className={styles.panelKicker}>Brief</div>
            {questions.map((q, i) => (
              <div key={i} className={styles.questionItem}>
                <span className={styles.questionNum}>Question {i + 1}</span>
                <p className={styles.questionText}>{q}</p>
              </div>
            ))}
          </aside>
        )}
        {language === 'java' && javaWorkspace && (
          <aside className={styles.filesPanel}>
            <div className={styles.filesHeader}>
              <span className={styles.panelKicker}>Java files</span>
              <button
                type="button"
                className={styles.filesAdd}
                onClick={openAddJavaFile}
                disabled={!!submittedAt}
                title={submittedAt ? 'Cannot add files after submitting' : 'New Java file'}
              >
                + New
              </button>
            </div>
            <div className={styles.filesList}>
              {Object.keys(javaWorkspace.files).sort().map((fileName) => (
                <div
                  key={fileName}
                  className={`${styles.fileTab} ${fileName === javaWorkspace.active ? styles.fileTabActive : ''}`}
                >
                  <button type="button" className={styles.fileTabBtn} onClick={() => switchJavaFile(fileName)}>
                    <span className={styles.fileTabIcon} aria-hidden>{'{}'}</span>
                    {fileName}
                  </button>
                  {Object.keys(javaWorkspace.files).length > 1 && !submittedAt && (
                    <button
                      type="button"
                      className={styles.fileRemove}
                      onClick={() => removeJavaFile(fileName)}
                      title={`Remove ${fileName}`}
                      aria-label={`Remove ${fileName}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
            <p className={styles.filesHint}>
              Helper classes live here. Your <code>main</code> stays in <code>Main.java</code>.
            </p>
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
              padding: { top: 16, bottom: 16 },
              fontLigatures: true,
            }}
          />
        </div>
      </div>

      {compileEligible && showPanel && (
        <div className={styles.bottomPanel}>
          <div className={styles.panelHeader}>
            <span className={styles.panelTitle}>
              <span className={styles.terminalDot} />
              Terminal · {langLabel}
            </span>
            <button
              className={styles.panelClose}
              onClick={() => setShowPanel(false)}
              aria-label="Close terminal"
            >
              ×
            </button>
          </div>
          <div className={styles.panelBody}>
            <div className={styles.stdinWrap}>
              <label className={styles.stdinLabel}>Standard input</label>
              <textarea
                value={stdinText}
                onChange={(e) => setStdinText(e.target.value)}
                placeholder={'5\n1 2 3 4 5'}
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
        <span className={styles.footerLeft}>
          <span className={styles.footerDot} /> Synced live
        </span>
        <span className={styles.footerRight}>
          <span>{user?.name}</span>
          <span className={styles.footerHotkey}>
            <Kbd>{modKey}</Kbd> <Kbd>↵</Kbd> run · <Kbd>{modKey}</Kbd> <Kbd>⇧</Kbd> <Kbd>↵</Kbd> submit
          </span>
        </span>
      </footer>

      {/* ─── Submit confirmation modal ─────────────────────────────────────── */}
      <Modal
        open={showSubmitModal}
        onClose={() => !submitting && setShowSubmitModal(false)}
        title="Submit your work?"
        subtitle="This is final. Your lecturer will be notified and the editor will lock."
        size="md"
        closeOnBackdrop={!submitting}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setShowSubmitModal(false)} disabled={submitting}>
              Keep editing
            </button>
            <button type="button" className="btn btn-success" onClick={confirmSubmit} disabled={submitting}>
              {submitting ? 'Submitting…' : 'Confirm submit'}
            </button>
          </>
        }
      >
        <div className={styles.submitSummary}>
          <div className={styles.submitStat}>
            <span className={styles.submitStatLabel}>Language</span>
            <span className={styles.submitStatValue}>{langLabel}</span>
          </div>
          <div className={styles.submitStat}>
            <span className={styles.submitStatLabel}>Lines</span>
            <span className={styles.submitStatValue}>{previewCode.lines}</span>
          </div>
          <div className={styles.submitStat}>
            <span className={styles.submitStatLabel}>Characters</span>
            <span className={styles.submitStatValue}>{previewCode.chars.toLocaleString()}</span>
          </div>
        </div>
        <pre className={styles.submitPreview}>{previewCode.text || '(empty)'}</pre>
        {submitError && <div className={styles.submitInlineError}>⚠ {submitError}</div>}
      </Modal>

      {/* ─── Add Java file modal ───────────────────────────────────────────── */}
      <Modal
        open={showAddFileModal}
        onClose={() => setShowAddFileModal(false)}
        title="New Java file"
        subtitle="One class per file. We'll add the .java extension for you."
        size="sm"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setShowAddFileModal(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={newFileValidation.state !== 'valid'}
              onClick={() => {
                const result = commitAddJavaFile(newFileName);
                if (result.ok) {
                  setShowAddFileModal(false);
                  toast.success('File created', `${newFileName.trim().replace(/\.java$/i, '')}.java is now active.`);
                } else {
                  toast.error('Couldn\'t create file', result.reason);
                }
              }}
            >
              Create file
            </button>
          </>
        }
      >
        <input
          className={styles.fileNameInput}
          value={newFileName}
          onChange={(e) => setNewFileName(e.target.value)}
          placeholder="e.g. Node, BinaryTree, Solver"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newFileValidation.state === 'valid') {
              e.preventDefault();
              const result = commitAddJavaFile(newFileName);
              if (result.ok) {
                setShowAddFileModal(false);
                toast.success('File created', `${newFileName.trim().replace(/\.java$/i, '')}.java is now active.`);
              }
            }
          }}
          autoComplete="off"
          spellCheck={false}
        />
        <div className={styles.fileNameHint}>
          {newFileValidation.state === 'empty' && <span className={styles.hintNeutral}>Pick a class name. PascalCase by convention.</span>}
          {newFileValidation.state === 'invalid' && <span className={styles.hintError}>⚠ {newFileValidation.message}</span>}
          {newFileValidation.state === 'valid' && (
            <span className={styles.hintOk}>✓ Will create <code>{newFileValidation.fileName}</code></span>
          )}
        </div>
      </Modal>

      {/* ─── Submission success overlay ────────────────────────────────────── */}
      {showSubmittedSuccess && submittedAt && (
        <div className={styles.overlay}>
          <div className={styles.successCard}>
            <div className={styles.successIcon}>✓</div>
            <h2 className={styles.successTitle}>Submitted</h2>
            <p className={styles.successText}>
              We recorded your work at <strong>{new Date(submittedAt).toLocaleTimeString()}</strong>.<br />
              Your lecturer will review it. You can close this tab safely.
            </p>
            <div className={styles.successStats}>
              <span>{langLabel}</span>
              <span className={styles.dotSep}>·</span>
              <span>{previewCode.lines} {previewCode.lines === 1 ? 'line' : 'lines'}</span>
              <span className={styles.dotSep}>·</span>
              <span>{previewCode.chars.toLocaleString()} {previewCode.chars === 1 ? 'char' : 'chars'}</span>
            </div>
            <div className={styles.successActions}>
              <button className="btn btn-ghost" onClick={() => setShowSubmittedSuccess(false)}>
                Review submission
              </button>
              <button className="btn btn-primary" onClick={() => navigate('/student')}>
                Back to lobby
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
