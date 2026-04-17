import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import styles from './AuthPage.module.css';

export default function AuthPage() {
  const navigate = useNavigate();
  const { setAuth, user } = useAuthStore();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [role, setRole] = useState<'student' | 'lecturer'>('student');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (user) {
      navigate(user.role === 'lecturer' ? '/lecturer' : '/student', { replace: true });
    }
  }, [user, navigate]);

  if (user) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = mode === 'login'
        ? await api.login({ email: form.email, password: form.password })
        : await api.register({ ...form, role });
      setAuth(res.user, res.token);
      navigate(res.user.role === 'lecturer' ? '/lecturer' : '/student', { replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>⬡</span>
          <span className={styles.logoText}>Oreos</span>
        </div>
        <p className={styles.tagline}>Proctored coding environment for education</p>

        <div className={styles.tabs}>
          <button className={`${styles.tab} ${mode === 'login' ? styles.active : ''}`} onClick={() => setMode('login')}>Sign in</button>
          <button className={`${styles.tab} ${mode === 'register' ? styles.active : ''}`} onClick={() => setMode('register')}>Register</button>
        </div>

        <form onSubmit={handleSubmit} className={styles.form}>
          {mode === 'register' && (
            <>
              <div className={styles.field}>
                <label>Full name</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required placeholder="Jane Doe" />
              </div>
              <div className={styles.roleToggle}>
                <button type="button" className={`${styles.roleBtn} ${role === 'student' ? styles.roleActive : ''}`} onClick={() => setRole('student')}>
                  Student
                </button>
                <button type="button" className={`${styles.roleBtn} ${role === 'lecturer' ? styles.roleActive : ''}`} onClick={() => setRole('lecturer')}>
                  Lecturer
                </button>
              </div>
            </>
          )}

          <div className={styles.field}>
            <label>Email</label>
            <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required placeholder="you@university.edu" />
          </div>
          <div className={styles.field}>
            <label>Password</label>
            <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required placeholder="••••••••" />
          </div>

          {error && <p className={styles.error}>{error}</p>}

          <button type="submit" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={loading}>
            {loading ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}
