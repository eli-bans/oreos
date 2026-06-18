import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import JSZip from 'jszip';
import { api, Flag, Participant, Session, Submission } from '@/lib/api';
import { formatJavaWorkspaceForDisplay, parseJavaWorkspace } from '@/lib/javaWorkspace';
import { getSocket } from '@/lib/socket';
import { questionsFromText, questionsToText } from '@/lib/questions';
import { toast } from '@/components/Toaster';
import styles from './LecturerSession.module.css';

interface LiveStudent extends Participant {
  online: boolean;
  code: string;
  language: string;
}

type StudentFilter = 'all' | 'online' | 'submitted' | 'flagged';

const LANG_LABEL: Record<string, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  java: 'Java',
  cpp: 'C++',
  c: 'C',
};

function relTime(ts?: number) {
  if (!ts) return '';
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

export default function LecturerSession() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [students, setStudents] = useState<Map<string, LiveStudent>>(new Map());
  // Authoritative final copies from the submissions table, keyed by student id.
  // These survive a network cut that may have left the live snapshots stale, so
  // they take precedence over `student.code` (which is the throttled snapshot).
  const [submissions, setSubmissions] = useState<Map<string, Submission>>(new Map());
  const [flags, setFlags] = useState<Flag[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const [tab, setTab] = useState<'students' | 'flags' | 'questions'>('students');
  const [filter, setFilter] = useState<StudentFilter>('all');
  const [search, setSearch] = useState('');
  const [questionsText, setQuestionsText] = useState('');
  const [questionsSaving, setQuestionsSaving] = useState(false);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const socketRef = useRef(getSocket());

  useEffect(() => {
    if (!id) return;
    api.getSession(id).then(s => {
      setSession(s);
      setQuestionsText(questionsToText(s.questions ?? []));
    }).catch(() => navigate('/lecturer'));
    api.getParticipants(id).then(list => {
      setStudents(new Map(list.map(p => [p.id, {
        ...p,
        online: false,
        code: p.latest_code ?? '',
        language: p.language ?? 'javascript',
        submitted_at: p.submitted_at,
      }])));
    });
    api.getFlags(id).then(setFlags);
    api.getSubmissions(id).then(list => {
      setSubmissions(new Map(list.map(s => [s.student_id, s])));
    }).catch(() => { /* no submissions yet */ });
  }, [id, navigate]);

  useEffect(() => {
    if (!id) return;
    const socket = socketRef.current;
    socket.emit('lecturer:watch', { sessionId: id });

    socket.on('session:participants', (list: LiveStudent[]) => {
      setStudents(new Map(list.map(p => [p.id, { ...p, online: true }])));
    });

    socket.on('student:joined', (data: { studentId: string; name: string; email: string }) => {
      setStudents(prev => {
        const m = new Map(prev);
        const existing = m.get(data.studentId);
        m.set(data.studentId, {
          ...existing,
          id: data.studentId,
          name: data.name,
          email: data.email,
          online: true,
          code: existing?.code ?? '',
          language: existing?.language ?? 'javascript',
          joined_at: existing?.joined_at ?? Math.floor(Date.now() / 1000),
          flag_count: existing?.flag_count ?? 0,
        });
        return m;
      });
      toast.info('Student joined', data.name);
    });

    socket.on('student:left', ({ studentId }: { studentId: string }) => {
      setStudents(prev => {
        const m = new Map(prev);
        const s = m.get(studentId);
        if (s) m.set(studentId, { ...s, online: false });
        return m;
      });
    });

    socket.on('student:code_update', ({ studentId, code, language }: { studentId: string; code: string; language: string }) => {
      setStudents(prev => {
        const m = new Map(prev);
        const s = m.get(studentId);
        if (s) m.set(studentId, { ...s, code, language });
        return m;
      });
    });

    socket.on('student:flagged', (flag: Flag & { name: string }) => {
      setFlags(prev => [{ ...flag, student_name: flag.name }, ...prev]);
      setStudents(prev => {
        const m = new Map(prev);
        const s = m.get(flag.student_id);
        if (s) m.set(flag.student_id, { ...s, flag_count: (s.flag_count ?? 0) + 1 });
        return m;
      });
    });

    socket.on('session:status_changed', ({ status }: { status: string }) => {
      setSession(prev => prev ? { ...prev, status: status as Session['status'] } : prev);
    });

    socket.on('student:submitted', ({ studentId, name, ts }: { studentId: string; name: string; ts: number }) => {
      setStudents(prev => {
        const m = new Map(prev);
        const s = m.get(studentId);
        if (s) m.set(studentId, { ...s, submitted_at: ts });
        return m;
      });
      // Pull the authoritative submission content so the focused view and the
      // Download button reflect exactly what was submitted, not the snapshot.
      api.getSubmissions(id).then(list => {
        setSubmissions(new Map(list.map(s => [s.student_id, s])));
      }).catch(() => { /* ignore */ });
      toast.success(`${name} submitted`, new Date(ts).toLocaleTimeString());
    });

    socket.on('session:questions_updated', (questions: string[]) => {
      setSession(prev => prev ? { ...prev, questions } : prev);
      setQuestionsText(questionsToText(questions));
    });

    return () => {
      socket.off('session:participants');
      socket.off('student:joined');
      socket.off('student:left');
      socket.off('student:code_update');
      socket.off('student:flagged');
      socket.off('session:status_changed');
      socket.off('session:questions_updated');
      socket.off('student:submitted');
    };
  }, [id]);

  const setStatus = (status: 'active' | 'ended' | 'waiting') => {
    socketRef.current.emit('lecturer:set_status', { sessionId: id, status });
    if (status === 'active') toast.success('Session started', 'Students can now write code that is recorded.');
    if (status === 'ended') toast.info('Session ended', 'All submissions are final.');
  };

  const updateLanguage = (lang: string) => {
    const updated = { ...session!.constraints, language: lang };
    socketRef.current.emit('lecturer:update_constraints', { sessionId: id, constraints: updated });
    setSession(prev => prev ? { ...prev, constraints: updated } : prev);
  };

  const publishQuestions = async () => {
    if (!id || session?.status === 'ended') return;
    const questions = questionsFromText(questionsText);
    setQuestionsSaving(true);
    try {
      socketRef.current.emit('lecturer:update_questions', { sessionId: id, questions });
      const updated = await api.updateSession(id, { questions });
      setSession(updated);
      setQuestionsText(questionsToText(updated.questions ?? []));
      toast.success('Questions published', `${questions.length} visible to students.`);
    } catch (err: unknown) {
      toast.error('Could not publish', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setQuestionsSaving(false);
    }
  };

  const copyJoinCode = async () => {
    if (!session?.join_code) return;
    try {
      await navigator.clipboard.writeText(session.join_code);
      toast.success('Join code copied', session.join_code);
    } catch {
      toast.error('Copy failed', 'Select the code and copy manually.');
    }
  };

  const triggerDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadSubmission = async (student: LiveStudent) => {
    const slug = student.name.trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '') || 'student';
    const code = codeFor(student);
    const lang = langFor(student) || 'txt';
    const extByLang: Record<string, string> = {
      java: 'java', python: 'py', javascript: 'js', typescript: 'ts', cpp: 'cpp', c: 'c',
    };

    // Java workspace → real .zip with each file at its real name
    if (lang === 'java') {
      const ws = parseJavaWorkspace(code || '');
      const names = ws ? Object.keys(ws.files) : [];
      if (ws && names.length > 1) {
        const zip = new JSZip();
        const folder = zip.folder(`${slug}_submission`);
        if (!folder) return;
        for (const [name, source] of Object.entries(ws.files)) {
          folder.file(name, source);
        }
        // Include a small manifest so the grader knows which class has main()
        folder.file('SUBMISSION.txt',
          `Student: ${student.name} <${student.email}>\n` +
          `Language: Java\n` +
          `Submitted: ${student.submitted_at ? new Date(student.submitted_at).toISOString() : '(in progress)'}\n` +
          `Active file at submission: ${ws.active}\n` +
          `Files: ${names.join(', ')}\n`
        );
        const blob = await zip.generateAsync({ type: 'blob' });
        triggerDownload(blob, `${slug}_submission.zip`);
        toast.success('Downloaded', `${names.length} files in ${slug}_submission.zip`);
        return;
      }
      // Single-file Java (or unparsable) — write a plain Main.java
      const single = ws && names.length === 1 ? ws.files[names[0]] : (code || '');
      const fname = ws && names.length === 1 ? names[0] : 'Main.java';
      triggerDownload(new Blob([single], { type: 'text/x-java-source' }), `${slug}_${fname}`);
      toast.success('Downloaded', `${slug}_${fname}`);
      return;
    }

    // Non-Java: single source file with appropriate extension
    const ext = extByLang[lang] ?? 'txt';
    triggerDownload(
      new Blob([code || ''], { type: 'text/plain' }),
      `${slug}_submission.${ext}`
    );
    toast.success('Downloaded', `${slug}_submission.${ext}`);
  };

  // The set of files representing one student's submission, named as they should
  // appear inside that student's folder in a bulk zip. Mirrors the per-language
  // logic in downloadSubmission so single and bulk download stay consistent.
  const submissionFiles = (student: LiveStudent): { slug: string; files: { name: string; content: string }[] } => {
    const slug = student.name.trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '') || 'student';
    const code = codeFor(student);
    const lang = langFor(student) || 'txt';
    const extByLang: Record<string, string> = {
      java: 'java', python: 'py', javascript: 'js', typescript: 'ts', cpp: 'cpp', c: 'c',
    };

    if (lang === 'java') {
      const ws = parseJavaWorkspace(code || '');
      const names = ws ? Object.keys(ws.files) : [];
      if (ws && names.length >= 1) {
        const files = Object.entries(ws.files).map(([name, source]) => ({ name, content: source }));
        files.push({
          name: 'SUBMISSION.txt',
          content:
            `Student: ${student.name} <${student.email}>\n` +
            `Language: Java\n` +
            `Submitted: ${student.submitted_at ? new Date(student.submitted_at).toISOString() : '(in progress)'}\n` +
            `Active file at submission: ${ws.active}\n` +
            `Files: ${names.join(', ')}\n`,
        });
        return { slug, files };
      }
      return { slug, files: [{ name: 'Main.java', content: code || '' }] };
    }

    const ext = extByLang[lang] ?? 'txt';
    return { slug, files: [{ name: `submission.${ext}`, content: code || '' }] };
  };

  // Bundle every student matching the current filter into one zip, each in their
  // own `{name}_submission/` folder. Honors the sidebar filter (e.g. "Submitted")
  // so the lecturer controls who gets exported.
  const downloadAll = async () => {
    const targets = filteredStudents;
    if (targets.length === 0) {
      toast.info('Nothing to download', 'No students match the current filter.');
      return;
    }
    const zip = new JSZip();
    const usedSlugs = new Map<string, number>();
    for (const student of targets) {
      const { slug, files } = submissionFiles(student);
      // Disambiguate folders if two students slugify to the same name.
      const seen = usedSlugs.get(slug) ?? 0;
      usedSlugs.set(slug, seen + 1);
      const folderName = seen === 0 ? `${slug}_submission` : `${slug}_${seen + 1}_submission`;
      const folder = zip.folder(folderName);
      if (!folder) continue;
      for (const f of files) folder.file(f.name, f.content);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const sessionSlug = session?.name?.trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '') || 'session';
    triggerDownload(blob, `${sessionSlug}_submissions.zip`);
    toast.success('Downloaded', `${targets.length} submission${targets.length === 1 ? '' : 's'} in ${sessionSlug}_submissions.zip`);
  };

  // For a submitted student, the submissions row is the source of truth; fall
  // back to the live snapshot (`student.code`) only while they're still working.
  const codeFor = (s: LiveStudent) => submissions.get(s.id)?.content ?? s.code;
  const langFor = (s: LiveStudent) => submissions.get(s.id)?.language ?? s.language;

  const focusedStudent = focused ? students.get(focused) : null;
  const studentList = useMemo(() => Array.from(students.values()), [students]);

  // Parse the focused student's Java workspace (if any) so we can render
  // file tabs instead of one concatenated dump.
  const focusedJava = useMemo(() => {
    if (!focusedStudent || langFor(focusedStudent) !== 'java') return null;
    const ws = parseJavaWorkspace(codeFor(focusedStudent) || '');
    return ws;
  }, [focusedStudent, submissions]);

  // Reset active file when switching students or when files appear/disappear.
  useEffect(() => {
    if (!focusedJava) { setActiveFile(null); return; }
    const names = Object.keys(focusedJava.files);
    if (activeFile && names.includes(activeFile)) return;
    setActiveFile(names.includes('Main.java') ? 'Main.java' : names.sort()[0] ?? null);
  }, [focusedJava, activeFile]);

  const stats = useMemo(() => {
    let online = 0;
    let submitted = 0;
    let flagged = 0;
    for (const s of studentList) {
      if (s.online) online += 1;
      if (s.submitted_at) submitted += 1;
      if ((s.flag_count ?? 0) > 0) flagged += 1;
    }
    return { online, submitted, flagged, total: studentList.length };
  }, [studentList]);

  const filteredStudents = useMemo(() => {
    const q = search.trim().toLowerCase();
    return studentList.filter(s => {
      if (filter === 'online' && !s.online) return false;
      if (filter === 'submitted' && !s.submitted_at) return false;
      if (filter === 'flagged' && (s.flag_count ?? 0) === 0) return false;
      if (q && !s.name.toLowerCase().includes(q) && !s.email.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [studentList, filter, search]);

  if (!session) return <div className={styles.loading}>Loading…</div>;

  const statusKind =
    session.status === 'active' ? 'badge-green'
    : session.status === 'ended' ? 'badge-gray'
    : 'badge-yellow';

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button className={styles.backBtn} onClick={() => navigate('/lecturer')} aria-label="Back to lecturer home">
          ← <span>Sessions</span>
        </button>

        <div className={styles.headerCenter}>
          <div className={styles.titleRow}>
            <h1 className={styles.sessionName}>{session.name}</h1>
            <span className={`badge ${statusKind}`}>{session.status}</span>
          </div>
          <button className={styles.joinCodeChip} onClick={copyJoinCode} title="Click to copy">
            <span className={styles.joinLabel}>Join code</span>
            <span className={styles.joinCode}>{session.join_code}</span>
            <span className={styles.copyIcon} aria-hidden>⧉</span>
          </button>
        </div>

        <div className={styles.headerActions}>
          {stats.total > 0 && (
            <button
              className="btn btn-ghost"
              onClick={downloadAll}
              title="Download all listed submissions as a .zip (one folder per student)"
            >
              ⬇ Download all
            </button>
          )}
          {session.status !== 'ended' && (
            <select
              value={session.constraints.language ?? 'javascript'}
              onChange={e => updateLanguage(e.target.value)}
              className={styles.langSelect}
              aria-label="Language constraint"
            >
              <option value="javascript">JavaScript</option>
              <option value="python">Python</option>
              <option value="typescript">TypeScript</option>
              <option value="java">Java</option>
              <option value="cpp">C++</option>
              <option value="c">C</option>
            </select>
          )}
          {session.status === 'waiting' && (
            <button className="btn btn-success" onClick={() => setStatus('active')}>▶ Start session</button>
          )}
          {session.status === 'active' && (
            <button className="btn btn-danger" onClick={() => setStatus('ended')}>■ End session</button>
          )}
        </div>
      </header>

      <div className={styles.statBar}>
        <div className={styles.statItem}>
          <span className={styles.statLabel}>Joined</span>
          <span className={styles.statValue}>{stats.total}</span>
        </div>
        <div className={styles.statDivider} />
        <div className={styles.statItem}>
          <span className={styles.statLabel}>
            <span className={`${styles.statDot} ${styles.statDotGreen}`} />
            Online
          </span>
          <span className={styles.statValue}>{stats.online}</span>
        </div>
        <div className={styles.statDivider} />
        <div className={styles.statItem}>
          <span className={styles.statLabel}>Submitted</span>
          <span className={styles.statValue}>
            {stats.submitted}<span className={styles.statValueSub}>/{stats.total}</span>
          </span>
        </div>
        <div className={styles.statDivider} />
        <div className={styles.statItem}>
          <span className={styles.statLabel}>
            <span className={`${styles.statDot} ${stats.flagged > 0 ? styles.statDotRed : styles.statDotMuted}`} />
            Flagged
          </span>
          <span className={styles.statValue}>{stats.flagged}</span>
        </div>
      </div>

      <div className={styles.body}>
        <aside className={styles.sidebar}>
          <div className={styles.sideTabs}>
            <button
              className={`${styles.sideTab} ${tab === 'students' ? styles.sideTabActive : ''}`}
              onClick={() => setTab('students')}
            >
              Students <span className={styles.count}>{stats.total}</span>
            </button>
            <button
              className={`${styles.sideTab} ${tab === 'flags' ? styles.sideTabActive : ''}`}
              onClick={() => setTab('flags')}
            >
              Flags
              {flags.length > 0 && <span className={`${styles.count} ${styles.flagCount}`}>{flags.length}</span>}
            </button>
            <button
              className={`${styles.sideTab} ${tab === 'questions' ? styles.sideTabActive : ''}`}
              onClick={() => setTab('questions')}
            >
              Brief
            </button>
          </div>

          {tab === 'students' && (
            <>
              <div className={styles.searchRow}>
                <span className={styles.searchIcon} aria-hidden>⌕</span>
                <input
                  type="text"
                  className={styles.searchInput}
                  placeholder="Search by name or email"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  aria-label="Search students"
                />
                {search && (
                  <button
                    type="button"
                    className={styles.searchClear}
                    onClick={() => setSearch('')}
                    aria-label="Clear search"
                  >
                    ×
                  </button>
                )}
              </div>
              <div className={styles.filterRow}>
                {(['all', 'online', 'submitted', 'flagged'] as StudentFilter[]).map(f => {
                  const labels: Record<StudentFilter, string> = {
                    all: 'All', online: 'Online', submitted: 'Submitted', flagged: 'Flagged',
                  };
                  const counts: Record<StudentFilter, number> = {
                    all: stats.total, online: stats.online, submitted: stats.submitted, flagged: stats.flagged,
                  };
                  return (
                    <button
                      key={f}
                      onClick={() => setFilter(f)}
                      className={`${styles.filterChip} ${filter === f ? styles.filterChipActive : ''}`}
                    >
                      {labels[f]} <span className={styles.filterCount}>{counts[f]}</span>
                    </button>
                  );
                })}
              </div>

              <div className={styles.studentList}>
                {filteredStudents.length === 0 && (
                  <p className={styles.empty}>
                    {search.trim()
                      ? `No students match "${search.trim()}"`
                      : filter === 'all' ? 'No students yet' : `No ${filter} students`}
                  </p>
                )}
                {filteredStudents.map(s => (
                  <div
                    key={s.id}
                    className={`${styles.studentItem} ${focused === s.id ? styles.studentFocused : ''}`}
                    onClick={() => setFocused(prev => prev === s.id ? null : s.id)}
                  >
                    <div className={styles.studentRow}>
                      <span
                        className={`${styles.dot} ${s.online ? styles.dotGreen : styles.dotGray}`}
                        title={s.online ? 'Online' : 'Offline'}
                      />
                      <div className={styles.studentMain}>
                        <div className={styles.studentNameRow}>
                          <span className={styles.studentName}>{s.name}</span>
                          {s.submitted_at && <span className={styles.studentTag}>Submitted</span>}
                          {(s.flag_count ?? 0) > 0 && (
                            <span className={`${styles.studentTag} ${styles.studentTagFlag}`}>⚑ {s.flag_count}</span>
                          )}
                        </div>
                        <span className={styles.studentEmail}>{s.email}</span>
                      </div>
                    </div>
                    <div className={styles.studentActions}>
                      <button
                        className={styles.replayBtn}
                        onClick={e => { e.stopPropagation(); navigate(`/lecturer/session/${id}/replay/${s.id}`); }}
                      >
                        ▶ Replay
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'questions' && (
            <div className={styles.questionsPanel}>
              <p className={styles.questionsHelp}>
                Write the brief — students see this in their IDE. Separate multiple questions with a blank line.
              </p>
              <textarea
                value={questionsText}
                onChange={e => setQuestionsText(e.target.value)}
                className={styles.questionsInput}
                rows={12}
                disabled={session.status === 'ended'}
                placeholder={'Implement FizzBuzz.\n\nGiven a sorted array, return the index of the target.'}
              />
              {session.status !== 'ended' && (
                <button
                  className="btn btn-primary"
                  style={{ width: '100%', marginTop: 10 }}
                  onClick={publishQuestions}
                  disabled={questionsSaving}
                >
                  {questionsSaving ? 'Publishing…' : 'Publish to students'}
                </button>
              )}
              {(session.questions?.length ?? 0) > 0 && (
                <p className={styles.questionsPreviewMeta}>
                  <span className={`${styles.statDot} ${styles.statDotGreen}`} />
                  {session.questions.length} question{session.questions.length === 1 ? '' : 's'} live
                </p>
              )}
            </div>
          )}

          {tab === 'flags' && (
            <div className={styles.flagList}>
              {flags.length === 0 && <p className={styles.empty}>No flags yet. Calm seas.</p>}
              {flags.map(f => (
                <div key={f.id} className={styles.flagItem}>
                  <div className={styles.flagTop}>
                    <span className={`badge ${f.type === 'paste' ? 'badge-yellow' : 'badge-red'}`}>{f.type}</span>
                    <span className={styles.flagTime}>{relTime(f.ts)}</span>
                  </div>
                  <span className={styles.flagStudent}>{f.student_name}</span>
                  {f.detail && <span className={styles.flagDetail}>{f.detail}</span>}
                </div>
              ))}
            </div>
          )}
        </aside>

        <main className={styles.main}>
          {focusedStudent ? (
            <div className={styles.liveView}>
              <div className={styles.liveHeader}>
                <button className={styles.liveClose} onClick={() => setFocused(null)} aria-label="Close live view">×</button>
                <div className={styles.liveMeta}>
                  <span className={styles.liveTitle}>{focusedStudent.name}</span>
                  <span className={styles.liveSub}>
                    {LANG_LABEL[langFor(focusedStudent)] ?? langFor(focusedStudent)}
                    {focusedStudent.submitted_at && (
                      <>
                        <span className={styles.dotSep}>·</span>
                        <span className={styles.liveSubGreen}>
                          Submitted {new Date(focusedStudent.submitted_at).toLocaleTimeString()}
                        </span>
                      </>
                    )}
                    {(focusedStudent.flag_count ?? 0) > 0 && (
                      <>
                        <span className={styles.dotSep}>·</span>
                        <span className={styles.liveSubRed}>⚑ {focusedStudent.flag_count} flag{focusedStudent.flag_count === 1 ? '' : 's'}</span>
                      </>
                    )}
                  </span>
                </div>
                <button
                  className="btn btn-ghost"
                  style={{ padding: '6px 12px', fontSize: '12.5px' }}
                  onClick={() => downloadSubmission(focusedStudent)}
                  title={
                    focusedJava && Object.keys(focusedJava.files).length > 1
                      ? `Download as ${Object.keys(focusedJava.files).length}-file .zip`
                      : 'Download submission'
                  }
                >
                  ⬇ Download
                </button>
                <button
                  className="btn btn-ghost"
                  style={{ padding: '6px 12px', fontSize: '12.5px' }}
                  onClick={() => navigate(`/lecturer/session/${id}/replay/${focusedStudent.id}`)}
                >
                  ▶ Replay session
                </button>
              </div>
              {focusedJava && Object.keys(focusedJava.files).length > 0 && (
                <div className={styles.liveFileTabs}>
                  {Object.keys(focusedJava.files).sort().map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setActiveFile(name)}
                      className={`${styles.liveFileTab} ${name === activeFile ? styles.liveFileTabActive : ''}`}
                    >
                      <span className={styles.liveFileTabIcon} aria-hidden>{'{}'}</span>
                      {name}
                    </button>
                  ))}
                </div>
              )}
              <Editor
                height={focusedJava ? 'calc(100% - 56px - 36px)' : 'calc(100% - 56px)'}
                language={langFor(focusedStudent)}
                value={
                  focusedJava && activeFile
                    ? focusedJava.files[activeFile] ?? ''
                    : langFor(focusedStudent) === 'java'
                      ? formatJavaWorkspaceForDisplay(codeFor(focusedStudent))
                      : codeFor(focusedStudent) || '// Student has not written anything yet'
                }
                theme="vs-dark"
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 13,
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  padding: { top: 16, bottom: 16 },
                }}
              />
            </div>
          ) : studentList.length === 0 ? (
            <div className={styles.waitingState}>
              <div className={styles.waitingCard}>
                <div className={styles.waitingKicker}>Share to start</div>
                <div className={styles.joinCodeHuge}>
                  {session.join_code.split('').map((ch, i) => (
                    <span key={i} className={styles.joinChar}>{ch}</span>
                  ))}
                </div>
                <button className={styles.waitingCopy} onClick={copyJoinCode}>Copy code</button>
                <p className={styles.waitingDesc}>
                  Students enter this on the lobby page to join. They appear here the moment they connect.
                </p>
              </div>
            </div>
          ) : (
            <div className={styles.grid}>
              {filteredStudents.map(s => (
                <div
                  key={s.id}
                  className={`${styles.gridCard} ${s.submitted_at ? styles.gridCardSubmitted : ''} ${(s.flag_count ?? 0) > 0 ? styles.gridCardFlagged : ''}`}
                  onClick={() => setFocused(s.id)}
                >
                  <div className={styles.gridHeader}>
                    <span className={`${styles.dot} ${s.online ? styles.dotGreen : styles.dotGray}`} />
                    <span className={styles.gridName}>{s.name}</span>
                    {s.submitted_at && <span className={styles.gridBadgeGreen}>✓</span>}
                    {(s.flag_count ?? 0) > 0 && <span className={styles.gridBadgeRed}>{s.flag_count}</span>}
                  </div>
                  <div className={styles.miniCode}>
                    <pre>
                      {(langFor(s) === 'java' ? formatJavaWorkspaceForDisplay(codeFor(s)) : codeFor(s)) ||
                        '// no code yet'}
                    </pre>
                  </div>
                  <div className={styles.gridFooter}>
                    <span className={styles.gridLang}>{LANG_LABEL[langFor(s)] ?? langFor(s)}</span>
                    <span className={styles.gridOpen}>Open →</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
