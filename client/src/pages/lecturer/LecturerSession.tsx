import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import { api, Flag, Participant, Session } from '@/lib/api';
import { formatJavaWorkspaceForDisplay } from '@/lib/javaWorkspace';
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
  const [flags, setFlags] = useState<Flag[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const [tab, setTab] = useState<'students' | 'flags' | 'questions'>('students');
  const [filter, setFilter] = useState<StudentFilter>('all');
  const [questionsText, setQuestionsText] = useState('');
  const [questionsSaving, setQuestionsSaving] = useState(false);
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

  const focusedStudent = focused ? students.get(focused) : null;
  const studentList = useMemo(() => Array.from(students.values()), [students]);

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
    return studentList.filter(s => {
      if (filter === 'online') return s.online;
      if (filter === 'submitted') return !!s.submitted_at;
      if (filter === 'flagged') return (s.flag_count ?? 0) > 0;
      return true;
    });
  }, [studentList, filter]);

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
                    {filter === 'all' ? 'No students yet' : `No ${filter} students`}
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
                    {LANG_LABEL[focusedStudent.language] ?? focusedStudent.language}
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
                  onClick={() => navigate(`/lecturer/session/${id}/replay/${focusedStudent.id}`)}
                >
                  ▶ Replay session
                </button>
              </div>
              <Editor
                height="calc(100% - 56px)"
                language={focusedStudent.language}
                value={
                  focusedStudent.language === 'java'
                    ? formatJavaWorkspaceForDisplay(focusedStudent.code)
                    : focusedStudent.code || '// Student has not written anything yet'
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
                      {(s.language === 'java' ? formatJavaWorkspaceForDisplay(s.code) : s.code) ||
                        '// no code yet'}
                    </pre>
                  </div>
                  <div className={styles.gridFooter}>
                    <span className={styles.gridLang}>{LANG_LABEL[s.language] ?? s.language}</span>
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
