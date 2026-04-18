import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import { api, Flag, Participant, Session } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import styles from './LecturerSession.module.css';

interface LiveStudent extends Participant {
  online: boolean;
  code: string;
  language: string;
}

export default function LecturerSession() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [students, setStudents] = useState<Map<string, LiveStudent>>(new Map());
  const [flags, setFlags] = useState<Flag[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const [tab, setTab] = useState<'students' | 'flags'>('students');
  const socketRef = useRef(getSocket());

  useEffect(() => {
    if (!id) return;
    api.getSession(id).then(setSession).catch(() => navigate('/lecturer'));
    api.getParticipants(id).then(list => {
      setStudents(new Map(list.map(p => [p.id, { ...p, online: false, code: p.latest_code ?? '', language: p.language ?? 'javascript' }])));
    });
    api.getFlags(id).then(setFlags);
  }, [id]);

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
        m.set(data.studentId, { ...existing, id: data.studentId, name: data.name, email: data.email, online: true, code: existing?.code ?? '', language: existing?.language ?? 'javascript', joined_at: Date.now(), flag_count: existing?.flag_count ?? 0 });
        return m;
      });
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

    return () => {
      socket.off('session:participants');
      socket.off('student:joined');
      socket.off('student:left');
      socket.off('student:code_update');
      socket.off('student:flagged');
      socket.off('session:status_changed');
    };
  }, [id]);

  const setStatus = (status: 'active' | 'ended' | 'waiting') => {
    socketRef.current.emit('lecturer:set_status', { sessionId: id, status });
  };

  const updateLanguage = (lang: string) => {
    const updated = { ...session!.constraints, language: lang };
    socketRef.current.emit('lecturer:update_constraints', { sessionId: id, constraints: updated });
    setSession(prev => prev ? { ...prev, constraints: updated } : prev);
  };

  const focusedStudent = focused ? students.get(focused) : null;
  const studentList = Array.from(students.values());

  if (!session) return <div className={styles.loading}>Loading…</div>;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button className="btn btn-ghost" onClick={() => navigate('/lecturer')} style={{ padding: '6px 10px' }}>← Back</button>
        <div className={styles.headerCenter}>
          <h1 className={styles.sessionName}>{session.name}</h1>
          <span className={`badge ${session.status === 'active' ? 'badge-green' : session.status === 'ended' ? 'badge-gray' : 'badge-yellow'}`}>{session.status}</span>
          <span className={styles.code}>Join: <strong>{session.join_code}</strong></span>
        </div>
        <div className={styles.headerActions}>
          {session.status !== 'ended' && (
            <select
              value={session.constraints.language ?? 'javascript'}
              onChange={e => updateLanguage(e.target.value)}
              className={styles.langSelect}
            >
              <option value="javascript">JavaScript</option>
              <option value="python">Python</option>
              <option value="typescript">TypeScript</option>
              <option value="java">Java</option>
              <option value="cpp">C++</option>
              <option value="c">C</option>
            </select>
          )}
          {session.status === 'waiting' && <button className="btn btn-success" onClick={() => setStatus('active')}>▶ Start</button>}
          {session.status === 'active' && <button className="btn btn-danger" onClick={() => setStatus('ended')}>■ End session</button>}
        </div>
      </header>

      <div className={styles.body}>
        <aside className={styles.sidebar}>
          <div className={styles.sideTabs}>
            <button className={`${styles.sideTab} ${tab === 'students' ? styles.sideTabActive : ''}`} onClick={() => setTab('students')}>
              Students <span className={styles.count}>{studentList.length}</span>
            </button>
            <button className={`${styles.sideTab} ${tab === 'flags' ? styles.sideTabActive : ''}`} onClick={() => setTab('flags')}>
              Flags {flags.length > 0 && <span className={`${styles.count} ${styles.flagCount}`}>{flags.length}</span>}
            </button>
          </div>

          {tab === 'students' && (
            <div className={styles.studentList}>
              {studentList.length === 0 && <p className={styles.empty}>No students yet</p>}
              {studentList.map(s => (
                <div
                  key={s.id}
                  className={`${styles.studentItem} ${focused === s.id ? styles.studentFocused : ''}`}
                  onClick={() => setFocused(prev => prev === s.id ? null : s.id)}
                >
                  <div className={styles.studentTop}>
                    <span className={`${styles.dot} ${s.online ? styles.dotGreen : styles.dotGray}`} />
                    <span className={styles.studentName}>{s.name}</span>
                    {s.flag_count > 0 && <span className={`badge badge-red`} style={{ marginLeft: 'auto' }}>{s.flag_count}</span>}
                  </div>
                  <span className={styles.studentEmail}>{s.email}</span>
                  <div className={styles.studentActions}>
                    <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: '11px' }} onClick={e => { e.stopPropagation(); navigate(`/lecturer/session/${id}/replay/${s.id}`); }}>
                      ▶ Replay
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'flags' && (
            <div className={styles.flagList}>
              {flags.length === 0 && <p className={styles.empty}>No flags yet</p>}
              {flags.map(f => (
                <div key={f.id} className={styles.flagItem}>
                  <div className={styles.flagTop}>
                    <span className={`badge ${f.type === 'paste' ? 'badge-yellow' : 'badge-red'}`}>{f.type}</span>
                    <span className={styles.flagTime}>{new Date(f.ts).toLocaleTimeString()}</span>
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
                <span className={styles.liveTitle}>Live — {focusedStudent.name}</span>
                <span className={styles.liveLang}>{focusedStudent.language}</span>
                {focusedStudent.flag_count > 0 && <span className="badge badge-red">{focusedStudent.flag_count} flags</span>}
                <button className="btn btn-ghost" style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: '12px' }} onClick={() => navigate(`/lecturer/session/${id}/replay/${focusedStudent.id}`)}>▶ Replay session</button>
              </div>
              <Editor
                height="calc(100% - 48px)"
                language={focusedStudent.language}
                value={focusedStudent.code || '// Student has not written anything yet'}
                theme="vs-dark"
                options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13, lineNumbers: 'on', scrollBeyondLastLine: false }}
              />
            </div>
          ) : (
            <div className={styles.grid}>
              {studentList.length === 0 && (
                <div className={styles.waitingState}>
                  <p className={styles.waitingText}>Waiting for students to join…</p>
                  <p className={styles.waitingCode}>Share the code <strong>{session.join_code}</strong></p>
                </div>
              )}
              {studentList.map(s => (
                <div key={s.id} className={styles.gridCard} onClick={() => setFocused(s.id)}>
                  <div className={styles.gridHeader}>
                    <span className={`${styles.dot} ${s.online ? styles.dotGreen : styles.dotGray}`} />
                    <span className={styles.gridName}>{s.name}</span>
                    {s.flag_count > 0 && <span className="badge badge-red" style={{ marginLeft: 'auto' }}>{s.flag_count}</span>}
                  </div>
                  <div className={styles.miniCode}>
                    <pre>{(s.code || '').slice(0, 300)}</pre>
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
