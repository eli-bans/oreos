import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import styles from './StudentLobby.module.css';

export default function StudentLobby() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setError('');
    setLoading(true);
    try {
      const session = await api.getSessionByCode(code.trim().toUpperCase());
      if (session.status === 'ended') {
        setError('This session has already ended.');
        return;
      }
      navigate(`/student/ide/${session.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Session not found');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.logo}>⬡ Oreos</span>
        <div className={styles.headerRight}>
          <span className={styles.name}>{user?.name}</span>
          <button className="btn btn-ghost" onClick={() => { logout(); navigate('/auth'); }}>Sign out</button>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.card}>
          <h1 className={styles.title}>Join a session</h1>
          <p className={styles.sub}>Enter the 6-character code your lecturer gave you.</p>
          <form onSubmit={join} className={styles.form}>
            <input
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase().slice(0, 6))}
              placeholder="ABC123"
              maxLength={6}
              className={styles.codeInput}
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
            {error && <p className={styles.error}>{error}</p>}
            <button type="submit" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={loading || code.length < 6}>
              {loading ? 'Joining…' : 'Join session'}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
