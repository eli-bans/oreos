import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, Session } from '@/lib/api';
import { questionsFromText } from '@/lib/questions';
import { useAuthStore } from '@/store/auth';
import styles from './LecturerHome.module.css';

export default function LecturerHome() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [constraints, setConstraints] = useState({ language: 'javascript' });
  const [questionsText, setQuestionsText] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.listSessions().then(setSessions).catch(() => {});
  }, []);

  const createSession = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      const s = await api.createSession({
        name: newName.trim(),
        constraints,
        questions: questionsFromText(questionsText),
      });
      setSessions(prev => [s, ...prev]);
      setNewName('');
      setQuestionsText('');
      setCreating(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
    }
  };

  const statusColor = (s: Session) =>
    s.status === 'active' ? 'badge-green' : s.status === 'ended' ? 'badge-gray' : 'badge-yellow';

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.logo}>⬡ Oreos</span>
          <span className={styles.role}>Lecturer</span>
        </div>
        <div className={styles.headerRight}>
          <span className={styles.userName}>{user?.name}</span>
          <button className="btn btn-ghost" onClick={() => { logout(); navigate('/auth'); }}>Sign out</button>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.topBar}>
          <h1 className={styles.title}>Sessions</h1>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>+ New session</button>
        </div>

        {creating && (
          <div className={styles.createCard}>
            <h2 className={styles.createTitle}>New session</h2>
            <form onSubmit={createSession}>
              <div className={styles.field}>
                <label>Session name</label>
                <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Midterm Exam — CS101" autoFocus />
              </div>
              <div className={styles.field}>
                <label>Questions</label>
                <textarea
                  value={questionsText}
                  onChange={e => setQuestionsText(e.target.value)}
                  placeholder={'Write one or more questions.\n\nSeparate questions with a blank line.\n\nExample:\nWrite a function that returns the sum of two integers.\n\nGiven an array, return the maximum element.'}
                  rows={8}
                  className={styles.questionsInput}
                />
                <span className={styles.fieldHint}>Students see these in the IDE when they join.</span>
              </div>
              <div className={styles.field}>
                <label>Language</label>
                <select value={constraints.language} onChange={e => setConstraints(c => ({ ...c, language: e.target.value }))}>
                  <option value="javascript">JavaScript</option>
                  <option value="python">Python</option>
                  <option value="typescript">TypeScript</option>
                  <option value="java">Java</option>
                  <option value="cpp">C++</option>
                  <option value="c">C</option>
                </select>
              </div>
              {error && <p className={styles.error}>{error}</p>}
              <div className={styles.formActions}>
                <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Create</button>
              </div>
            </form>
          </div>
        )}

        {sessions.length === 0 && !creating ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}>📋</span>
            <p>No sessions yet. Create one to get started.</p>
          </div>
        ) : (
          <div className={styles.sessionGrid}>
            {sessions.map(s => (
              <div key={s.id} className={styles.sessionCard} onClick={() => navigate(`/lecturer/session/${s.id}`)}>
                <div className={styles.sessionTop}>
                  <h3 className={styles.sessionName}>{s.name}</h3>
                  <span className={`badge ${statusColor(s)}`}>{s.status}</span>
                </div>
                <div className={styles.sessionMeta}>
                  <span className={styles.joinCode}>Code: <strong>{s.join_code}</strong></span>
                  <span className={styles.sessionLang}>
                    {(s.questions?.length ?? 0) > 0 ? `${s.questions.length} question(s)` : 'No questions'} · {s.constraints.language ?? 'any'}
                  </span>
                </div>
                <div className={styles.sessionDate}>
                  {new Date(s.created_at * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
