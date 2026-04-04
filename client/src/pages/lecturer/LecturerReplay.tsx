import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import { api, ReplayData, Snapshot } from '@/lib/api';
import styles from './LecturerReplay.module.css';

export default function LecturerReplay() {
  const { id, studentId } = useParams<{ id: string; studentId: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<ReplayData | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cursor, setCursor] = useState(0); // index into snapshots
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!id || !studentId) return;
    api.getReplay(id, studentId).then(setData).catch(() => navigate(`/lecturer/session/${id}`));
  }, [id, studentId]);

  const snapshots: Snapshot[] = data?.snapshots ?? [];
  const current = snapshots[cursor];
  const totalMs = snapshots.length > 1 ? snapshots[snapshots.length - 1].ts - snapshots[0].ts : 0;
  const currentMs = current && snapshots[0] ? current.ts - snapshots[0].ts : 0;

  useEffect(() => {
    if (playing) {
      intervalRef.current = setInterval(() => {
        setCursor(prev => {
          if (prev >= snapshots.length - 1) { setPlaying(false); return prev; }
          return prev + 1;
        });
      }, 800);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [playing, snapshots.length]);

  function formatMs(ms: number) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  const flagsAtCurrent = data?.flags.filter(f => current && f.ts <= current.ts) ?? [];

  if (!data) return <div className={styles.loading}>Loading replay…</div>;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button className="btn btn-ghost" onClick={() => navigate(`/lecturer/session/${id}`)} style={{ padding: '6px 10px' }}>← Back</button>
        <h1 className={styles.title}>Session Replay</h1>
        {data.flags.length > 0 && <span className="badge badge-red" style={{ marginLeft: 8 }}>{data.flags.length} flags</span>}
      </header>

      <div className={styles.body}>
        <div className={styles.editorArea}>
          <Editor
            height="100%"
            language={current?.language ?? 'javascript'}
            value={current?.content ?? '// No code yet'}
            theme="vs-dark"
            options={{ readOnly: true, minimap: { enabled: true }, fontSize: 13, scrollBeyondLastLine: false }}
          />
        </div>

        <aside className={styles.panel}>
          <div className={styles.controls}>
            <div className={styles.timeline}>
              <input
                type="range"
                min={0}
                max={Math.max(0, snapshots.length - 1)}
                value={cursor}
                onChange={e => { setPlaying(false); setCursor(Number(e.target.value)); }}
                className={styles.scrubber}
              />
              <div className={styles.timeLabels}>
                <span>{formatMs(currentMs)}</span>
                <span>{formatMs(totalMs)}</span>
              </div>
            </div>
            <div className={styles.playControls}>
              <button className="btn btn-ghost" onClick={() => { setPlaying(false); setCursor(0); }} disabled={cursor === 0}>⏮</button>
              <button
                className={`btn ${playing ? 'btn-danger' : 'btn-success'}`}
                onClick={() => { if (cursor >= snapshots.length - 1) setCursor(0); setPlaying(p => !p); }}
                disabled={snapshots.length === 0}
              >
                {playing ? '⏸ Pause' : '▶ Play'}
              </button>
              <button className="btn btn-ghost" onClick={() => { setPlaying(false); setCursor(snapshots.length - 1); }} disabled={cursor === snapshots.length - 1}>⏭</button>
            </div>
            <div className={styles.stats}>
              <div className={styles.stat}><span>Snapshots</span><strong>{snapshots.length}</strong></div>
              <div className={styles.stat}><span>Events</span><strong>{data.events.length}</strong></div>
              <div className={styles.stat}><span>Flags</span><strong style={{ color: data.flags.length > 0 ? 'var(--red)' : 'var(--green)' }}>{data.flags.length}</strong></div>
            </div>
          </div>

          <div className={styles.flagSection}>
            <h3 className={styles.sectionTitle}>Flags at this point ({flagsAtCurrent.length})</h3>
            <div className={styles.flagList}>
              {flagsAtCurrent.length === 0 && <p className={styles.empty}>None</p>}
              {flagsAtCurrent.map(f => (
                <div key={f.id} className={`${styles.flagItem} ${current && f.ts === current.ts ? styles.flagNow : ''}`}>
                  <div className={styles.flagTop}>
                    <span className={`badge ${f.type === 'paste' ? 'badge-yellow' : 'badge-red'}`}>{f.type}</span>
                    <span className={styles.flagTime}>{formatMs(f.ts - (snapshots[0]?.ts ?? 0))}</span>
                  </div>
                  {f.detail && <span className={styles.flagDetail}>{f.detail}</span>}
                </div>
              ))}
            </div>
          </div>

          <div className={styles.eventSection}>
            <h3 className={styles.sectionTitle}>Event log</h3>
            <div className={styles.eventList}>
              {data.events.slice(0, 200).map(e => (
                <div key={e.id} className={styles.eventRow}>
                  <span className={styles.eventType}>{e.type}</span>
                  <span className={styles.eventTime}>{formatMs(e.ts - (snapshots[0]?.ts ?? 0))}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
